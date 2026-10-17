'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { backup, DatabaseSync } = require('node:sqlite');
const { createApp } = require('../../backend/app');
const { loadConfig, validateStorageConfig, ROOT, inside } = require('../../backend/config');
const { safePath, ensureRoot, assertNoLinks, UUID } = require('../../backend/files/safety');
const { copyTree, deadline } = require('../../backend/files/backups');
const { validTime } = require('../../backend/files/ledger');
async function hash(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function json(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
async function advertisementInventory(root, { optional = false } = {}) {
  await assertNoLinks(root, { missing: optional });
  let names;
  try { names = await fs.readdir(root); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  const rows = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.png') || !UUID.test(name.slice(0, -4))) throw new Error('Invalid advertisement backup asset');
    const file = await safePath(root, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size < 1) throw new Error('Invalid advertisement backup file');
    rows.push({ name, bytes: stat.size, sha256: await hash(file) });
  }
  return rows;
}
async function verifyAdvertisementAssets(databasePath, directory, expected) {
  const rows = await advertisementInventory(directory, { optional: true });
  if (expected !== undefined && (!Array.isArray(expected) || JSON.stringify(rows) !== JSON.stringify(expected))) throw new Error('Advertisement snapshot checksum mismatch');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let referenced = [];
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='advertisements'").get()) referenced = db.prepare('SELECT assetJson FROM advertisements').all().map(row => JSON.parse(row.assetJson));
  } finally { db.close(); }
  for (const asset of referenced) {
    if (!UUID.test(asset.assetId)) throw new Error('Invalid advertisement snapshot identity');
    const item = rows?.find(row => row.name === asset.assetId + '.png');
    if (!item || item.bytes !== asset.byteSize || item.sha256 !== asset.sha256) throw new Error('Advertisement snapshot reference or checksum mismatch');
  }
  return { files: rows?.length || 0, referenced: referenced.length, legacyWithoutDirectory: rows === null };
}
async function createSnapshot(runtime) {
  if (runtime.db.inTransaction) throw new Error('Backup must be outside transactions');
  await runtime.files.waitForIdle(); await runtime.files.purgeExpiredFiles();
  const manifest = runtime.files.exportRetentionManifest(), snapshotId = randomUUID();
  const directory = await safePath(runtime.config.backupRoot, snapshotId, { missing: true }); await fs.mkdir(directory);
  runtime.files.activeSnapshots.add(snapshotId);
  try {
  const createdAt = runtime.files.now(), documents = [];
  await backup(runtime.db.raw, path.join(directory, 'database.sqlite'));
  await fs.mkdir(path.join(directory, 'documents'));
  for (const row of manifest.files) {
    if (row.status !== 'ready' || row.revoked || row.purgedAt || (row.authoritativeExpiresAt && row.authoritativeExpiresAt <= createdAt)) continue;
    const source = await safePath(runtime.config.fileRoot, row.fileId);
    await copyTree(source, path.join(directory, 'documents', row.fileId));
    documents.push({ fileId: row.fileId, sourceSha256: row.sourceSha256, capturedAt: createdAt, expiresAt: row.authoritativeExpiresAt });
  }
  await copyTree(runtime.config.paymentRoot, path.join(directory, 'payment-assets'));
  await copyTree(runtime.config.advertisementRoot, path.join(directory, 'advertisement-assets'));
  const advertisementAssets = await advertisementInventory(path.join(directory, 'advertisement-assets'));
  await verifyAdvertisementAssets(path.join(directory, 'database.sqlite'), path.join(directory, 'advertisement-assets'), advertisementAssets);
  await json(path.join(directory, 'retention-manifest.json'), manifest);
  const ledger = path.join(runtime.config.ledgerRoot, 'retention.jsonl');
  await assertNoLinks(ledger, { missing: true });
  await fs.writeFile(path.join(directory, 'retention.jsonl'), await fs.readFile(ledger).catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), { flag: 'wx', mode: 0o600 });
  const snapshot = { schemaVersion: 1, product: 'campus-print-v1', snapshotId, createdAt, documents, advertisementAssets,
    databaseSha256: await hash(path.join(directory, 'database.sqlite')), scope: 'committed-database-and-ready-live-files', complete: true };
  await json(path.join(directory, 'snapshot.json'), snapshot);
  return { snapshotId, directory, createdAt, documents: documents.length };
  } finally { runtime.files.activeSnapshots.delete(snapshotId); }
}
async function freshDirectory(target, config) {
  if (!path.isAbsolute(target) || path.resolve(target) === path.parse(target).root || path.resolve(target) === ROOT ||
      inside('D:/SkillWorkbench-V1', target) || inside(target, 'D:/SkillWorkbench-V1') || inside(path.join(ROOT, 'frontend'), target)) throw new Error('Use a dedicated private absolute directory');
  for (const root of [config.fileRoot, config.tempRoot, config.ledgerRoot, config.paymentRoot, config.advertisementRoot, config.backupRoot, path.dirname(config.dbPath)]) {
    if (inside(root, target) || inside(target, root)) throw new Error('Authority directory must be separate from all managed storage');
  }
  await ensureRoot(target);
  if ((await fs.readdir(target)).length) throw new Error('Authority directory must be empty; never overwrite older evidence');
}
async function exportAuthority(runtime, directory) {
  await freshDirectory(directory, runtime.config);
  const manifest = runtime.files.exportRetentionManifest();
  await json(path.join(directory, 'retention-manifest.json'), manifest);
  const ledger = path.join(runtime.config.ledgerRoot, 'retention.jsonl'); await assertNoLinks(ledger, { missing: true });
  await fs.writeFile(path.join(directory, 'retention.jsonl'), await fs.readFile(ledger).catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), { flag: 'wx', mode: 0o600 });
  await json(path.join(directory, 'authority.json'), { kind: 'campus-print-latest-authority', generatedAt: manifest.generatedAt,
    manifestSha256: await hash(path.join(directory, 'retention-manifest.json')), ledgerSha256: await hash(path.join(directory, 'retention.jsonl')) });
  return { directory, generatedAt: manifest.generatedAt, files: manifest.files.length };
}
async function restoreSnapshot({ snapshotRoot, config, authorityRoot = null }) {
  validateStorageConfig(config); await assertNoLinks(snapshotRoot);
  const snapshot = JSON.parse(await fs.readFile(await safePath(snapshotRoot, 'snapshot.json'), 'utf8'));
  if (snapshot.product !== 'campus-print-v1' || snapshot.schemaVersion !== 1 || !snapshot.complete || !validTime(snapshot.createdAt) ||
      !UUID.test(snapshot.snapshotId) || !Array.isArray(snapshot.documents)) throw new Error('Invalid or incomplete snapshot');
  if (await hash(await safePath(snapshotRoot, 'database.sqlite')) !== snapshot.databaseSha256) throw new Error('Database snapshot checksum mismatch');
  // Validate referenced images before writing any target data. A real 1.1 snapshot
  // has neither advertisement rows nor a directory and remains restorable.
  const advertisements = await verifyAdvertisementAssets(path.join(snapshotRoot, 'database.sqlite'), path.join(snapshotRoot, 'advertisement-assets'), snapshot.advertisementAssets);
  const now = config.clock().toISOString(); let manifest = { schemaVersion: 1, product: 'campus-print-v1', generatedAt: now, files: [] }, ledger = '';
  if (authorityRoot) {
    if (inside(snapshotRoot, authorityRoot) || inside(authorityRoot, snapshotRoot)) throw new Error('Old snapshot cannot supply latest authority');
    await assertNoLinks(authorityRoot);
    const proof = JSON.parse(await fs.readFile(await safePath(authorityRoot, 'authority.json'), 'utf8'));
    if (proof.kind !== 'campus-print-latest-authority' || !validTime(proof.generatedAt) || proof.generatedAt < snapshot.createdAt || proof.generatedAt > now ||
        proof.manifestSha256 !== await hash(await safePath(authorityRoot, 'retention-manifest.json')) || proof.ledgerSha256 !== await hash(await safePath(authorityRoot, 'retention.jsonl'))) throw new Error('Invalid latest authority; do not use an old snapshot as authority');
    manifest = JSON.parse(await fs.readFile(path.join(authorityRoot, 'retention-manifest.json'), 'utf8'));
    if (manifest.generatedAt !== proof.generatedAt || manifest.product !== 'campus-print-v1' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid authority manifest');
    ledger = await fs.readFile(path.join(authorityRoot, 'retention.jsonl'), 'utf8');
  }
  const roots = [path.dirname(config.dbPath), config.fileRoot, config.tempRoot, config.ledgerRoot, config.paymentRoot, config.advertisementRoot, config.backupRoot];
  for (const root of roots) {
    if (inside(root, snapshotRoot) || inside(snapshotRoot, root) || (authorityRoot && (inside(root, authorityRoot) || inside(authorityRoot, root)))) throw new Error('Restore source and target must be separate');
    await ensureRoot(root); if ((await fs.readdir(root)).length) throw new Error('Restore only into empty storage; never overwrite an existing service');
  }
  // Hold the target lock during all writes; no HTTP listener exists during restore.
  const release = await require('../../backend/runtime-lock').acquireRuntimeLock(config.dbPath);
  const pendingRestore = path.join(path.dirname(config.dbPath), 'campus-print.restore.pending');
  let runtime, restoredFiles = 0;
  try {
    await fs.writeFile(pendingRestore, JSON.stringify({ snapshotId: snapshot.snapshotId, startedAt: now }), { flag: 'wx', mode: 0o600 });
    await fs.copyFile(path.join(snapshotRoot, 'database.sqlite'), config.dbPath, require('node:fs').constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(config.ledgerRoot, 'retention.jsonl'), ledger, { flag: 'wx', mode: 0o600 });
    const current = new Map(manifest.files.map(row => [row.fileId, row]));
    for (const entry of snapshot.documents) {
      if (!UUID.test(entry.fileId)) throw new Error('Invalid document identity');
      const expiry = deadline(snapshot, entry, current.get(entry.fileId));
      if (!expiry || expiry <= now) continue;
      const original = await safePath(snapshotRoot, `documents/${entry.fileId}/original.bin`, { missing: true });
      try { if (await hash(original) !== entry.sourceSha256) throw new Error('Source checksum mismatch'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await copyTree(path.dirname(original), path.join(config.fileRoot, entry.fileId)); restoredFiles++;
    }
    await copyTree(await safePath(snapshotRoot, 'payment-assets'), config.paymentRoot);
    if (!advertisements.legacyWithoutDirectory) await copyTree(await safePath(snapshotRoot, 'advertisement-assets'), config.advertisementRoot);
  } finally { await release(); }
  try {
    runtime = await createApp({ ...config, recoverFileJobs: false, allowPendingRestore: true });
    // Never restore authenticated sessions or queued document processing blindly.
    runtime.db.run('DELETE FROM sessions');
    await runtime.files.reconcileRestoredFiles({ latestManifest: manifest });
    for (const row of runtime.db.all('SELECT id FROM files')) {
      let exists = true; try { await safePath(config.fileRoot, `${row.id}/original.bin`); } catch { exists = false; }
      if (!exists) runtime.db.tx(() => { runtime.db.run("UPDATE files SET status='expired',purgedAt=NULL WHERE id=?", row.id); runtime.files.event('revoked', row.id); });
    }
    await runtime.files.purgeExpiredFiles();
    await fs.unlink(pendingRestore);
    return { restoredFiles, snapshotCreatedAt: snapshot.createdAt, latestAuthorityProvided: !!authorityRoot,
      warning: authorityRoot ? 'Restore uses supplied latest authority; verify its provenance before opening service.' : 'Latest authority missing: all student files remain inaccessible; order records restored.',
      orders: runtime.db.get('SELECT COUNT(*) AS n FROM print_orders').n, advertisements, beforeHttpReconciled: true };
  } finally { await runtime?.close(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'restore') {
    if (args.length < 1 || args.length > 2 || args.some(arg => !path.isAbsolute(arg))) throw new Error('restore needs absolute snapshot path and optional latest authority path; target .env must point to empty storage');
    console.log(JSON.stringify(await restoreSnapshot({ snapshotRoot: args[0], config: loadConfig(), authorityRoot: args[1] }), null, 2)); return;
  }
  if (!['backup', 'authority'].includes(command) || (command === 'backup' && args.length) || (command === 'authority' && (args.length !== 1 || !path.isAbsolute(args[0])))) throw new Error('Stop the service first. Commands: backup | authority ABSOLUTE_EMPTY_DIR | restore ABSOLUTE_SNAPSHOT [ABSOLUTE_LATEST_AUTHORITY]');
  const runtime = await createApp({ recoverFileJobs: false });
  try { console.log(JSON.stringify(command === 'backup' ? await createSnapshot(runtime) : await exportAuthority(runtime, args[0]), null, 2)); }
  finally { await runtime.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createSnapshot, exportAuthority, restoreSnapshot, hash };
