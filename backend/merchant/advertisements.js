'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError, invalid, missing } = require('../errors');
const v = require('../validation');
const r = require('../orders/rules');
const { available, openAsset, ManagedImages } = require('./images');
class AdvertisementService extends ManagedImages {
  constructor(context) { super(context, context.config.advertisementRoot, 'advertisement_asset_cleanup'); }
  requireEnabled(){if(!this.config.advertisementsEnabled)throw new ApiError(403,'ADVERTISEMENTS_DISABLED','广告功能已停用');}
  settings() { return this.db.get('SELECT * FROM advertisement_settings WHERE id=1'); }
  row(id) { r.uuid(id); const row = this.db.get('SELECT * FROM advertisements WHERE id=?', id); if (!row) missing(); return row; }
  references() { return new Set(this.db.all('SELECT assetJson FROM advertisements').map(row=>JSON.parse(row.assetJson).assetId)); }
  version(value) { r.integer(value, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER); if (value !== this.settings().version) throw new ApiError(409, 'VERSION_CONFLICT', '广告配置已改变，请刷新后重试'); }
  bump(actorId) { this.db.run('UPDATE advertisement_settings SET version=version+1,updatedAt=?,updatedBy=? WHERE id=1', this.now(), actorId); }
  list(admin = false) {
    if(admin)this.requireEnabled();
    const { version, intervalSeconds } = this.settings();
    if(!this.config.advertisementsEnabled)return {enabled:false,version,intervalSeconds,items:[]};
    const rows = this.db.all('SELECT * FROM advertisements ORDER BY position,id');
    const items = rows.filter(row=>admin || row.enabled).map(row=>{
      const asset = JSON.parse(row.assetJson);
      const common = { id: row.id, imageUrl: `/api/${admin ? 'admin' : 'public'}/advertisements/${row.id}/image`, altText: row.altText };
      return admin ? { ...common, enabled: !!row.enabled, position: row.position, available: available(this.root,asset), createdAt: row.createdAt, updatedAt: row.updatedAt } : common;
    });
    return { enabled:true,version, intervalSeconds, items, ...(admin ? { cleanup: this.cleanupStatus() } : {}) };
  }
  patch(req) {
    this.requireEnabled();
    this.version(req.body.expectedVersion);
    if (req.body.intervalSeconds !== undefined) {
      const interval = r.integer(req.body.intervalSeconds, 'intervalSeconds', 2, 30);
      this.db.run('UPDATE advertisement_settings SET intervalSeconds=? WHERE id=1', interval);
    }
    if (req.body.order !== undefined) {
      const order = req.body.order, ids = this.db.all('SELECT id FROM advertisements').map(row=>row.id);
      if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some(id=>!ids.includes(id))) invalid('order', '排序须恰好包含当前全部广告，每张一次');
      order.forEach((id, index)=>this.db.run('UPDATE advertisements SET position=?,updatedAt=? WHERE id=?', index, this.now(), id));
    }
    this.bump(req.user.id); return this.list(true);
  }
  patchItem(req) {
    this.requireEnabled();
    this.version(req.body.expectedVersion); const row = this.row(req.params.id);
    const enabled = req.body.enabled === undefined ? row.enabled : (r.bool(req.body.enabled, 'enabled') ? 1 : 0);
    const altText = req.body.altText === undefined ? row.altText : v.string(req.body.altText, 'altText', { max:200 });
    this.db.run('UPDATE advertisements SET enabled=?,altText=?,updatedAt=? WHERE id=?', enabled, altText, this.now(), row.id);
    this.bump(req.user.id); return this.list(true);
  }
  limit() { if (this.db.get('SELECT COUNT(*) AS n FROM advertisements').n >= 5) throw new ApiError(409, 'ADVERTISEMENT_LIMIT', '最多保存五张广告图片，请先删除或替换'); }
  async upload(req, replace = false) {
    this.requireEnabled();
    const raw = req.headers['x-advertisements-version'];
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) invalid('X-Advertisements-Version', '上传须提供当前广告配置版本');
    const version = Number(raw); this.version(version);
    if (replace) this.row(req.params.id); else this.limit();
    const asset = await this.receive(req);
    try {
      this.db.tx(()=>{
        this.version(version);
        if (replace) {
          const row = this.row(req.params.id); this.queue(JSON.parse(row.assetJson));
          this.db.run('UPDATE advertisements SET assetJson=?,updatedAt=? WHERE id=?', JSON.stringify(asset), this.now(), row.id);
        } else {
          this.limit(); const position = this.db.get('SELECT COALESCE(MAX(position),-1)+1 AS n FROM advertisements').n;
          this.db.run('INSERT INTO advertisements(id,assetJson,position,createdAt,updatedAt) VALUES(?,?,?,?,?)', randomUUID(), JSON.stringify(asset), position, this.now(), this.now());
        }
        this.bump(req.user.id);
      });
    } catch (error) { this.queue(asset); await this.drain(); throw error; }
    await this.drain(); return this.list(true);
  }
  async remove(req) {
    this.requireEnabled();
    this.db.tx(()=>{
      this.version(req.body.expectedVersion); r.uuid(req.params.id);
      const row = this.db.get('SELECT * FROM advertisements WHERE id=?', req.params.id);
      if (!row) return;
      this.queue(JSON.parse(row.assetJson)); this.db.run('DELETE FROM advertisements WHERE id=?', row.id);
      this.db.all('SELECT id FROM advertisements ORDER BY position,id').forEach((item,index)=>this.db.run('UPDATE advertisements SET position=? WHERE id=?', index, item.id));
      this.bump(req.user.id);
    });
    await this.drain(); return this.list(true);
  }
  async open(id, admin = false) {
    this.requireEnabled();
    const row = this.row(id); if (!admin && !row.enabled) missing();
    const asset = JSON.parse(row.assetJson);
    return openAsset(this.root,asset,()=>{
      const current = this.db.get('SELECT assetJson,enabled FROM advertisements WHERE id=?', id);
      if (!current || (!admin && !current.enabled)) missing();
      if (JSON.parse(current.assetJson).assetId !== asset.assetId) throw new ApiError(409, 'ADVERTISEMENT_CONFIGURATION_CHANGED', '广告图片已改变，请刷新');
    }, 'ADVERTISEMENT_ASSET_UNAVAILABLE');
  }
}
module.exports = { AdvertisementService };
