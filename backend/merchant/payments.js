'use strict';
const { ApiError, invalid } = require('../errors');
const v = require('../validation');
const { available, openAsset, ManagedImages } = require('./images');
const CHANNELS = ['wechat','alipay'];
class PaymentService extends ManagedImages {
  constructor(context) { super(context, context.config.paymentRoot, 'payment_asset_cleanup'); }
  asset(channel = null) {
    return JSON.parse((channel === null ? this.orders.settingsRow().paymentAssetJson : this.db.get('SELECT assetJson FROM payment_channels WHERE channel=?', this.channel(channel)).assetJson) || 'null');
  }
  channel(value) { return v.choice(value, CHANNELS, 'channel'); }
  references() { return new Set([this.asset(), ...CHANNELS.map(channel=>this.asset(channel))].filter(Boolean).map(asset=>asset.assetId)); }
  snapshot() {
    const channels = CHANNELS.map(channel=>{
      const asset = this.asset(channel), readable = available(this.root, asset);
      return { channel, configured: !!asset, available: readable, imageUrl: readable ? `/api/public/payment-qr/${channel}` : null };
    });
    const asset = this.asset(), readable = available(this.root, asset);
    const legacy = { configured: !!asset, available: readable, imageUrl: readable ? '/api/public/payment-qr' : null };
    return { configured: readable || channels.some(row=>row.available), qrUrl: legacy.imageUrl || channels.find(row=>row.available)?.imageUrl || null,
      channels, legacy, instructions: this.orders.settingsRow().paymentInstructions };
  }
  requireChannel(channel) {
    v.choice(channel, [...CHANNELS, 'other'], 'channel');
    // 'other' is solely an explicit compatibility route for an unassigned old QR.
    const asset = this.asset(channel === 'other' ? null : channel);
    if (!asset) throw new ApiError(409, 'PAYMENT_NOT_CONFIGURED', '所选收款渠道尚未配置，请选择可用渠道');
    if (!available(this.root, asset)) throw new ApiError(409, 'PAYMENT_ASSET_UNAVAILABLE', '所选渠道的收款图片暂不可读取');
    return channel;
  }
  async replace(req, channel = null) {
    if (channel !== null) this.channel(channel);
    const raw = req.headers['x-settings-version'];
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) invalid('X-Settings-Version', '上传须提供当前经营设置版本');
    const version = Number(raw); this.orders.settingsVersion(version);
    const asset = await this.receive(req);
    try {
      this.db.tx(()=>{
        this.orders.settingsVersion(version); this.queue(this.asset(channel));
        if (channel === null) this.db.run('UPDATE print_settings SET paymentAssetJson=? WHERE id=1', JSON.stringify(asset));
        else this.db.run('UPDATE payment_channels SET assetJson=?,updatedAt=?,updatedBy=? WHERE channel=?', JSON.stringify(asset), this.now(), req.user.id, channel);
        this.bump(req.user.id);
      });
    } catch (error) { this.queue(asset); await this.drain(); throw error; }
    await this.drain(); return this.orders.settings();
  }
  bump(actorId) { this.db.run('UPDATE print_settings SET version=version+1,updatedAt=?,updatedBy=? WHERE id=1', this.now(), actorId); }
  async clear(req, channel = null) {
    if (channel !== null) this.channel(channel);
    this.db.tx(()=>{
      this.orders.settingsVersion(req.body.expectedVersion); const old = this.asset(channel);
      if (!old) return;
      this.queue(old);
      if (channel === null) this.db.run('UPDATE print_settings SET paymentAssetJson=NULL WHERE id=1');
      else this.db.run('UPDATE payment_channels SET assetJson=NULL,updatedAt=?,updatedBy=? WHERE channel=?', this.now(), req.user.id, channel);
      this.bump(req.user.id);
    });
    await this.drain(); return this.orders.settings();
  }
  async open(channel = null) {
    const asset = this.asset(channel);
    if (!asset) throw new ApiError(404, 'PAYMENT_NOT_CONFIGURED', '所选收款渠道尚未配置');
    return openAsset(this.root, asset, ()=>{
      if (this.asset(channel)?.assetId !== asset.assetId) throw new ApiError(409, 'PAYMENT_CONFIGURATION_CHANGED', '收款信息已改变，请刷新');
    }, 'PAYMENT_ASSET_UNAVAILABLE');
  }
}
module.exports = { PaymentService, CHANNELS };
