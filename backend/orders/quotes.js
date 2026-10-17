'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError, missing } = require('../errors');
const { RULES, PRICING_RULES, uuid, calculateItems, totalsDto, fingerprint } = require('./rules');
class QuoteService {
  constructor(context) { Object.assign(this, context); }
  row(userId, id) { uuid(id); const row = this.db.get('SELECT * FROM print_quotes WHERE id=? AND userId=?', id, userId); if (!row) missing(); return row; }
  create(userId, input) {
    const calculated = calculateItems(input.items, fileId => this.files.getOwnedReadyFile({ userId, fileId }));
    const { coupon, discountAmountFen } = this.coupons.preview(input.couponCode, calculated.totals.printAmountFen);
    calculated.totals.discountAmountFen = discountAmountFen;
    calculated.totals.totalAmountFen = calculated.totals.printAmountFen - discountAmountFen + calculated.totals.deliveryFeeFen;
    const id = randomUUID(), items = calculated.items.map(item => ({ ...item, itemId: randomUUID() }));
    this.db.run("INSERT INTO print_quotes(id,userId,status,itemsJson,totalsJson,createdAt,preparationDeadline,couponSnapshotJson) VALUES(?,?,'processing',?,?,?,?,?)", id, userId,
      JSON.stringify(items), JSON.stringify(calculated.totals), this.now(), new Date(Date.parse(this.now()) + RULES.preparationTimeoutSeconds * 1000).toISOString(), coupon ? JSON.stringify(coupon) : null);
    this.db.afterCommit(() => this.launch(this.row(userId, id)));
    return this.dto(this.row(userId, id));
  }
  launch(row) {
    if (this.pricingChanged(row)) return;
    for (const item of JSON.parse(row.itemsJson)) {
      this.files.preparePrintItem({ userId: row.userId, fileId: item.fileId, pageNumbers: item.pageNumbers, preparationId: `${row.id}:${item.itemId}` })
        .catch(error => {
          if (this.files.stopping) return;
          const publicError = { code: error instanceof ApiError ? error.code : 'QUOTE_PREPARATION_FAILED', message: error instanceof ApiError ? error.message : '生产文件准备失败，请重新上传' };
          this.db.run("UPDATE print_quotes SET status='failed',errorJson=? WHERE id=? AND status='processing'", JSON.stringify(publicError), row.id);
        });
    }
  }
  async refresh(userId, id) {
    let row = this.row(userId, id);
    if (this.pricingChanged(row)) return this.dto(row);
    if (row.status !== 'processing') return this.dto(row);
    if (this.now() >= row.preparationDeadline) {
      this.db.run("UPDATE print_quotes SET status='failed',errorJson=? WHERE id=? AND status='processing'", JSON.stringify({ code: 'QUOTE_PREPARATION_TIMEOUT', message: '报价准备超时，请重新报价' }), id);
      return this.dto(this.row(userId, id));
    }
    try {
      const items = JSON.parse(row.itemsJson); let allReady = true;
      for (const item of items) {
        let preparation;
        try { preparation = this.files.getPreparation({ userId, preparationId: `${id}:${item.itemId}` }); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; this.launch(row); allReady = false; break; }
        if (preparation.status === 'failed' || preparation.status === 'expired') throw new ApiError(422, preparation.error?.code || 'QUOTE_PREPARATION_FAILED', preparation.error?.message || '生产文件准备失败');
        if (preparation.status !== 'ready') { allReady = false; continue; }
        item.printArtifactId = preparation.artifact.artifactId; item.printArtifactSha256 = preparation.artifact.sha256;
      }
      if (allReady) {
        // Read/hash the saved PDF and its saved preview before accepting a payable production version. I/O stays outside SQLite transactions.
        for (const item of items) for (const purpose of ['production','preview']) {
          const opened = await this.files.openArtifactForRead({ actor: { id: userId, role: 'user' }, artifactId: item.printArtifactId, purpose, page: 1 });
          await opened.handle.close();
        }
        this.db.tx(() => {
          row = this.row(userId, id); if (row.status !== 'processing') return;
          if (this.pricingChanged(row)) throw new ApiError(409, 'QUOTE_PRICING_CHANGED', '计价规则已更新，请重新报价并确认');
          if (this.now() >= row.preparationDeadline) throw new ApiError(409, 'QUOTE_PREPARATION_TIMEOUT', '报价准备超时，请重新报价');
          for (const item of items) this.files.getOwnedReadyFile({ userId, fileId: item.fileId });
          const readyAt = this.now(), expiresAt = new Date(Date.parse(readyAt) + RULES.quoteValiditySeconds * 1000).toISOString();
          const digest = fingerprint({ id, items, totals: JSON.parse(row.totalsJson), coupon: JSON.parse(row.couponSnapshotJson || 'null') });
          this.db.run("UPDATE print_quotes SET status='ready',itemsJson=?,readyAt=?,expiresAt=?,fingerprint=? WHERE id=?", JSON.stringify(items), readyAt, expiresAt, digest, id);
        });
      }
    } catch (error) {
      const publicError = { code: error instanceof ApiError ? error.code : 'QUOTE_PREPARATION_FAILED', message: error instanceof ApiError ? error.message : '无法验证生产版本，请重新上传' };
      this.db.run("UPDATE print_quotes SET status='failed',errorJson=? WHERE id=? AND status='processing'", JSON.stringify(publicError), id);
    }
    return this.dto(this.row(userId, id));
  }
  pricingChanged(row) {
    const totals = JSON.parse(row.totalsJson);
    return totals.pricingVersion !== RULES.pricingVersion || !totals.pricingRules || fingerprint(totals.pricingRules) !== fingerprint(PRICING_RULES);
  }
  validity(row) {
    if (row.claimedOrderId) return 'QUOTE_ALREADY_USED';
    if (this.pricingChanged(row)) return 'QUOTE_PRICING_CHANGED';
    if (row.status === 'failed') return JSON.parse(row.errorJson)?.code || 'QUOTE_PREPARATION_FAILED';
    try { this.coupons.checkSnapshot(JSON.parse(row.couponSnapshotJson || 'null'), JSON.parse(row.totalsJson)); }
    catch (error) { return error instanceof ApiError ? error.code : 'COUPON_UNAVAILABLE'; }
    if (row.status !== 'ready') return 'QUOTE_PROCESSING';
    if (row.expiresAt <= this.now()) return 'QUOTE_EXPIRED';
    try { for (const item of JSON.parse(row.itemsJson)) this.files.getOwnedReadyFile({ userId: row.userId, fileId: item.fileId }); }
    catch (error) { return error instanceof ApiError ? error.code : 'QUOTE_INVALID'; }
    return null;
  }
  dto(row) {
    const invalidReason = this.validity(row), items = JSON.parse(row.itemsJson);
    return { id: row.id, status: row.status, ...totalsDto(JSON.parse(row.totalsJson)), coupon: JSON.parse(row.couponSnapshotJson || 'null'), items,
      createdAt: row.createdAt, preparationDeadline: row.preparationDeadline, readyAt: row.readyAt, expiresAt: row.expiresAt,
      fingerprint: row.fingerprint, error: row.errorJson ? JSON.parse(row.errorJson) : null, valid: invalidReason === null, invalidReason,
      orderId: row.claimedOrderId, allowedActions: invalidReason === null ? ['preview','create_order'] : [],
      preparedItemCount: row.status === 'ready' ? items.length : items.filter(item => {
        try { return this.files.getPreparation({ userId: row.userId, preparationId: `${row.id}:${item.itemId}` }).status === 'ready'; } catch { return false; }
      }).length };
  }
  ready(userId, id) {
    const row = this.row(userId, id), invalidReason = this.validity(row);
    if (invalidReason) throw new ApiError(invalidReason === 'FILE_EXPIRED' ? 410 : 409, invalidReason, '报价不可使用，请查询状态或重新报价');
    return row;
  }
}
module.exports = { QuoteService };
