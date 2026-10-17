'use strict';
const { randomBytes } = require('node:crypto');
const { hashToken } = require('../auth');
const { ApiError, missing } = require('../errors');
const { uuid } = require('./rules');
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function queryCode() { return [...randomBytes(32)].map(byte => CODE_ALPHABET[byte & 31]).join(''); }
function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const code = value.toUpperCase().replace(/[\s-]/gu, '');
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{32}$/.test(code) ? code : null;
}
// Full codes live only in the private SQLite database and managed database backups.
// The lookup index is a hash; never include code rows in general DTOs, events or idempotency results.
class OrderAccess {
  constructor({ db, now, auth, config }) { Object.assign(this, { db, now, auth, config }); }
  ensureCode(orderId) {
    if (this.db.get('SELECT 1 FROM order_query_codes WHERE orderId=?', orderId)) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = queryCode();
      try { this.db.run('INSERT INTO order_query_codes VALUES(?,?,?,?)', orderId, hashToken(code), code, this.now()); return; }
      catch (error) { if (!/UNIQUE constraint failed: order_query_codes\.(code|codeHash)/.test(error.message)) throw error; }
    }
    throw new Error('Query code generation failed');
  }
  initialize() {
    this.db.tx(() => {
      for (const row of this.db.all('SELECT id FROM print_orders WHERE id NOT IN (SELECT orderId FROM order_query_codes)')) this.ensureCode(row.id);
    });
  }
  granted(actor, orderId, session) {
    return !!session && !!this.db.get("SELECT 1 FROM order_access_grants g JOIN sessions s ON s.tokenHash=g.sessionHash WHERE g.orderId=? AND g.sessionHash=? AND s.userId=? AND s.surface='student' AND s.expiresAt>?", orderId, session.tokenHash, actor.id, this.now());
  }
  resolve(actor, orderId, session = null, capability = 'detail') {
    uuid(orderId);
    if (!actor?.id || !['user','admin'].includes(actor.role)) throw new ApiError(401, 'AUTH_REQUIRED', '请先建立身份');
    const row = this.db.get('SELECT * FROM print_orders WHERE id=?', orderId);
    if (!row) missing();
    const accessType = actor.role === 'admin' ? 'admin' : row.userId === actor.id ? 'owner' : this.granted(actor, orderId, session) ? 'recovered' : null;
    if (!accessType) missing();
    if(accessType==='admin'&&row.hiddenFromMerchant&&capability!=='tickets')throw new ApiError(404,'ORDER_HIDDEN_FROM_MERCHANT','该用户直接取消单已从商户订单中隐藏');
    if (accessType === 'recovered' && !['detail','payment','tickets'].includes(capability)) throw new ApiError(403, 'FORBIDDEN', '查询码授权不允许该操作，请通过售后联系经营者');
    return { row, accessType };
  }
  visibleWhere(actor, session, alias = 'o') {
    if (actor.role === 'admin') return { sql: `${alias}.hiddenFromMerchant=0`, args: [] };
    return { sql: `(${alias}.userId=? OR EXISTS (SELECT 1 FROM order_access_grants g JOIN sessions s ON s.tokenHash=g.sessionHash WHERE g.orderId=${alias}.id AND g.sessionHash=? AND s.userId=? AND s.surface='student' AND s.expiresAt>?))`,
      args: [actor.id, session?.tokenHash || '', actor.id, this.now()] };
  }
  recover(req, res) {
    // Outside the recovery transaction, so rejected guesses remain rate limited across restarts.
    this.auth.rate(`recover:ip:${req.ip}`, this.config.rateLimits.recoverIp, 15 * 60000, res);
    this.auth.rate(`recover:session:${req.session.tokenHash}`, this.config.rateLimits.recoverSession, 15 * 60000, res);
    const code = normalizeCode(req.body.queryCode);
    const record = code && this.db.get('SELECT orderId FROM order_query_codes WHERE codeHash=?', hashToken(code));
    if (!record) missing();
    this.db.tx(() => this.db.run('INSERT OR IGNORE INTO order_access_grants VALUES(?,?,?)', req.session.tokenHash, record.orderId, this.now()));
    return record.orderId;
  }
  reveal(actor, orderId, session) {
    this.resolve(actor, orderId, session, 'query_code');
    const row = this.db.get('SELECT code FROM order_query_codes WHERE orderId=?', orderId);
    if (!row) missing();
    return { orderId, queryCode: row.code };
  }
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function recoveredOrder(dto) {
  return { ...pick(dto, ['id','orderNo','version','createdAt','updatedAt','completedAt','lifecycle','displayStatus','filesExpireAt','fileAvailability','accessType','allowedActions','fulfillment','cancellation','compensation']),
    items: dto.items.map(item => pick(item, ['itemId','originalName','pageNumbers','selectedPageCount','copies','duplex','contentPages','sheetCount','amountFen','paperSize','colorMode','copiesInPdf'])),
    totals: pick(dto.totals, ['contentPages','sheetCount','unitSheetPriceFen','pricingVersion','pricingRules','printAmountFen','discountAmountFen','deliveryFeeFen','totalAmountFen','currency']),
    coupon: dto.coupon, couponException: dto.couponException,
    payment: pick(dto.payment, ['status','configured','qrUrl','channels','legacy','instructions','lastSubmittedAt','lastSubmittedChannel','confirmedAt','confirmedChannel','returnReason']),
    production: pick(dto.production, ['status','completedContentPages']), delivery: pick(dto.delivery, ['status']) };
}
function recoveredTicket(dto) {
  return { ...pick(dto, ['id','orderId','orderNo','category','subject','feedbackType','contactType','contactProvided','status','version','createdAt','updatedAt']),
    updates: dto.updates.map(update => pick(update, ['id','message','status','createdAt'])) };
}
module.exports = { OrderAccess, recoveredOrder, recoveredTicket, normalizeCode, CODE_ALPHABET };
