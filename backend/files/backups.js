'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath, assertNoLinks, removeTree, UUID } = require('./safety');
const { validTime } = require('./ledger');
const MAX_AGE_MS = 7 * 86400000;
// Do not use recursive fs.cp on unvalidated trees: nested junctions are also forbidden.
async function copyTree(source, destination) {
  await assertNoLinks(source); await assertNoLinks(destination, { missing: true });
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) await copyTree(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
  else throw new Error('Unsupported backup object');
}
function deadline(snapshot, entry, current) {
  if (!validTime(snapshot.createdAt) || !validTime(entry.capturedAt) || entry.capturedAt !== snapshot.createdAt) return null;
  if (!current || current.sourceSha256 !== entry.sourceSha256 || current.revoked || current.purgedAt || current.status === 'expired') return null;
  const candidates = [new Date(Date.parse(entry.capturedAt) + MAX_AGE_MS).toISOString()];
  for (const value of [entry.expiresAt, current.authoritativeExpiresAt]) {
    if (value !== null && !validTime(value)) return null;
    if (value) candidates.push(value);
  }
  return candidates.sort()[0];
}
async function pruneBackups({ root, manifest, now, deleteTree = removeTree, activeSnapshots = new Set() }) {
  const current = new Map(manifest.files.map(row => [row.fileId, row]));
  const result = { examined: 0, purged: 0, failures: [] };
  for (const snapshotId of await fs.readdir(root)) {
    if (activeSnapshots.has(snapshotId)) continue;
    if (!UUID.test(snapshotId)) { result.failures.push({ snapshotId: '', fileId: '', code: 'BACKUP_METADATA_INVALID' }); continue; }
    let snapshot;
    try {
      snapshot = JSON.parse(await fs.readFile(await safePath(root, `${snapshotId}/snapshot.json`), 'utf8'));
      if (snapshot.product !== 'campus-print-v1' || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.documents)) throw new Error('Invalid snapshot');
    } catch {
      // Incomplete snapshots cannot have a trusted document lifetime; delete their document tree.
      try { await deleteTree(root, `${snapshotId}/documents`); } catch { result.failures.push({ snapshotId, fileId: '', code: 'BACKUP_DELETE_FAILED' }); }
      continue;
    }
    for (const entry of snapshot.documents) {
      if (!UUID.test(entry.fileId)) { result.failures.push({ snapshotId, fileId: '', code: 'BACKUP_METADATA_INVALID' }); continue; }
      result.examined++;
      const expiry = deadline(snapshot, entry, current.get(entry.fileId));
      if (expiry && expiry > now) continue;
      try {
        const relative = `${snapshotId}/documents/${entry.fileId}`;
        try { await safePath(root, relative); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await deleteTree(root, relative); result.purged++;
      } catch { result.failures.push({ snapshotId, fileId: entry.fileId, code: 'BACKUP_DELETE_FAILED' }); }
    }
    // Remove unlisted document trees; no arbitrary user-supplied paths are accepted.
    try {
      const directory = await safePath(root, `${snapshotId}/documents`);
      const known = new Set(snapshot.documents.map(row => row.fileId));
      for (const name of await fs.readdir(directory)) if (!known.has(name)) await deleteTree(root, `${snapshotId}/documents/${name}`);
    } catch (error) { if (error.code !== 'ENOENT') result.failures.push({ snapshotId, fileId: '', code: 'BACKUP_DELETE_FAILED' }); }
  }
  return result;
}
module.exports = { copyTree, deadline, pruneBackups, MAX_AGE_MS };
