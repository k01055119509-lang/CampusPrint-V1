'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startServer } = require('../../backend/server');
const { removeTree, safePath } = require('../../backend/files/safety');
const { isolated, Client, configAt, TEST_ROOT, TEST_PASSWORD, PROJECT } = require('../helpers/runtime');
const h = require('../business/helpers');
const { createSnapshot, exportAuthority, restoreSnapshot } = require('../../scripts/deploy/backup');
const { deadline, copyTree } = require('../../backend/files/backups');
async function filesAt(root) {
  let names; try { names = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names) { const full = path.join(root, name.name); if (name.isDirectory()) result.push(...await filesAt(full)); else result.push(path.relative(root, full)); }
  return result;
}
async function login(runtime, username, role) { const client = new Client(runtime,{surface:role==='admin'?'admin':'student'}); await client.csrfToken(); h.data(await client.request('POST', '/api/auth/'+(role === 'admin' ? 'admin-login' : 'login'), { username, password: TEST_PASSWORD })); return client; }
test('D 独立七天边界、物理删除、备份失败重试、停机及安全恢复', { timeout: 120000 }, async t => {
  let instant = new Date('2026-10-14T06:00:00.000Z'), failSource = false, failBackup = false;
  const runtime = await isolated({ studentAccountsEnabled:true,clock: () => new Date(instant), sessionMs: 30 * 86400000,
    fileServiceOptions: { deleteTree: async (root, relative) => {
      if ((failSource && root.endsWith('student-files')) || (failBackup && root.endsWith('managed-backups'))) {
        if (root.endsWith('student-files')) failSource = false; else failBackup = false;
        throw Object.assign(new Error('D isolated sharing violation'), { code: 'EACCES' });
      }
      return removeTree(root, relative);
    } } });
  let restarted; const restoreNames = [];
  t.after(async () => { await restarted?.close(); await runtime.destroy(); for (const name of restoreNames) await removeTree(TEST_ROOT, name); });
  const { user, other, admin } = await h.actors(runtime);
  const source = await h.upload(runtime, user, 'source-100-pages.pdf');
  const q = await h.quote(runtime, user, source, { pages: '1-2,100', copies: 3, duplex: true });
  let value = h.data(await h.post(user, '/api/orders', h.orderBody(q)), 201);
  const unfinished = await h.order(runtime, user), unrelated = await h.order(runtime, other);
  await user.request('GET', `/api/files/${source.id}/preview?page=2`, undefined, { raw: true });
  const older = await createSnapshot(runtime); // Snapshot says active and expiresAt=null.
  const detached = path.join(runtime.root, 'isolated-offline-old-copy'); await copyTree(older.directory, detached);
  h.data(await h.paymentQr(admin)); value = await h.confirm(admin, value); value = await h.delivered(admin, value);
  const completedAt = value.completedAt, expiresAt = value.filesExpireAt;
  value = await h.action(admin, value, 'refunds', { action: 'request', amountFen: 50, reason: 'D 软件部分退款' });
  const refundId = value.refunds[0].id;
  value = await h.action(admin, value, 'refunds', { action: 'approve', refundId, note: 'D 软件批准', fulfillmentDecision: 'resume' });
  value = await h.action(admin, value, 'refunds', { action: 'paid_out', refundId, note: 'D 软件实退记录，无真实资金', fulfillmentDecision: 'resume', payoutReference: 'D-'+randomUUID(), actualRefundConfirmed: true });
  const ticket = h.data(await h.post(user, `/api/me/orders/${value.id}/tickets`, { subject: 'D 文字售后', message: '七天后仍保留文字' }), 201);
  const snapshot = await createSnapshot(runtime), authority = path.join(runtime.root, 'latest-authority'); await exportAuthority(runtime, authority);
  const badSnapshot = path.join(runtime.root, 'isolated-interrupted-restore'); await copyTree(snapshot.directory, badSnapshot);
  const badMetadata = JSON.parse(await fs.readFile(path.join(badSnapshot, 'snapshot.json'), 'utf8'));
  await fs.appendFile(path.join(badSnapshot, 'documents', badMetadata.documents[0].fileId, 'original.bin'), 'isolated-damage');
  const partialName = randomUUID(); restoreNames.push(partialName); const partialConfig = configAt(path.join(TEST_ROOT, partialName), { studentAccountsEnabled:true,clock: () => new Date(instant) });
  await assert.rejects(restoreSnapshot({ snapshotRoot: badSnapshot, config: partialConfig, authorityRoot: authority }), /checksum/);
  await assert.rejects(startServer(partialConfig), /Unfinished restore/);
  const sourceRoot = path.join(runtime.config.fileRoot, source.id), before = await filesAt(sourceRoot);
  assert(before.length >= 4); assert.equal(Date.parse(expiresAt)-Date.parse(completedAt), 604800000);
  const routes = [
    [user, `/api/files/${source.id}/preview?page=2`],
    [user, `/api/me/orders/${value.id}/items/${value.items[0].itemId}/preview?page=1`],
    [user, `/api/me/orders/${value.id}/items/${value.items[0].itemId}/file`],
    [admin, `/api/files/${source.id}/preview?page=1`],
    [admin, `/api/admin/orders/${value.id}/items/${value.items[0].itemId}/preview?page=1`],
    [admin, `/api/admin/orders/${value.id}/items/${value.items[0].itemId}/print-file`]
  ];
  instant = new Date(Date.parse(expiresAt)-1000); const boundary = [];
  for (const [client, route] of routes) { const response = await client.request('GET', route, undefined, { raw: true }); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/); }
  boundary.push({ at: instant.toISOString(), offset: '6d23h59m59s', allSixHttpRoutes: 200 });
  const originalId = runtime.db.get("SELECT artifactId FROM artifacts WHERE fileId=? AND kind='original'", source.id).artifactId;
  const handle = await runtime.files.openArtifactForRead({ actor: user.user, artifactId: originalId, purpose: 'original' }); await handle.handle.close();
  const liveName = randomUUID(); restoreNames.push(liveName); const liveConfig = configAt(path.join(TEST_ROOT, liveName), { studentAccountsEnabled:true,clock: () => new Date(instant), sessionMs: 30*86400000 });
  const liveRestore = await restoreSnapshot({ snapshotRoot: snapshot.directory, config: liveConfig, authorityRoot: authority }); assert.equal(liveRestore.restoredFiles, 3);
  let restored = await startServer(liveConfig);
  try { const reader = await login(restored, user.user.username, 'user'); assert.equal((await reader.request('GET', routes[2][1], undefined, { raw: true })).status, 200); assert.equal(h.data(await reader.request('GET', `/api/me/orders/${value.id}`)).payment.receipt.amountFen, 420); }
  finally { await restored.close(); }
  const unknownName = randomUUID(); restoreNames.push(unknownName);
  const unknown = await restoreSnapshot({ snapshotRoot: snapshot.directory, config: configAt(path.join(TEST_ROOT, unknownName), { studentAccountsEnabled:true,clock: () => new Date(instant) }) }); assert.equal(unknown.restoredFiles, 0); assert.equal(unknown.latestAuthorityProvided, false); assert.equal(unknown.orders, 3);
  instant = new Date(expiresAt);
  for (const [client, route] of routes) assert.equal((await client.request('GET', route)).status, 410);
  await assert.rejects(runtime.files.openArtifactForRead({ actor: admin.user, artifactId: originalId, purpose: 'original' }), error => error.status === 410);
  await assert.rejects(runtime.files.sourcePreview({ actor: user.user, fileId: source.id, page: 3 }), error => error.status === 410);
  boundary.push({ at: instant.toISOString(), offset: 'exactly7d', allSixHttpRoutes: 410, originalAndRegeneration: 410 });
  failSource = true; failBackup = true;
  const first = await runtime.files.purgeExpiredFiles(); assert.equal(first.failed, 1); assert.equal(runtime.files.cleanupStatus().backupCleanup.failures.length, 1);
  assert((await filesAt(sourceRoot)).length > 0);
  assert.equal(h.data(await user.request('GET', `/api/me/orders/${value.id}`)).fileAvailability, 'expired');
  const status = h.data(await admin.request('GET', '/api/admin/files/cleanup-status')); assert.equal(status.backupCleanup.failures[0].code, 'BACKUP_DELETE_FAILED');
  await runtime.close(); instant = new Date(Date.parse(expiresAt)+1000);
  restarted = await startServer(configAt(runtime.root, { studentAccountsEnabled:true,clock: () => new Date(instant), sessionMs: 30 * 86400000 }));
  const reader = await login(restarted, user.user.username, 'user'), operator = await login(restarted, admin.user.username, 'admin');
  assert.deepEqual(await filesAt(sourceRoot), []); assert.deepEqual(await filesAt(restarted.config.tempRoot), []);
  for (const snap of [older, snapshot]) assert.deepEqual(await filesAt(path.join(snap.directory, 'documents')), []);
  // Database records and independent payment asset survive document backup pruning.
  assert((await fs.stat(path.join(snapshot.directory, 'database.sqlite'))).size > 0); assert.equal((await reader.request('GET', '/api/public/payment-qr', undefined, { raw: true })).status, 200);
  const persisted = h.data(await reader.request('GET', `/api/me/orders/${value.id}`));
  assert.equal(persisted.fileAvailability, 'deleted'); assert.equal(persisted.completedAt, completedAt); assert.equal(persisted.filesExpireAt, expiresAt);
  assert.equal(persisted.payment.receipt.amountFen, 420); assert.equal(persisted.actualRefundFen, 50); assert.equal(h.data(await reader.request('GET', `/api/me/tickets/${ticket.id}`)).updates[0].message, '七天后仍保留文字');
  for (const order of [unfinished, unrelated]) { const client = order.id === unfinished.id ? reader : await login(restarted, other.user.username, 'user'); assert.equal(h.data(await client.request('GET', `/api/me/orders/${order.id}`)).fileAvailability, 'available'); }
  assert.equal((await restarted.files.purgeExpiredFiles()).purged, 0);
  const latest = path.join(runtime.root, 'post-expiry-authority'); await exportAuthority(restarted, latest);
  const expiredName = randomUUID(); restoreNames.push(expiredName); const expiredConfig = configAt(path.join(TEST_ROOT, expiredName), { studentAccountsEnabled:true,clock: () => new Date(instant), sessionMs: 30*86400000 });
  assert((await filesAt(path.join(detached, 'documents'))).length > 0);
  const expiredRestore = await restoreSnapshot({ snapshotRoot: detached, config: expiredConfig, authorityRoot: latest }); assert.equal(expiredRestore.restoredFiles, 0);
  restored = await startServer(expiredConfig);
  try { const operator = await login(restored, admin.user.username, 'admin'); const old = h.data(await operator.request('GET', `/api/admin/orders/${value.id}`)); assert.equal(old.lifecycle, 'active'); assert.equal(old.fileAvailability, 'deleted'); assert(!old.allowedActions.includes('start_print')); assert.equal((await operator.request('GET', routes[5][1])).status, 410); }
  finally { await restored.close(); }
  const dashboard = h.data(await operator.request('GET', '/api/admin/dashboard')); assert.equal(dashboard.confirmedReceivedFen, 420); assert.equal(dashboard.actualRefundFen, 50); assert.equal(dashboard.netReceivedFen, 370);
  const report = { kind: 'D-independent-retention-and-restore-software-test', boundary, originalAndDerivedPhysicalBefore: before.length, originalAndDerivedPhysicalAfter: 0, temporaryPhysicalAfter: 0,
    backupDocumentsPhysicalAfter: 0, initialSourceDeleteFailures: first.failed, initialBackupDeleteFailures: status.backupCleanup.failures.length, restartRetriedBeforeHttp: true,
    unfinishedAndOtherAccountFilesPreserved: true, interruptedRestoreRefusesStartup: true, repeatedPurge: 0, completedAt, filesExpireAt: expiresAt,
    records: { orders: 3, receiptFen: persisted.payment.receipt.amountFen, actualRefundFen: persisted.actualRefundFen, ticketKept: true, netReceivedFen: dashboard.netReceivedFen },
    restoration: { beforeExpiry: liveRestore, oldUnfinishedSnapshotAfterExpiry: expiredRestore, missingAuthority: unknown },
    databaseAndLogsContainDocumentBodies: false, realPayment: false, realPrinting: false, systemClockChanged: false };
  // Full source bytes and preview bytes must not be present in the database, ledger or JSON metadata.
  const sourceBytes = await h.fixture('source-100-pages.pdf');
  for (const file of [path.join(snapshot.directory, 'database.sqlite'), path.join(snapshot.directory, 'snapshot.json'), path.join(snapshot.directory, 'retention-manifest.json'), path.join(snapshot.directory, 'retention.jsonl')]) assert.equal((await fs.readFile(file)).includes(sourceBytes), false);
  const output=process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/guest-pricing-coupons-v1.1.0/C/local-retention');await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'retention.json'), JSON.stringify(report, null, 2));
});
test('D 备份期限严格取原快照七天与订单期限最早值；不因重新计算续期', () => {
  const createdAt = '2026-10-14T00:00:00.000Z', entry = { capturedAt: createdAt, sourceSha256: 'x', expiresAt: null }, current = { sourceSha256: 'x', authoritativeExpiresAt: null };
  assert.equal(deadline({ createdAt }, entry, current), '2026-10-21T00:00:00.000Z');
  assert.equal(deadline({ createdAt }, entry, { ...current, authoritativeExpiresAt: '2026-10-19T00:00:00.000Z' }), '2026-10-19T00:00:00.000Z');
  assert.equal(deadline({ createdAt }, { ...entry, capturedAt: '2026-10-15T00:00:00.000Z' }, current), null);
  assert.equal(deadline({ createdAt }, entry, null), null);
});
