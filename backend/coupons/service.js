'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const v = require('../validation');
const { ApiError, invalid, missing } = require('../errors');
const r = require('../orders/rules');
const { CODE_ALPHABET } = require('../orders/access');
const json = JSON.stringify;
const codeHash = code => createHash('sha256').update(code).digest('hex');
const newCode = () => [...randomBytes(25)].map(byte => CODE_ALPHABET[byte & 31]).join('');
const masked = code => code.slice(0, 5) + '-*****-*****-*****-' + code.slice(-5);
function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 256) throw new ApiError(400, 'COUPON_INVALID', '优惠兑换码格式无效');
  const code = value.toUpperCase().replace(/[\s-]/gu, '');
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{25}$/.test(code)) throw new ApiError(400, 'COUPON_INVALID', '优惠兑换码须为 25 个有效字符');
  return code;
}
function discountFor(rule, printAmountFen) {
  r.integer(printAmountFen, 'printAmountFen', 1, 100000000);
  if (printAmountFen < rule.minPrintAmountFen) throw new ApiError(400, 'COUPON_THRESHOLD_NOT_MET', '优惠前打印费尚未达到优惠券门槛');
  const discountAmountFen = rule.type === 'discount'
    ? Math.min(printAmountFen - Math.floor((printAmountFen * rule.payRatePercent + 50) / 100), rule.maxDiscountFen ?? Number.MAX_SAFE_INTEGER)
    : rule.reductionFen;
  if (!Number.isSafeInteger(discountAmountFen) || discountAmountFen < 0 || printAmountFen - discountAmountFen <= 0) throw new ApiError(400, 'COUPON_ZERO_TOTAL', '优惠后应付须大于零，请移除或更换优惠券');
  return discountAmountFen;
}
class CouponService {
  constructor(context) { Object.assign(this, context); }
  initialize() {
    this.scan();
    this.timer = setInterval(() => {
      try { this.scan(); } catch (error) { console.error('CampusPrint coupon scan error:', error.code || error.name); }
    }, this.config.limits.cleanupIntervalMs);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); this.timer = null; }
  row(id) { r.uuid(id, 'couponId'); const row = this.db.get('SELECT * FROM coupons WHERE id=?', id); if (!row) missing(); return row; }
  snapshot(row) {
    return { id: row.id, type: row.type, maskedCode: masked(row.code), minPrintAmountFen: row.minPrintAmountFen,
      payRatePercent: row.payRatePercent, maxDiscountFen: row.maxDiscountFen, reductionFen: row.reductionFen, expiresAt: row.expiresAt };
  }
  dto(row) {
    return { ...this.snapshot(row), batchId: row.batchId, state: row.state, version: row.version,
      createdAt: row.createdAt, disabledAt: row.disabledAt, isExpired: row.expiresAt <= this.now(), reservedOrderId: row.reservedOrderId, redeemedAt: row.redeemedAt };
  }
  event(row, actorId, type, orderId = null, data = {}) {
    this.db.run('INSERT INTO coupon_events(id,couponId,orderId,actorId,type,createdAt,dataJson) VALUES(?,?,?,?,?,?,?)', randomUUID(), row.id, orderId, actorId, type, this.now(), json(data));
  }
  createBatch(req) {
    return this.orders.idempotent(req, 'create_coupon_batch', () => {
      const input = req.body, quantity = r.integer(input.quantity ?? 1, 'quantity', 1, 100);
      if (input.quantity === null) invalid('quantity', '必须为 1–100 的整数');
      const type = v.choice(input.type, ['discount','threshold'], 'type'), createdAt = this.now();
      let expiresAt = new Date(Date.parse(createdAt) + 7 * 86400000).toISOString();
      if (input.expiresAt != null) {
        if (typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt))) invalid('expiresAt', '请提供有效 ISO 8601 时间');
        expiresAt = new Date(input.expiresAt).toISOString();
        if (expiresAt <= createdAt) invalid('expiresAt', '有效期必须晚于创建时间');
        // Date.parse normalizes e.g. February 30; reject such impossible calendar dates.
        const [year, month, day] = input.expiresAt.slice(0,10).split('-').map(Number);
        if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) invalid('expiresAt', '日期不存在');
      }
      const rule = { type, minPrintAmountFen: type === 'discount' && input.minPrintAmountFen === undefined ? 0 : r.integer(input.minPrintAmountFen, 'minPrintAmountFen', type === 'discount' ? 0 : 1, 100000000),
        payRatePercent: null, maxDiscountFen: null, reductionFen: null };
      if (type === 'discount') {
        if (input.reductionFen !== undefined) invalid('reductionFen', '折扣券不支持满减参数');
        rule.payRatePercent = r.integer(input.payRatePercent, 'payRatePercent', 1, 99);
        rule.maxDiscountFen = input.maxDiscountFen == null ? null : r.integer(input.maxDiscountFen, 'maxDiscountFen', 1, 100000000);
      } else {
        if (input.payRatePercent !== undefined || input.maxDiscountFen !== undefined) invalid('type', '满减券不支持折扣或封顶参数');
        rule.reductionFen = r.integer(input.reductionFen, 'reductionFen', 1, 100000000);
        if (rule.reductionFen >= rule.minPrintAmountFen) invalid('reductionFen', '满减金额必须小于使用门槛');
      }
      const batchId = randomUUID();
      this.db.run('INSERT INTO coupon_batches VALUES(?,?,?,?,?,?)', batchId, quantity, json(rule), createdAt, expiresAt, req.user.id);
      const coupons = [];
      for (let i = 0; i < quantity; i++) {
        let row;
        for (let attempt = 0; attempt < 8; attempt++) {
          const id = randomUUID(), code = newCode();
          try {
            this.db.run('INSERT INTO coupons(id,batchId,codeHash,code,type,minPrintAmountFen,payRatePercent,maxDiscountFen,reductionFen,createdAt,expiresAt,createdBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
              id, batchId, codeHash(code), code, type, rule.minPrintAmountFen, rule.payRatePercent, rule.maxDiscountFen, rule.reductionFen, createdAt, expiresAt, req.user.id);
            row = this.row(id); break;
          } catch (error) { if (!/UNIQUE constraint failed: coupons\.(code|codeHash)/.test(error.message)) throw error; }
        }
        if (!row) throw new ApiError(503, 'SERVICE_UNAVAILABLE', '暂时无法生成兑换码，请重试');
        this.event(row, req.user.id, 'issued'); coupons.push(this.dto(row));
      }
      return { batchId, quantity, expiresAt, coupons };
    });
  }
  list(query) {
    v.keys(query, ['page','pageSize','type','state','batchId'], 'query');
    const { page, pageSize, offset } = v.pagination(query), where = [], args = [];
    if (query.type !== undefined) { where.push('type=?'); args.push(v.choice(query.type, ['discount','threshold'], 'type')); }
    if (query.state !== undefined) { where.push('state=?'); args.push(v.choice(query.state, ['available','reserved','redeemed'], 'state')); }
    if (query.batchId !== undefined) { r.uuid(query.batchId, 'batchId'); where.push('batchId=?'); args.push(query.batchId); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    return { items: this.db.all('SELECT * FROM coupons' + clause + ' ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?', ...args, pageSize, offset).map(row => this.dto(row)), page, pageSize, total: this.db.get('SELECT COUNT(*) AS n FROM coupons' + clause, ...args).n };
  }
  reveal(req) {
    const ids = req.body.couponIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) invalid('couponIds', '须为 1–100 个不同标识');
    return { items: ids.map(id => {
      const row = this.row(id);
      return row.state === 'redeemed' ? { id, unavailableReason: 'redeemed' } : { id, code: row.code };
    }) };
  }
  assertAvailable(row) {
    if (!row || row.state !== 'available' || row.disabledAt || row.expiresAt <= this.now()) throw new ApiError(409, 'COUPON_UNAVAILABLE', '优惠券已占用、核销、到期或停用，请移除或更换');
  }
  preview(value, printAmountFen) {
    if (value === undefined || (typeof value === 'string' && !value.trim())) return { coupon: null, discountAmountFen: 0 };
    const code = normalizeCode(value), row = this.db.get('SELECT * FROM coupons WHERE codeHash=?', codeHash(code));
    if (!row) throw new ApiError(400, 'COUPON_INVALID', '优惠兑换码无效');
    this.assertAvailable(row);
    return { coupon: this.snapshot(row), discountAmountFen: discountFor(row, printAmountFen) };
  }
  checkSnapshot(snapshot, totals) {
    if (!snapshot) return;
    const row = this.db.get('SELECT * FROM coupons WHERE id=?', snapshot.id);
    this.assertAvailable(row);
    if (r.fingerprint(snapshot) !== r.fingerprint(this.snapshot(row)) || discountFor(row, totals.printAmountFen) !== totals.discountAmountFen) throw new ApiError(409, 'COUPON_UNAVAILABLE', '优惠快照已失效，请重新报价');
  }
  reserve(snapshot, totals, orderId, actorId) {
    if (!snapshot) return;
    if (!this.db.inTransaction) throw new Error('Coupon reservation requires the order transaction');
    this.checkSnapshot(snapshot, totals);
    const result = this.db.run("UPDATE coupons SET state='reserved',reservedOrderId=?,version=version+1 WHERE id=? AND state='available' AND disabledAt IS NULL AND expiresAt>?", orderId, snapshot.id, this.now());
    if (result.changes !== 1) throw new ApiError(409, 'COUPON_UNAVAILABLE', '优惠券不可占用，请重新报价');
    this.event(this.row(snapshot.id), actorId, 'reserved', orderId);
  }
  redeem(orderId, actorId) {
    const row = this.db.get('SELECT * FROM coupons WHERE reservedOrderId=?', orderId);
    if (!row || row.state === 'redeemed') return;
    if (!this.db.inTransaction || row.state !== 'reserved') throw new Error('Invalid coupon redemption transaction');
    const result = this.db.run("UPDATE coupons SET state='redeemed',redeemedAt=?,version=version+1 WHERE id=? AND state='reserved' AND reservedOrderId=?", this.now(), row.id, orderId);
    if (result.changes !== 1) throw new ApiError(409, 'COUPON_UNAVAILABLE', '优惠券核销状态已改变');
    this.event(row, actorId, 'redeemed', orderId);
  }
  issueCompensation(orderId,actorId,policy) {
    if(!this.db.inTransaction)throw Error('Compensation requires the cancellation transaction');
    if(this.db.get('SELECT 1 FROM order_compensations WHERE orderId=?',orderId))throw new ApiError(409,'CONFLICT','该订单已发放取消补偿');
    const batchId=randomUUID(),createdAt=this.now(),expiresAt=new Date(Date.parse(createdAt)+policy.validDays*86400000).toISOString();
    const rule={type:policy.type,minPrintAmountFen:policy.minPrintAmountFen,payRatePercent:policy.payRatePercent,maxDiscountFen:policy.maxDiscountFen,reductionFen:null};
    this.db.run('INSERT INTO coupon_batches VALUES(?,?,?,?,?,?)',batchId,1,json(rule),createdAt,expiresAt,actorId);
    let coupon;
    for(let attempt=0;attempt<8;attempt++){
      const id=randomUUID(),code=newCode();
      try{this.db.run('INSERT INTO coupons(id,batchId,codeHash,code,type,minPrintAmountFen,payRatePercent,maxDiscountFen,reductionFen,createdAt,expiresAt,createdBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,batchId,codeHash(code),code,rule.type,rule.minPrintAmountFen,rule.payRatePercent,rule.maxDiscountFen,null,createdAt,expiresAt,actorId);coupon=this.row(id);break;}
      catch(error){if(!/UNIQUE constraint failed: coupons\.(code|codeHash)/.test(error.message))throw error;}
    }
    if(!coupon)throw new ApiError(503,'SERVICE_UNAVAILABLE','暂时无法生成补偿券，请重试');
    this.db.run('INSERT INTO order_compensations(orderId,couponId,policyId,type,payRatePercent,minPrintAmountFen,maxDiscountFen,validDays,issuedAt,expiresAt,issuedBy) VALUES(?,?,?,?,?,?,?,?,?,?,?)',orderId,coupon.id,policy.id,policy.type,policy.payRatePercent,policy.minPrintAmountFen,policy.maxDiscountFen,policy.validDays,createdAt,expiresAt,actorId);
    this.event(coupon,actorId,'issued',orderId,{source:'merchant_cancellation',policyId:policy.id});
    return coupon;
  }
  release(orderId, actorId, {source='merchant_review',automated=false}={}) {
    const row = this.db.get("SELECT * FROM coupons WHERE reservedOrderId=? AND state='reserved'", orderId);
    if (!row) return;
    if (!this.db.inTransaction) throw new Error('Coupon release requires the cancellation transaction');
    const result = this.db.run("UPDATE coupons SET state='available',reservedOrderId=NULL,version=version+1 WHERE id=? AND state='reserved' AND reservedOrderId=?", row.id, orderId);
    if (result.changes !== 1) throw new ApiError(409, 'COUPON_UNAVAILABLE', '优惠券释放状态已改变');
    this.event(row, actorId, automated?'released_user_cancellation':'released_no_receipt', orderId,{source,automated});
  }
  exceptionRow(id) { return this.db.get('SELECT * FROM order_coupon_exceptions WHERE orderId=?', id); }
  exception(id) {
    const row = this.exceptionRow(id);
    return row ? { hold: !!row.hold, reasons: JSON.parse(row.reasonsJson), detectedAt: row.detectedAt, resolution: row.resolution, resolvedAt: row.resolvedAt } : null;
  }
  hold(id) { return !!this.exceptionRow(id)?.hold; }
  history(id) {
    return this.db.all('SELECT id,type,reasonsJson,createdAt,actorId,note FROM coupon_exception_history WHERE orderId=? ORDER BY seq', id).map(({ reasonsJson, ...row }) => ({ ...row, reasons: JSON.parse(reasonsJson) }));
  }
  recordHistory(id, type, reasons, actorId, note) {
    this.db.run('INSERT INTO coupon_exception_history(id,orderId,type,reasonsJson,createdAt,actorId,note) VALUES(?,?,?,?,?,?,?)', randomUUID(), id, type, json(reasons), this.now(), actorId, note);
  }
  inspectOrder(id) {
    return this.db.tx(() => {
      const order = this.db.get('SELECT * FROM print_orders WHERE id=?', id);
      if (!order || ['completed','cancelled'].includes(order.lifecycle)) return order;
      const row = this.db.get("SELECT * FROM coupons WHERE reservedOrderId=? AND state='reserved'", id);
      if (!row) return order;
      const reasons = [...(row.expiresAt <= this.now() ? ['expired'] : []), ...(row.disabledAt ? ['disabled'] : [])];
      if (!reasons.length) return order;
      const old = this.exceptionRow(id), recorded = old ? JSON.parse(old.reasonsJson) : [];
      const added = reasons.filter(reason => !recorded.includes(reason));
      if (old && !added.length) return order;
      const all = ['expired','disabled'].filter(reason => reasons.includes(reason) || recorded.includes(reason));
      if (old) this.db.run('UPDATE order_coupon_exceptions SET hold=1,reasonsJson=?,resolution=NULL,resolvedAt=NULL,resolvedBy=NULL,resolutionNote=NULL WHERE orderId=?', json(all), id);
      else this.db.run('INSERT INTO order_coupon_exceptions(orderId,couponId,hold,reasonsJson,detectedAt) VALUES(?,?,1,?,?)', id, row.id, json(all), this.now());
      this.recordHistory(id, 'detected', all, null, '占用优惠券到期或停用，暂停业务推进');
      this.db.run('UPDATE print_orders SET version=version+1,updatedAt=? WHERE id=? AND version=?', this.now(), id, order.version);
      // The existing event table requires an actor FK; mark automatic detection explicitly.
      this.orders.event(order, { id: row.createdBy }, 'coupon_exception_detected', { couponId: row.id, reasons: all, addedReasons: added, automated: true, source: 'coupon_scan', resultingVersion: order.version + 1 });
      return this.db.get('SELECT * FROM print_orders WHERE id=?', id);
    });
  }
  scan() {
    for (const row of this.db.all("SELECT reservedOrderId FROM coupons WHERE state='reserved' AND (disabledAt IS NOT NULL OR expiresAt<=?)", this.now())) this.inspectOrder(row.reservedOrderId);
  }
  disable(req) {
    return this.orders.idempotent(req, `disable_coupon:${req.params.id}`, () => {
      const row = this.row(req.params.id); r.integer(req.body.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
      if (row.version !== req.body.expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', '优惠券已改变，请刷新后重试');
      const note = this.orders.reason(req,'coupon_disable');
      if (row.state === 'redeemed') throw new ApiError(409, 'COUPON_UNAVAILABLE', '已核销优惠券不能停用');
      if (!row.disabledAt) {
        this.db.run('UPDATE coupons SET disabledAt=?,version=version+1 WHERE id=? AND version=?', this.now(), row.id, row.version);
        this.event(row, req.user.id, 'disabled', row.reservedOrderId, { note,...req.reasonMeta });
      }
      if (row.reservedOrderId) this.inspectOrder(row.reservedOrderId);
      return this.dto(this.row(row.id));
    });
  }
  resolve(req) {
    return this.orders.idempotent(req, `coupon_resolution:${req.params.id}`, () => {
      const row = this.orders.owned(req.user, req.params.id); this.orders.requestVersion(row, req);
      const action = v.choice(req.body.action, ['continue','cancel'], 'action'), note = this.orders.reason(req,'coupon_'+action), exception = this.exceptionRow(row.id);
      if (!exception?.hold || !['active','cancel_requested'].includes(row.lifecycle)) throw new ApiError(409, 'CONFLICT', '当前订单没有可处理的优惠券异常');
      if(action==='cancel'){
        this.orders.cancellation.assert(row);
        const request=this.orders.cancellation.pending(row),origin=request?this.orders.cancellation.origin(request):'merchant';
        return this.orders.cancellation.complete(row,req.user,{request,origin,reason:note,source:'coupon_resolution'});
      }
      const reasons = JSON.parse(exception.reasonsJson);
      this.db.run('UPDATE order_coupon_exceptions SET hold=?,acceptedReasonsJson=?,resolution=?,resolvedAt=?,resolvedBy=?,resolutionNote=? WHERE orderId=?', action === 'continue' ? 0 : 1, action === 'continue' ? json(reasons) : exception.acceptedReasonsJson, action, this.now(), req.user.id, note, row.id);
      this.recordHistory(row.id, action, reasons, req.user.id, note);
      return this.orders.update(row, req.user, 'coupon_exception_resolved', {}, { action, reasons, note, acceptsOriginalDiscount: action === 'continue',...req.reasonMeta });
    });
  }
}
module.exports = { CouponService, normalizeCode, discountFor };
