'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isolated, Client, PROJECT, configAt, TEST_ROOT } = require('../helpers/runtime');
const { startServer } = require('../../backend/server');
const { backup } = require('node:sqlite');
const { removeTree } = require('../../backend/files/safety');
const fixture = name => fs.readFile(path.join(PROJECT, 'tests/fixtures', name));
async function ready(runtime, client, name = 'sample-chinese.png') {
  const upload = await client.upload(await fixture(name), name, name.endsWith('.png') ? 'image/png' : 'application/pdf');
  assert.equal(upload.status, 202); await runtime.files.waitForIdle();
  const file = (await client.request('GET', `/api/files/${upload.body.data.id}`)).body.data; assert.equal(file.status, 'ready'); return file;
}
async function readable(files, actor, artifactId, purpose = 'production') {
  const opened = await files.openArtifactForRead({ actor, artifactId, purpose }); await opened.handle.close();
}
async function listFiles(root) {
  let names; try { names = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of names) { const target = path.join(root, entry.name); if (entry.isDirectory()) result.push(...await listFiles(target)); else result.push(target); }
  return result;
}
test('订单认领原子性、不可重算的期限、七天边界、物理删除和保留业务摘要', async t => {
  let clock = Date.parse('2026-10-14T00:00:00.000Z'), failDeleteOnce = true;
  const runtime = await isolated({ clock: () => new Date(clock), studentAccountsEnabled: true, sessionMs: 30 * 86400000,
    fileServiceOptions: { deleteTree: async (root, relative) => { if (failDeleteOnce && root.endsWith('student-files')) { failDeleteOnce = false; throw Object.assign(new Error('simulated Windows sharing violation'), { code: 'EACCES' }); } return removeTree(root, relative); } } });
  t.after(() => runtime.destroy()); const student = new Client(runtime), admin = new Client(runtime); await student.register(); await admin.admin();
  const file = await ready(runtime, student), uncompleted = await ready(runtime, student);
  const original = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: 'seven-days-print' });
  await runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: 'discarded-quote' });
  const sourcePreview = await student.request('GET', `/api/files/${file.id}/preview`, undefined, { raw: true }); assert.equal(sourcePreview.status, 200);
  const item = { fileId: file.id, printArtifactId: original.artifactId };
  await t.test('认领与建单一起提交；失败完全回滚；第二笔订单不能复用', async () => {
    assert.throws(() => runtime.files.claimForOrder({ orderId: 'outside-tx', userId: student.user.id, items: [item] }), /db.tx/);
    assert.throws(() => runtime.db.tx(() => { runtime.files.claimForOrder({ orderId: 'rolled-back', userId: student.user.id, items: [item] }); throw new Error('order failure'); }), /order failure/);
    assert.equal(runtime.db.get('SELECT claimedOrderId FROM files WHERE id=?', file.id).claimedOrderId, null);
    runtime.db.raw.exec('CREATE TABLE software_order_evidence(id TEXT PRIMARY KEY,completedAt TEXT,amountFen INTEGER,refundFen INTEGER) STRICT');
    runtime.db.tx(() => {
      runtime.db.run('INSERT INTO software_order_evidence VALUES(?,NULL,100,0)', 'test-order');
      runtime.files.claimForOrder({ orderId: 'test-order', userId: student.user.id, items: [item] });
    });
    assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE id=?', file.id).expiresAt, null);
    runtime.db.run('UPDATE files SET claimedOrderId=NULL,expiresAt=temporaryExpiresAt WHERE id=?', file.id);
    runtime.files.ledger.replay(runtime.files.now());
    assert.equal(runtime.db.get('SELECT claimedOrderId FROM files WHERE id=?', file.id).claimedOrderId, 'test-order');
    assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE id=?', file.id).expiresAt, null);
  });
  // Remaining steps are outside the subtest so failure gives a clean diagnostic.
  const liveArtifact = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: uncompleted.id, pageNumbers: [1], preparationId: 'uncompleted' });
  runtime.db.tx(() => runtime.files.claimForOrder({ orderId: 'in-progress-order', userId: student.user.id, items: [{ fileId: uncompleted.id, printArtifactId: liveArtifact.artifactId }] }));
  assert.throws(() => runtime.db.tx(() => runtime.files.claimForOrder({ orderId: 'second-order', userId: student.user.id, items: [item] })), error => error.code === 'FILE_ALREADY_CLAIMED');
  assert.equal((await student.request('DELETE', `/api/files/${file.id}`, {})).status, 409);
  const completedAt = new Date(clock).toISOString(), expiry = new Date(clock + 7 * 86400000).toISOString();
  assert.throws(() => runtime.db.tx(() => { runtime.files.setOrderFileExpiry({ orderId: 'test-order', expiresAt: expiry }); throw new Error('delivery rollback'); }), /rollback/);
  assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE id=?', file.id).expiresAt, null); assert.equal(runtime.files.ledger.facts.get(file.id).expiresAt, null);
  runtime.db.tx(() => { runtime.db.run('UPDATE software_order_evidence SET completedAt=? WHERE id=?', completedAt, 'test-order'); runtime.files.setOrderFileExpiry({ orderId: 'test-order', expiresAt: expiry }); });
  assert.throws(() => runtime.db.tx(() => runtime.files.setOrderFileExpiry({ orderId: 'test-order', expiresAt: new Date(clock + 8 * 86400000).toISOString() })), error => error.code === 'FILE_EXPIRY_IMMUTABLE');
  for (const artifact of runtime.db.all('SELECT expiresAt FROM artifacts WHERE fileId=?', file.id)) assert.equal(artifact.expiresAt, expiry);
  const physicalBefore = await listFiles(path.join(runtime.config.fileRoot, file.id)); assert(physicalBefore.length >= 7);
  clock += 7 * 86400000 - 1;
  await readable(runtime.files, student.user, original.artifactId); await readable(runtime.files, admin.user, original.artifactId, 'preview');
  assert.equal((await runtime.files.purgeExpiredFiles()).examined, 0);
  clock++;
  await assert.rejects(readable(runtime.files, student.user, original.artifactId), error => error.status === 410);
  await assert.rejects(readable(runtime.files, admin.user, original.artifactId, 'preview'), error => error.status === 410);
  assert.equal((await student.request('GET', `/api/files/${file.id}/preview`)).status, 410);
  const first = await runtime.files.purgeExpiredFiles(); assert.equal(first.failed, 1); assert((await listFiles(path.join(runtime.config.fileRoot, file.id))).length > 0);
  assert.equal(runtime.files.cleanupStatus().failures[0].code, 'FILE_DELETE_FAILED');
  const second = await runtime.files.purgeExpiredFiles(); assert.equal(second.purged, 1); assert.deepEqual(await listFiles(path.join(runtime.config.fileRoot, file.id)), []);
  assert.deepEqual(await fs.readdir(runtime.config.tempRoot), []); assert.equal((await runtime.files.purgeExpiredFiles()).purged, 0);
  const summary = (await student.request('GET', `/api/files/${file.id}`)).body.data; assert.equal(summary.status, 'expired'); assert.equal(summary.fileAvailability, 'deleted');
  const order = runtime.db.get('SELECT * FROM software_order_evidence WHERE id=?', 'test-order'); assert.equal(order.completedAt, completedAt); assert.equal(order.amountFen, 100); assert.equal(order.refundFen, 0);
  await readable(runtime.files, student.user, liveArtifact.artifactId); assert.equal(runtime.db.get('SELECT purgedAt FROM files WHERE id=?', uncompleted.id).purgedAt, null);
  const output = process.env.CP_VERIFICATION_DIR || path.join(PROJECT, 'docs/verification/A'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'retention-evidence.json'), JSON.stringify({ kind: 'isolated-A-file-service-software-test', completedAt, expiry,
    beforeBoundary: 'readable at expiry minus 1ms', exactBoundary: 'student/admin refused with 410',
    physicalObjectCountBefore: physicalBefore.length, physicalObjectCountAfter: 0, firstDeletionFailure: first, retry: second,
    orderSummaryRetained: order, uncompletedFilesRetained: true, cleanupStatus: runtime.files.cleanupStatus() }, null, 2));
});
test('24 小时临时规则与有效处理租约；收款资产独立', async t => {
  let clock = Date.parse('2026-10-14T00:00:00.000Z'); const runtime = await isolated({ clock: () => new Date(clock), studentAccountsEnabled: true, sessionMs: 30 * 86400000 });
  t.after(() => runtime.destroy()); const student = new Client(runtime); await student.register(); const file = await ready(runtime, student);
  const paymentId = randomUUID(); await fs.writeFile(path.join(runtime.config.paymentRoot, `${paymentId}.png`), await fixture('sample-chinese.png'));
  clock += 24 * 3600000;
  runtime.db.run('INSERT INTO file_leases VALUES(?,?,?,?)', 'test-lease', file.id, 'valid-processing-test', new Date(clock + 60000).toISOString());
  const held = await runtime.files.purgeExpiredFiles(); assert.equal(held.deferred, 1); assert.equal(runtime.db.get('SELECT status FROM files WHERE id=?', file.id).status, 'ready');
  runtime.db.run('DELETE FROM file_leases WHERE leaseId=?', 'test-lease');
  const expired = await runtime.files.purgeExpiredFiles(); assert.equal(expired.purged, 1);
  assert((await fs.stat(path.join(runtime.config.paymentRoot, `${paymentId}.png`))).size > 0);
});
test('重启恢复中断任务；旧数据库/文件快照不能覆盖清理台账', async t => {
  let clock = Date.parse('2026-10-14T00:00:00.000Z'); const options = { clock: () => new Date(clock), studentAccountsEnabled: true, sessionMs: 30 * 86400000 };
  let runtime = await isolated(options); const root = runtime.root, name = runtime.name;
  t.after(async () => { await runtime.close(); await removeTree(TEST_ROOT, name); });
  const student = new Client(runtime); await student.register(); const file = await ready(runtime, student, 'sample-chinese.pdf');
  const artifact = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: 'restart-preview' });
  runtime.db.tx(() => runtime.files.claimForOrder({ orderId: 'restart-order', userId: student.user.id, items: [{ fileId: file.id, printArtifactId: artifact.artifactId }] }));
  const snapshot = path.join(root, 'synthetic-backup'), snapshotDatabase = path.join(root, 'pre-completion.sqlite');
  await fs.cp(path.join(runtime.config.fileRoot, file.id), snapshot, { recursive: true }); await backup(runtime.db.raw, snapshotDatabase);
  runtime.db.tx(() => runtime.files.setOrderFileExpiry({ orderId: 'restart-order', expiresAt: new Date(clock + 7 * 86400000).toISOString() }));
  clock += 7 * 86400000; await runtime.files.purgeExpiredFiles();
  await runtime.close();
  await fs.cp(snapshot, path.join(configAt(root).fileRoot, file.id), { recursive: true });
  await fs.copyFile(snapshotDatabase, configAt(root).dbPath);
  runtime = await startServer(configAt(root, options));
  const restored = runtime.files.getFile({ actor: student.user, fileId: file.id }); assert.equal(restored.fileAvailability, 'deleted');
  assert.deepEqual(await listFiles(path.join(runtime.config.fileRoot, file.id)), []);
  await assert.rejects(readable(runtime.files, student.user, artifact.artifactId), error => error.status === 410);
  const reconnected = new Client(runtime); await reconnected.register(); const pending = await ready(runtime, reconnected, 'sample-chinese.pdf');
  const job = runtime.db.get('SELECT * FROM file_jobs WHERE fileId=?', pending.id);
  runtime.db.run("UPDATE file_jobs SET status='running',attempts=0 WHERE id=?", job.id); runtime.db.run("UPDATE files SET status='processing' WHERE id=?", pending.id);
  const interruptedDir = path.join(runtime.config.tempRoot, `job-${job.id}`); await fs.mkdir(interruptedDir); await fs.writeFile(path.join(interruptedDir, 'partial.bin'), 'synthetic interrupted output');
  await runtime.close(); runtime = await startServer(configAt(root, options)); await runtime.files.waitForIdle();
  assert.equal(runtime.db.get('SELECT status FROM files WHERE id=?', pending.id).status, 'ready'); assert.deepEqual(await fs.readdir(runtime.config.tempRoot), []);
  const latestManifest = { schemaVersion: 1, product: 'campus-print-v1', generatedAt: new Date(clock).toISOString(), files: [] };
  await runtime.files.reconcileRestoredFiles({ latestManifest }); assert.equal(runtime.db.get('SELECT status FROM files WHERE id=?', pending.id).status, 'expired');
});
test('路径穿越、符号链接与内容完整性检查', async t => {
  const runtime = await isolated({ studentAccountsEnabled: true }); t.after(() => runtime.destroy()); const student = new Client(runtime); await student.register();
  const file = await ready(runtime, student), artifact = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: 'integrity' });
  const row = runtime.db.get('SELECT * FROM artifacts WHERE artifactId=?', artifact.artifactId); await fs.appendFile(path.join(runtime.config.fileRoot, row.relativePath), 'tampered');
  await assert.rejects(readable(runtime.files, student.user, artifact.artifactId), error => error.code === 'FILE_INTEGRITY_FAILED');
  await fs.appendFile(path.join(runtime.config.fileRoot, file.id, 'original.bin'), 'tampered original');
  // Images use the immutable normalized artifact as the decoder input; tampering with it must also be refused.
  const normalized = runtime.db.get("SELECT relativePath FROM artifacts WHERE fileId=? AND kind='normalized'", file.id);
  await fs.appendFile(path.join(runtime.config.fileRoot, normalized.relativePath), 'tampered normalized');
  await assert.rejects(runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: 'tampered-input' }), error => error.code === 'FILE_INTEGRITY_FAILED');
  const outside = path.join(runtime.root, 'outside-controlled-test'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel.txt'), 'must remain');
  const junction = path.join(runtime.config.fileRoot, file.id, 'injected-link'); await fs.symlink(outside, junction, 'junction');
  const deleted = await student.request('DELETE', `/api/files/${file.id}`, {}); assert.equal(deleted.status, 200); assert.equal(deleted.body.data.deleted, false);
  assert.equal(runtime.files.cleanupStatus().failures[0].code, 'UNSAFE_STORAGE_PATH'); assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'must remain');
  await fs.unlink(junction); assert.equal((await runtime.files.purgeExpiredFiles()).purged, 1);
});
