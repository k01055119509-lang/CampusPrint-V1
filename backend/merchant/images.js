'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ApiError } = require('../errors');
const { safePath, removeTree, UUID } = require('../files/safety');

// Only server-generated IDs are ever resolved. Synchronous availability checks
// keep configuration/actions honest without turning order transactions async.
function available(root, asset) {
  if (!asset || !UUID.test(asset.assetId) || asset.mimeType !== 'image/png') return false;
  const target = path.join(root, `${asset.assetId}.png`);
  let current = path.parse(target).root;
  try {
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return false;
    }
    const stat = fs.statSync(target); fs.accessSync(target, fs.constants.R_OK);
    return stat.isFile() && stat.size === asset.byteSize && stat.size > 0;
  } catch { return false; }
}
async function openAsset(root, asset, checkAccess, errorCode) {
  if (!available(root, asset)) throw new ApiError(503, errorCode, '图片暂不可读取，请刷新或联系经营者');
  let handle;
  try {
    handle = await fsp.open(await safePath(root, `${asset.assetId}.png`), 'r');
    checkAccess();
    const stat = await handle.stat();
    if (stat.size !== asset.byteSize) throw new ApiError(503, errorCode, '图片完整性检查失败');
    return { handle, mimeType: asset.mimeType, byteSize: asset.byteSize, sha256: asset.sha256, filename: 'image.png', checkAccess };
  } catch (error) { await handle?.close(); if (error instanceof ApiError) throw error; throw new ApiError(503, errorCode, '图片暂不可读取'); }
}
class ManagedImages {
  constructor(context, root, cleanupTable) {
    Object.assign(this, context); this.root = root; this.cleanupTable = cleanupTable;
    if (!['payment_asset_cleanup','advertisement_asset_cleanup'].includes(cleanupTable)) throw new Error('Unknown image cleanup table');
  }
  queue(asset) { if (asset) this.db.run(`INSERT OR IGNORE INTO ${this.cleanupTable}(assetId,queuedAt) VALUES(?,?)`, asset.assetId, this.now()); }
  cleanupStatus() { return this.db.all(`SELECT assetId,attempts,lastError FROM ${this.cleanupTable} ORDER BY queuedAt,assetId`); }
  async initialize() {
    // Recover publication/transaction crash gaps without touching referenced assets.
    for (const name of await fsp.readdir(this.root)) {
      const assetId = name.endsWith('.png') ? name.slice(0,-4) : '';
      if (UUID.test(assetId) && !this.references().has(assetId)) this.queue({ assetId });
    }
    await this.drain();
    this.timer = setInterval(() => this.drain().catch(() => {}), this.config.limits.cleanupIntervalMs); this.timer.unref();
  }
  drain() {
    if (this.draining) return this.draining;
    this.draining = (async()=>{
      for (const row of this.db.all(`SELECT assetId FROM ${this.cleanupTable}`)) {
        if (this.references().has(row.assetId)) continue;
        try { await this.deleteAsset(row.assetId); this.db.run(`DELETE FROM ${this.cleanupTable} WHERE assetId=?`, row.assetId); }
        catch (error) { this.db.run(`UPDATE ${this.cleanupTable} SET attempts=attempts+1,lastError=? WHERE assetId=?`, error.code || 'DELETE_FAILED', row.assetId); }
      }
    })().finally(()=>{ this.draining = null; });
    return this.draining;
  }
  async receive(req) { return this.files.receiveBusinessImage(req, this.root); }
  async deleteAsset(assetId) { await removeTree(this.root, `${assetId}.png`); }
  async close() { clearInterval(this.timer); await this.draining; }
}
module.exports = { available, openAsset, ManagedImages };
