'use strict';
const { randomUUID } = require('node:crypto');
const v = require('../validation');
const { ApiError, invalid, missing, conflict } = require('../errors');
const { user: userDto } = require('../entities');
const { QuoteService } = require('./quotes');
const { OrderAccess, recoveredOrder, recoveredTicket } = require('./access');
const { CouponService } = require('../coupons/service');
const { PaymentService } = require('../merchant/payments');
const ticketFields = require('../merchant/tickets');
const reasons = require('./reasons');
const { FulfillmentService } = require('./fulfillment');
const { CancellationService } = require('./cancellation');
const r = require('./rules');
const { RULES } = r;
const json = value => JSON.stringify(value);
class OrderService {
  constructor(context) {
    Object.assign(this, context); this.access = new OrderAccess(context); this.access.initialize();
    this.coupons = new CouponService({ ...context, orders: this });
    this.quotes = new QuoteService({ ...context, coupons: this.coupons });
    this.coupons.initialize();
    this.payments = new PaymentService({ ...context, orders:this });
    this.fulfillment = new FulfillmentService(this);
    this.cancellation = new CancellationService(this);
  }
  settingsRow() { return this.db.get('SELECT * FROM print_settings WHERE id=1'); }
  printConfig() {
    const row = this.settingsRow();
    return { paperSize: 'A4', colorMode: 'black_white', unitSheetPriceFen: 50, pricingVersion: RULES.pricingVersion, ...r.PRICING_RULES, minContentPages: 1, maxContentPages: 99, deliveryFeeFen: 0, currency: 'CNY',
      building: { id: RULES.buildingId, label: row.buildingLabel }, acceptingOrders: !!row.acceptingOrders, serviceNotice: row.serviceNotice,
      payment: this.payments.snapshot(), advertisementsEnabled:this.config.advertisementsEnabled,
      receiptMethods:[{code:'handover',label:'当面交付'},{code:'contact_first',label:'送达前联系'},{code:'doorstep',label:'放在房间门口'},{code:'other',label:'其他'}],
      fileRetentionDaysAfterCompletion: 7, temporaryUploadHours: 24, quoteValiditySeconds: 900, maxQuoteItems: RULES.maxQuoteItems, uploadLimits: this.config.limits, maintenance: this.maintenance() };
  }
  accepting() { const maintenance = this.maintenance(); if (maintenance.enabled) throw new ApiError(503, 'MAINTENANCE', maintenance.message || '系统维护中，请稍后重试'); if (!this.settingsRow().acceptingOrders) throw new ApiError(409, 'ORDERS_PAUSED', '已暂停接单；已有订单仍可处理'); }
  idempotent(req, operation, work) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) invalid('Idempotency-Key', '请提供 8–100 位字母、数字或 . _ : - 的幂等键');
    const requestHash = r.fingerprint(req.body), old = this.db.get('SELECT * FROM business_idempotency WHERE actorId=? AND operation=? AND key=?', req.user.id, operation, key);
    if (old) { if (old.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求'); return JSON.parse(old.resultJson); }
    const result = work();
    this.db.run('INSERT INTO business_idempotency VALUES(?,?,?,?,?,?)', req.user.id, operation, key, requestHash, json(result), this.now()); return result;
  }
  owned(actor, id) {
    r.uuid(id); const row = this.db.get('SELECT * FROM print_orders WHERE id=?', id);
    if (!row || (actor.role !== 'admin' && row.userId !== actor.id)) missing();
    if(actor.role==='admin'&&row.hiddenFromMerchant)throw new ApiError(404,'ORDER_HIDDEN_FROM_MERCHANT','该用户直接取消单已从商户订单中隐藏');
    return row;
  }
  version(row, expected) { r.integer(expected, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER); if (row.version !== expected) throw new ApiError(409, 'VERSION_CONFLICT', '订单已改变，请刷新最新记录后重试', { expectedVersion: String(row.version) }); }
  // Capture expiry/disable facts in a separate committed transaction before a business
  // action can throw. A caller holding the pre-detection version may still record a receipt.
  couponOperation(req, work) {
    const before = this.owned(req.user, req.params.id);
    const after = this.coupons.inspectOrder(before.id);
    req.couponPreflight = { beforeVersion: before.version, afterVersion: after.version };
    return this.db.tx(work);
  }
  requestVersion(row, req) {
    const { beforeVersion, afterVersion } = req.couponPreflight || { beforeVersion: row.version, afterVersion: row.version };
    this.version({ version: beforeVersion }, req.body.expectedVersion);
    this.version(row, afterVersion);
  }
  event(row, actor, type, data) { this.db.run('INSERT INTO order_events(id,orderId,actorId,type,createdAt,dataJson) VALUES(?,?,?,?,?,?)', randomUUID(), row.id, actor.id, type, this.now(), json(data)); }
  reason(req,operation,field='note') {
    const value=reasons.parse(req.body,operation,field);
    req.reasonMeta={reasonCode:value.code,reasonText:value.text,legacyReason:value.legacy};
    return reasons.text(value);
  }
  update(row, actor, type, changes, data = {}, session = null) {
    // Only an actual successful business decision may first record acceptance.
    // Migration/read projections never infer historical acceptance times.
    const next={...row,...changes};
    const acceptanceDecisions=['payment_confirmed','financial_exception_resolved','coupon_exception_resolved','fulfillment_resumed','production_start','production_retry','production_resume','refund_reject','refund_paid_out'];
    if(acceptanceDecisions.includes(type)&&!row.acceptedAt&&!changes.acceptedAt&&this.fulfillment.canDeliver(next,this.availability(next)))changes.acceptedAt=this.now();
    const columns = Object.keys(changes);
    const result = this.db.run(`UPDATE print_orders SET ${columns.map(key => `${key}=?`).concat('version=version+1','updatedAt=?').join(',')} WHERE id=? AND version=?`, ...Object.values(changes), this.now(), row.id, row.version);
    if (result.changes !== 1) conflict(); this.event(row, actor, type, { ...data, ...changes, resultingVersion: row.version + 1 });
    return this.detail(actor, row.id, session);
  }
  refunds(id) { return this.db.all('SELECT * FROM order_refunds WHERE orderId=? ORDER BY createdAt,id', id).map(({ payoutReferenceKey, ...row }) => row); }
  pendingRefund(id) { return !!this.db.get("SELECT id FROM order_refunds WHERE orderId=? AND status IN ('requested','approved')", id); }
  receipt(id) { const row = this.db.get('SELECT * FROM payment_receipts WHERE orderId=?', id); if (!row) return null; const { referenceKey, ...rest } = row; return rest; }
  paidRefunds(id) { return this.db.get("SELECT COALESCE(SUM(amountFen),0) AS n FROM order_refunds WHERE orderId=? AND status='paid_out'", id).n; }
  availability(row) {
    let availability = 'available';
    for (const item of JSON.parse(row.itemsJson)) {
      try { const value = this.files.getFile({ actor: { id: row.userId, role: 'user' }, fileId: item.fileId }).fileAvailability;
        if (value === 'deleted') return 'deleted'; if (value === 'expired') availability = 'expired'; }
      catch { availability = 'expired'; }
    }
    return availability;
  }
  display(row) {
    if (row.lifecycle === 'cancelled') return 'cancelled';
    if (row.lifecycle === 'cancel_requested') return 'cancel_requested';
    if (row.lifecycle === 'completed') return 'completed';
    if (row.financialHold) return 'financial_exception';
    if (this.pendingRefund(row.id)) return 'refund_pending';
    if (row.fulfillmentHold || row.refundFulfillmentHold || row.workflowHold || this.coupons.hold(row.id)) return 'fulfillment_paused';
    if (row.paymentStatus !== 'confirmed') return { unpaid: 'payment_pending', submitted: 'payment_review', rejected: 'payment_rejected' }[row.paymentStatus];
    if (row.productionStatus !== 'printed') return { not_started: 'awaiting_print', printing: 'printing', failed: 'print_failed' }[row.productionStatus];
    return { pending: 'awaiting_delivery', delivering: 'delivering', delivered: 'completed', failed: 'delivery_failed' }[row.deliveryStatus];
  }
  fulfillmentAllowed(row) { return row.lifecycle === 'active' && row.paymentStatus === 'confirmed' && !row.financialHold && !row.fulfillmentHold && !row.refundFulfillmentHold && !row.workflowHold && !this.coupons.hold(row.id) && !this.pendingRefund(row.id) && (this.receipt(row.id)?.amountFen || 0)>this.paidRefunds(row.id); }
  actions(actor, row, availability, accessType = actor.role === 'admin' ? 'admin' : 'owner') {
    const actions = actor.role === 'user' ? ['view_tickets','create_ticket'] : ['view_query_code','view_tickets'];
    if (accessType === 'recovered') {
      if (row.lifecycle === 'active' && !this.receipt(row.id) && ['unpaid','rejected'].includes(row.paymentStatus) && this.payments.snapshot().configured) actions.push('submit_payment');
      return actions;
    }
    if (actor.role === 'user') actions.push('view_query_code');
    if (availability === 'available') actions.push('preview','download');
    if (actor.role === 'user') {
      if (row.lifecycle === 'active' && !this.receipt(row.id) && ['unpaid','rejected'].includes(row.paymentStatus) && this.payments.snapshot().configured) actions.push('submit_payment');
      if (this.cancellation.userAllowed(row)) actions.push('request_cancel');
      if(this.cancellation.compensation(row,actor,accessType)?.canViewCode)actions.push('view_compensation_code');
      return actions;
    }
    if (!['completed','cancelled'].includes(row.lifecycle) && !this.receipt(row.id) && row.paymentStatus !== 'confirmed') actions.push('review_payment');
    if (this.db.get('SELECT 1 FROM financial_exceptions WHERE orderId=? AND resolvedAt IS NULL',row.id)) actions.push('resolve_financial_exception');
    if (this.coupons.hold(row.id) && ['active','cancel_requested'].includes(row.lifecycle)) actions.push('resolve_coupon_exception');
    const cancellation=this.cancellation.snapshot(row,actor,accessType);
    if (cancellation.merchantActions.includes('cancel')) actions.push('request_cancel_admin');
    if (cancellation.merchantActions.some(action=>['approve','reject'].includes(action))) actions.push('resolve_cancel');
    if (this.receipt(row.id) && this.paidRefunds(row.id) < this.receipt(row.id).amountFen) actions.push('request_refund');
    if (this.refunds(row.id).some(refund => refund.status === 'requested')) actions.push('approve_refund','reject_refund');
    if (this.refunds(row.id).some(refund => refund.status === 'approved')) actions.push('record_refund_paid');
    if (this.fulfillmentAllowed(row) && availability === 'available' && row.deliveryStatus !== 'failed') {
      if (row.productionStatus === 'not_started') actions.push('start_print');
      if (row.productionStatus === 'printing') actions.push('complete_print');
      if (row.productionStatus === 'failed') actions.push('retry_print');
    }
    if (row.productionStatus === 'printing' && !row.reprintActive && !['cancelled','completed'].includes(row.lifecycle)) actions.push('record_print_progress','fail_print');
    if ((row.fulfillmentHold || row.refundFulfillmentHold) && row.lifecycle === 'active' && row.paymentStatus === 'confirmed' && !row.financialHold && !this.coupons.hold(row.id) && !this.pendingRefund(row.id) && (this.receipt(row.id)?.amountFen || 0) > this.paidRefunds(row.id)) actions.push('resume_fulfillment');
    if (this.fulfillmentAllowed(row) && row.productionStatus === 'printed') {
      if (row.deliveryStatus === 'pending') actions.push('start_delivery');
      if (row.deliveryStatus === 'failed') actions.push('retry_delivery');
    }
    if (row.deliveryStatus === 'delivering' && !['cancelled','completed'].includes(row.lifecycle)) actions.push('fail_delivery');
    if (row.lifecycle === 'completed' && !row.financialHold && !row.fulfillmentHold && !row.refundFulfillmentHold && !row.workflowHold && !this.coupons.hold(row.id) && !this.pendingRefund(row.id) && availability === 'available' && (this.receipt(row.id)?.amountFen || 0)>this.paidRefunds(row.id)) {
      if (!row.reprintActive) actions.push('reprint');
      else if (row.productionStatus === 'printing') actions.push('complete_reprint');
      else if (row.productionStatus === 'failed') actions.push('retry_reprint');
    }
    if (row.lifecycle === 'completed' && row.reprintActive && row.productionStatus === 'printing') actions.push('record_reprint_progress','fail_reprint');
    for(const action of this.fulfillment.snapshot(row,actor,availability,accessType).allowedActions)if(!actions.includes(action))actions.push(action);
    return actions;
  }
  detail(actor, id, session = null) {
    const access = this.access.resolve(actor, id, session), accessType = access.accessType;
    const row = this.coupons.inspectOrder(id), fileAvailability = this.availability(row), receipt = this.receipt(id);
    const exceptions = this.db.all('SELECT * FROM financial_exceptions WHERE orderId=? ORDER BY createdAt,id', id);
    const refunds = this.refunds(id), actualRefundFen = this.paidRefunds(id);
    const lastSubmission = this.db.get('SELECT createdAt,channel FROM payment_submissions WHERE orderId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1',id);
    const dto = { id: row.id, orderNo: row.orderNo, userId: row.userId, user: userDto(this.db.get('SELECT * FROM users WHERE id=?', row.userId), this.activity), accessType,
      quoteId: row.quoteId, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, completedAt: row.completedAt,
      items: JSON.parse(row.itemsJson), totals: r.totalsDto(JSON.parse(row.totalsJson)), coupon: JSON.parse(row.couponSnapshotJson || 'null'), couponException: this.coupons.exception(id), deliveryAddress: JSON.parse(row.addressJson),
      payment: { status: row.paymentStatus, ...this.payments.snapshot(),
        lastSubmittedAt: lastSubmission?.createdAt || null, lastSubmittedChannel: lastSubmission?.channel || null,
        confirmedAt: receipt?.confirmedAt || null, confirmedChannel: receipt?.channel || null,
        returnReason:this.cancellation.returnReason(row),
        submissions: this.db.all('SELECT * FROM payment_submissions WHERE orderId=? ORDER BY createdAt,rowid', id), receipt, exceptions, financialHold: !!row.financialHold },
      production: { status: row.productionStatus, completedContentPages: row.productionProgress, attempt: row.productionAttempt, reprintActive: !!row.reprintActive, fulfillmentHold: !!(row.fulfillmentHold || row.refundFulfillmentHold || row.workflowHold) },
      fulfillment:this.fulfillment.snapshot(row,actor,fileAvailability,accessType),
      cancellation:this.cancellation.snapshot(row,actor,accessType),compensation:this.cancellation.compensation(row,actor,accessType),
      delivery: { status: row.deliveryStatus }, lifecycle: row.lifecycle, displayStatus: this.display(row), refunds, actualRefundFen,
      netReceivedFen: (receipt?.amountFen || 0) - actualRefundFen,
      cancellationRequests: this.db.all('SELECT * FROM cancellation_requests WHERE orderId=? ORDER BY createdAt,id', id), filesExpireAt: row.filesExpireAt, fileAvailability,
      allowedActions: this.actions(actor, row, fileAvailability, accessType), events: this.db.all('SELECT * FROM order_events WHERE orderId=? ORDER BY seq', id).map(({ dataJson, seq, ...event }) => ({ ...event, data: JSON.parse(dataJson) })) };
    if (actor.role === 'admin') dto.couponExceptionHistory = this.coupons.history(id);
    if(actor.role==='user'&&accessType==='owner'){
      const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
      if(dto.payment.receipt)dto.payment.receipt=pick(dto.payment.receipt,['id','orderId','amountFen','channel','confirmedAt']);
      dto.payment.exceptions=dto.payment.exceptions.map(item=>pick(item,['id','orderId','amountFen','createdAt','resolvedAt']));
      dto.refunds=dto.refunds.map(item=>({...item,payoutReference:null,payoutNote:null,decisionNote:null}));
      dto.events=dto.events.map(event=>{
        if(!['payment_rejected','payment_confirmed','payment_amount_exception','financial_exception_resolved','refund_requested','refund_approve','refund_reject','refund_paid_out'].includes(event.type))return event;
        const data={...event.data};for(const key of ['reference','payoutReference','note','reasonText','legacyReason'])delete data[key];
        return {...event,data};
      });
    }
    return accessType === 'recovered' ? recoveredOrder(dto) : dto;
  }
  createQuote(req) {
    const result = this.idempotent(req, 'create_quote', () => { this.accepting(); return this.quotes.create(req.user.id, req.body); });
    // A legacy POST retry must expose the price change rather than returning an
    // old processing response that no longer satisfies the current quote contract.
    if (result.pricingVersion !== RULES.pricingVersion || !result.pricingRules || r.fingerprint(result.pricingRules) !== r.fingerprint(r.PRICING_RULES)) return this.quotes.dto(this.quotes.row(req.user.id, result.id));
    return result;
  }
  createOrder(req) {
    return this.idempotent(req, 'create_order', () => {
      this.accepting(); const quote = this.quotes.ready(req.user.id, req.body.quoteId);
      if (req.body.confirmedPreview !== true) invalid('confirmedPreview', '请确认已检查生产预览与费用');
      if (req.body.acceptedRules !== undefined) r.bool(req.body.acceptedRules,'acceptedRules');
      if (req.body.quoteFingerprint !== quote.fingerprint) throw new ApiError(409, 'QUOTE_CONFIRMATION_MISMATCH', '确认内容与报价版本不一致，请重新检查生产预览');
      const deliveryAddress = r.address(req.body.deliveryAddress, this.settingsRow().buildingLabel), totals = JSON.parse(quote.totalsJson), items = JSON.parse(quote.itemsJson), id = randomUUID();
      if (!Number.isSafeInteger(totals.totalAmountFen) || totals.totalAmountFen <= 0) throw new ApiError(400, 'COUPON_ZERO_TOTAL', '优惠后应付须大于零');
      const createdAt = this.now(), orderNo = `CP${createdAt.slice(0,10).replaceAll('-','')}-${id.replaceAll('-','').slice(0,12).toUpperCase()}`;
      this.db.run('INSERT INTO print_orders(id,orderNo,userId,quoteId,createdAt,updatedAt,itemsJson,totalsJson,addressJson,totalAmountFen,contentPages,sheetCount,couponSnapshotJson) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, orderNo, req.user.id, quote.id, createdAt, createdAt, quote.itemsJson, quote.totalsJson, json(deliveryAddress), totals.totalAmountFen, totals.contentPages, totals.sheetCount, quote.couponSnapshotJson);
      this.coupons.reserve(JSON.parse(quote.couponSnapshotJson || 'null'), totals, id, req.user.id);
      this.access.ensureCode(id);
      this.files.claimForOrder({ orderId: id, userId: req.user.id, items });
      this.db.run('UPDATE print_quotes SET claimedOrderId=? WHERE id=?', id, quote.id);
      this.event({ id }, req.user, 'order_created', { quoteId: quote.id, quoteFingerprint: quote.fingerprint });
      return this.detail(req.user, id);
    });
  }
  paymentSubmission(req) {
    const access = this.access.resolve(req.user, req.params.id, req.session, 'payment');
    return this.idempotent(req, `payment_submission:${req.params.id}`, () => {
      const row = access.row; this.version(row, req.body.expectedVersion);
      const channel = this.payments.requireChannel(req.body.channel);
      if (!this.actions(req.user, row, this.availability(row), access.accessType).includes('submit_payment')) conflict('当前订单不能提交付款声明');
      const reference = r.optional(req.body.reference, 'reference', 160), note = r.optional(req.body.note, 'note', 500);
      const id = randomUUID(); this.db.run('INSERT INTO payment_submissions VALUES(?,?,?,?,?,?,?)', id, row.id, channel, reference, note, this.now(), req.user.id);
      return this.update(row, req.user, 'payment_submitted', { paymentStatus: 'submitted' }, { submissionId: id, channel, reference, note }, req.session);
    });
  }
  assertPaymentAction(req) {
    if(req.body.action==='flag_exception')throw new ApiError(410,'FINANCIAL_EXCEPTION_RECORDING_REMOVED','记录财务异常功能已删除，请使用退回付款核对',{action:'reject'});
  }
  paymentReview(req) {
    this.assertPaymentAction(req);
    return this.idempotent(req, `payment_review:${req.params.id}`, () => {
      const row = this.owned(req.user, req.params.id); this.requestVersion(row, req);
      const action = v.choice(req.body.action, ['confirm','reject','resolve_exception'], 'action');
      v.keys(req.body, ['expectedVersion','action',...(action === 'confirm' ? ['amountFen','channel','reference','note'] : action === 'resolve_exception' ? ['reasonCode','reasonText','note','resolutionOutcome'] : ['reasonCode'])]);
      const receipt=this.receipt(row.id);
      if (action === 'resolve_exception') {
        if (!this.db.get('SELECT 1 FROM financial_exceptions WHERE orderId=? AND resolvedAt IS NULL',row.id)) conflict('没有真实的待解决历史财务异常');
        const note = this.reason(req,'payment_resolve_exception');
        const resolutionOutcome = v.choice(req.body.resolutionOutcome ?? 'exact_receipt', ['exact_receipt','no_receipt'], 'resolutionOutcome');
        if (resolutionOutcome === 'exact_receipt' && (!receipt || receipt.amountFen!==row.totalAmountFen || row.paymentStatus !== 'confirmed')) conflict('未确认准确到账前不能按已到账解除财务锁；请先按准确金额确认');
        if (resolutionOutcome === 'no_receipt' && (receipt || row.paymentStatus === 'confirmed')) conflict('已有确认入账，不能用未到账结论抹去收款事实');
        this.db.run('UPDATE financial_exceptions SET resolvedAt=?,resolvedBy=?,resolution=? WHERE orderId=? AND resolvedAt IS NULL', this.now(), req.user.id, note, row.id);
        return this.update(row, req.user, 'financial_exception_resolved', { financialHold: 0 }, { note, resolutionOutcome,...req.reasonMeta });
      }
      if (['completed','cancelled'].includes(row.lifecycle) || receipt || row.paymentStatus === 'confirmed') conflict('订单已入账或已结束，不能再次记款或退回核对');
      if (action === 'reject') {
        const {RETURN_REASONS}=require('./cancellation'),reasonCode=v.choice(req.body.reasonCode,Object.keys(RETURN_REASONS),'reasonCode');
        return this.update(row, req.user, 'payment_rejected', { paymentStatus: 'rejected' }, { reasonCode,reasonText:'',note:RETURN_REASONS[reasonCode] });
      }
      const amountFen = r.integer(req.body.amountFen, 'amountFen', 0, 100000000), reference = v.string(req.body.reference, 'reference', { min: 1, max: 160 }), channel = v.choice(req.body.channel, ['wechat','alipay','other'], 'channel');
      if(amountFen!==row.totalAmountFen)throw new ApiError(409,'PAYMENT_AMOUNT_MISMATCH','实收金额与订单应付不符，请核实后使用退回付款核对',{amountFen:String(row.totalAmountFen),action:'reject'});
      const note=r.optional(req.body.note,'note',1000),key = r.referenceKey(reference);
      if (this.db.get('SELECT id FROM payment_receipts WHERE referenceKey=?', key)) throw new ApiError(409, 'TRANSACTION_ALREADY_RECORDED', '该外部交易标识已入账，不能重复用于其他订单');
      const id = randomUUID(); this.db.run('INSERT INTO payment_receipts VALUES(?,?,?,?,?,?,?,?,?)', id, row.id, amountFen, channel, reference, key, this.now(), req.user.id, note);
      this.coupons.redeem(row.id, req.user.id);
      const accepted=this.fulfillment.canDeliver({...row,paymentStatus:'confirmed'},this.availability(row));
      return this.update(row, req.user, 'payment_confirmed', { paymentStatus: 'confirmed',...(accepted&&!row.acceptedAt?{acceptedAt:this.now()}:{}) }, { receiptId: id, amountFen, channel, reference, note,accepted });
    });
  }
  cancelRequest(req) { return this.cancellation.userRequest(req); }
  cancelResolution(req) { return this.cancellation.merchantResolution(req); }
  requestCancellation(row, actor, note, origin = actor.role==='admin'?'merchant':'user') {
    const id = randomUUID();
    this.db.run("INSERT INTO cancellation_requests(id,orderId,reason,status,createdAt,createdBy,origin) VALUES(?,?,?,'requested',?,?,?)", id, row.id, note, this.now(), actor.id,origin);
    return id;
  }
  assertFiles(row) { for (const item of JSON.parse(row.itemsJson)) this.files.getOwnedReadyFile({ userId: row.userId, fileId: item.fileId, allowClaimedOrderId: row.id }); }
  productionAction(req) {
    return this.idempotent(req, `production:${req.params.id}`, () => {
      const row = this.owned(req.user, req.params.id); this.requestVersion(row, req);
      const action = v.choice(req.body.action, ['start','progress','fail','complete','retry','resume','reprint','reprint_progress','reprint_fail','reprint_complete','reprint_retry'], 'action');
      if(['start','complete','reprint_complete'].includes(action)&&(req.body.reasonCode!==undefined||req.body.reasonText!==undefined))invalid('reasonCode','正常操作无需异常原因');
      v.keys(req.body, ['expectedVersion','action','note','reasonCode','reasonText',...(['progress','fail','reprint_progress','reprint_fail'].includes(action) ? ['completedContentPages'] : ['complete','reprint_complete'].includes(action) ? ['actualCompletionConfirmed'] : ['retry','reprint_retry'].includes(action) ? ['independentCopiesConfirmed'] : [])]);
      const mapping = { start: 'start_print', progress: 'record_print_progress', fail: 'fail_print', complete: 'complete_print', retry: 'retry_print', resume: 'resume_fulfillment', reprint: 'reprint', reprint_progress: 'record_reprint_progress', reprint_fail: 'fail_reprint', reprint_complete: 'complete_reprint', reprint_retry: 'retry_reprint' };
      if (!['progress','fail','reprint_progress','reprint_fail'].includes(action) && this.coupons.hold(row.id)) throw new ApiError(409, 'COUPON_EXCEPTION_PENDING', '优惠券异常尚未处理，暂停打印与配送');
      if (!this.actions(req.user, row, this.availability(row)).includes(mapping[action])) conflict('当前付款、取消、退款或生产状态不允许此操作');
      if (action === 'resume') { const note=this.reason(req,'production_resume'); return this.update(row, req.user, 'fulfillment_resumed', row.fulfillmentHold?{fulfillmentHold:0}:{refundFulfillmentHold:0}, {note,...req.reasonMeta}); }
      if (!['progress','fail','reprint_progress','reprint_fail'].includes(action)) this.assertFiles(row);
      const note = ['start','complete','reprint_complete'].includes(action) ? r.optional(req.body.note, 'note', 1000) : this.reason(req,'production_'+action);
      let changes;
      if (['start','retry','reprint','reprint_retry'].includes(action)) {
        if (['retry','reprint_retry'].includes(action) && req.body.independentCopiesConfirmed !== true) invalid('independentCopiesConfirmed', '重试须核对已完成部分，避免重复打印；记录原因');
        changes = { productionStatus: 'printing', productionAttempt: row.productionAttempt + 1, reprintActive: action.startsWith('reprint') ? 1 : 0 };
        if (action === 'reprint') changes.productionProgress = 0;
      } else if (['progress','reprint_progress','fail','reprint_fail'].includes(action)) {
        const completedContentPages = r.integer(req.body.completedContentPages, 'completedContentPages', 0, row.contentPages);
        if (completedContentPages < row.productionProgress) invalid('completedContentPages', '实际完成进度不能倒退');
        changes = { productionProgress: completedContentPages, productionStatus: action.endsWith('fail') ? 'failed' : 'printing' };
      } else {
        if (req.body.actualCompletionConfirmed !== true) invalid('actualCompletionConfirmed', '必须确认实际打印完成，下载不代表完成');
        changes = { productionStatus: 'printed', productionProgress: row.contentPages, reprintActive: 0 };
      }
      return this.update(row, req.user, `production_${action}`, changes, { note, independentCopiesConfirmed: !!req.body.independentCopiesConfirmed,...req.reasonMeta });
    });
  }
  deliveryAction(req) {
    return this.idempotent(req, `delivery:${req.params.id}`, () => {
      const row = this.owned(req.user, req.params.id); this.requestVersion(row, req);
      const action = v.choice(req.body.action, ['start','fail','delivered','retry'], 'action'), mapping = { start: 'start_delivery', fail: 'fail_delivery', delivered: 'confirm_delivered', retry: 'retry_delivery' };
      if(['start','delivered'].includes(action)&&(req.body.reasonCode!==undefined||req.body.reasonText!==undefined))invalid('reasonCode','正常操作无需异常原因');
      v.keys(req.body, ['expectedVersion','action','note','reasonCode','reasonText',...(action === 'delivered' ? ['actualDeliveryConfirmed'] : [])]);
      if (action !== 'fail' && this.coupons.hold(row.id)) throw new ApiError(409, 'COUPON_EXCEPTION_PENDING', '优惠券异常尚未处理，暂停打印与配送');
      if (!this.actions(req.user, row, this.availability(row)).includes(mapping[action])) conflict('当前状态不能执行该配送操作');
      const note = ['fail','retry'].includes(action) ? this.reason(req,'delivery_'+action) : r.optional(req.body.note, 'note', 1000);
      if (action === 'delivered') {
        return this.fulfillment.deliver(req,row,'delivery_delivered');
      }
      return this.update(row, req.user, `delivery_${action}`, { deliveryStatus: action === 'fail' ? 'failed' : 'delivering' }, { note,...req.reasonMeta });
    });
  }
  refundAction(req) {
    return this.idempotent(req, `refund:${req.params.id}`, () => {
      const row = this.owned(req.user, req.params.id); this.version(row, req.body.expectedVersion);
      const action = v.choice(req.body.action, ['request','approve','reject','paid_out'], 'action'), receipt = this.receipt(row.id);
      v.keys(req.body, ['expectedVersion','action','reasonCode','reasonText',...(action === 'request' ? ['amountFen','reason'] : ['refundId','note','fulfillmentDecision',...(action === 'paid_out' ? ['payoutReference','actualRefundConfirmed'] : [])])]);
      if (!receipt) conflict('未确认收款，不能记录退款');
      let refund;
      if (action === 'request') {
        const amountFen = r.integer(req.body.amountFen, 'amountFen', 1, receipt.amountFen), reason = this.reason(req,'refund_request','reason');
        const reserved = this.db.get("SELECT COALESCE(SUM(amountFen),0) AS n FROM order_refunds WHERE orderId=? AND status IN ('requested','approved','paid_out')", row.id).n;
        if (amountFen + reserved > receipt.amountFen) throw new ApiError(409, 'REFUND_LIMIT', '退款金额加已申请或已退款金额不能超过实收');
        const id = randomUUID(); this.db.run("INSERT INTO order_refunds(id,orderId,status,amountFen,reason,createdAt,createdBy) VALUES(?,?,'requested',?,?,?,?)", id, row.id, amountFen, reason, this.now(), req.user.id);
        return this.update(row, req.user, 'refund_requested', {}, { refundId: id, amountFen, reason,...req.reasonMeta });
      }
      r.uuid(req.body.refundId, 'refundId'); refund = this.db.get('SELECT * FROM order_refunds WHERE id=? AND orderId=?', req.body.refundId, row.id); if (!refund) missing();
      const note = this.reason(req,'refund_'+action), decision = v.choice(req.body.fulfillmentDecision, ['resume','stop'], 'fulfillmentDecision');
      if (decision === 'resume' && this.paidRefunds(row.id) + (action === 'paid_out' ? refund.amountFen : 0) >= receipt.amountFen) conflict('全额实际退款后不能恢复履约');
      if (action === 'approve' || action === 'reject') {
        if (refund.status !== 'requested') conflict('退款申请已处理');
        this.db.run('UPDATE order_refunds SET status=?,decidedAt=?,decidedBy=?,decisionNote=?,fulfillmentDecision=? WHERE id=?', action === 'approve' ? 'approved' : 'rejected', this.now(), req.user.id, note, decision, refund.id);
        return this.update(row, req.user, `refund_${action}`, { refundFulfillmentHold: decision === 'stop' ? 1 : row.refundFulfillmentHold }, { refundId: refund.id, note, fulfillmentDecision: decision,...req.reasonMeta });
      }
      if (refund.status !== 'approved') conflict('只有已批准且未实际退款的记录可记实际退回');
      if (req.body.actualRefundConfirmed !== true) invalid('actualRefundConfirmed', '必须核实实际退款后记录');
      const reference = v.string(req.body.payoutReference, 'payoutReference', { min: 1, max: 160 }), key = r.referenceKey(reference);
      if (this.db.get('SELECT id FROM order_refunds WHERE payoutReferenceKey=?', key)) throw new ApiError(409, 'REFUND_TRANSACTION_ALREADY_RECORDED', '退款交易标识已记录');
      if (this.paidRefunds(row.id) + refund.amountFen > receipt.amountFen) throw new ApiError(409, 'REFUND_LIMIT', '累计实际退款不能超过实收');
      this.db.run("UPDATE order_refunds SET status='paid_out',paidAt=?,paidBy=?,payoutReference=?,payoutReferenceKey=?,payoutNote=?,fulfillmentDecision=? WHERE id=?", this.now(), req.user.id, reference, key, note, decision, refund.id);
      return this.update(row, req.user, 'refund_paid_out', { refundFulfillmentHold: decision === 'stop' ? 1 : row.refundFulfillmentHold }, { refundId: refund.id, amountFen: refund.amountFen, payoutReference: reference, note, fulfillmentDecision: decision,...req.reasonMeta });
    });
  }
  defaults(userId) {
    const row = this.db.get('SELECT * FROM print_defaults WHERE userId=?', userId);
    return row ? { buildingId: RULES.buildingId, room: row.room, contact: row.contact, notes: row.notes, receiptMethod:row.receiptMethod,receiptNote:row.receiptNote,copies: row.copies, duplex: !!row.duplex, updatedAt: row.updatedAt } : { buildingId: RULES.buildingId, room: '', contact: '', notes: '',receiptMethod:null,receiptNote:'', copies: 1, duplex: false, updatedAt: null };
  }
  saveDefaults(req) {
    const old = this.defaults(req.user.id), next = { ...old, ...req.body };
    if (next.buildingId !== RULES.buildingId) throw new ApiError(400, 'BUILDING_NOT_SUPPORTED', '仅配送本栋宿舍');
    const room = r.optional(next.room, 'room', 40), contact = r.optional(next.contact, 'contact', 120), notes = r.optional(next.notes, 'notes', 500), copies = r.integer(next.copies, 'copies'), duplex = r.bool(next.duplex, 'duplex');
    const receiptMethod=next.receiptMethod===null?null:v.choice(next.receiptMethod,['handover','contact_first','doorstep','other'],'receiptMethod'),receiptNote=r.optional(next.receiptNote,'receiptNote',500);
    if(receiptMethod==='contact_first'&&!contact)invalid('contact','送达前联系须填写联系方式');
    if(receiptMethod==='other'&&!receiptNote)invalid('receiptNote','其他接收方式须填写说明');
    this.db.run('INSERT INTO print_defaults(userId,room,contact,notes,copies,duplex,updatedAt,receiptMethod,receiptNote) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET room=excluded.room,contact=excluded.contact,notes=excluded.notes,copies=excluded.copies,duplex=excluded.duplex,updatedAt=excluded.updatedAt,receiptMethod=excluded.receiptMethod,receiptNote=excluded.receiptNote', req.user.id, room, contact, notes, copies, duplex ? 1 : 0, this.now(),receiptMethod,receiptNote); return this.defaults(req.user.id);
  }
  listOrders(actor, query, session = null) {
    v.keys(query, ['page','pageSize','q','status','fulfillmentStage','room','userId','from','to'], 'query'); const { page, pageSize, offset } = v.pagination(query);
    const args = [], where = [];
    const visible = this.access.visibleWhere(actor, session); where.push(visible.sql); args.push(...visible.args);
    if (query.userId !== undefined) { if (actor.role !== 'admin') invalid('userId', '不支持此查询参数'); r.uuid(query.userId, 'userId'); where.push('o.userId=?'); args.push(query.userId); }
    if (query.q !== undefined) { const q = '%' + v.string(query.q, 'q', { max: 120 }).replace(/[\\%_]/g, '\\$&') + '%';
      if (actor.role === 'admin') { where.push("(o.orderNo LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')"); args.push(q,q,q); }
      else { where.push("o.orderNo LIKE ? ESCAPE '\\'"); args.push(q); }
    }
    if (query.room !== undefined) { where.push("json_extract(o.addressJson,'$.room')=?"); args.push(v.string(query.room, 'room', { min: 1, max: 40 })); }
    for (const key of ['from','to']) if (query[key] !== undefined) { if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query[key]) || Number.isNaN(Date.parse(query[key]))) invalid(key, '使用 UTC ISO 时间'); where.push(`o.createdAt${key === 'from' ? '>=' : '<='}?`); args.push(query[key]); }
    if (query.from && query.to && query.from > query.to) invalid('to', '结束时间不能早于开始时间');
    // Status precedence is computed centrally, including financial and refund locks. Select IDs, then paginate the matching set.
    let rows = this.db.all(`SELECT o.id FROM print_orders o JOIN users u ON u.id=o.userId ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY o.createdAt DESC,o.id DESC`, ...args);
    if (query.status !== undefined) { v.choice(query.status, r.DISPLAY_STATUSES, 'status'); rows = rows.filter(item => this.display(this.coupons.inspectOrder(item.id)) === query.status); }
    if(query.fulfillmentStage!==undefined){v.choice(query.fulfillmentStage,['pending_acceptance','in_progress','paused','completed','cancelled'],'fulfillmentStage');rows=rows.filter(item=>{const row=this.coupons.inspectOrder(item.id);return this.fulfillment.snapshot(row,actor,this.availability(row),actor.role==='admin'?'admin':'owner').stage===query.fulfillmentStage;});}
    return { items: rows.slice(offset, offset + pageSize).map(item => this.detail(actor, item.id, session)), page, pageSize, total: rows.length };
  }
  ticket(actor, id, session = null) {
    r.uuid(id); const row = this.db.get('SELECT * FROM order_tickets WHERE id=?', id);
    if(!row){
      const feedback=this.db.get('SELECT * FROM general_feedback WHERE id=?',id);
      if(!feedback||(actor.role!=='admin'&&feedback.userId!==actor.id))missing();
      return {...ticketFields.project(feedback,actor),category:'general',orderId:null,orderNo:null,feedbackType:'other',updates:this.db.all('SELECT id,authorId,message,status,createdAt FROM general_feedback_updates WHERE feedbackId=? ORDER BY seq',id)};
    }
    const { accessType } = this.access.resolve(actor, row.orderId, session, 'tickets');
    const dto = { ...ticketFields.project(row,actor), category:'order', orderNo: this.db.get('SELECT orderNo FROM print_orders WHERE id=?', row.orderId).orderNo, updates: this.db.all('SELECT id,authorId,message,status,createdAt FROM ticket_updates WHERE ticketId=? ORDER BY seq', id) };
    return accessType === 'recovered' ? recoveredTicket(dto) : dto;
  }
  createTicket(req) {
    const { row } = this.access.resolve(req.user, req.params.id, req.session, 'tickets');
    const result = this.idempotent(req, `create_ticket:${req.params.id}`, () => {
      const subject = v.string(req.body.subject, 'subject', { min: 1, max: 120 }), message = v.string(req.body.message, 'message', { min: 1, max: 4000 }), id = randomUUID();
      const { feedbackType, contactType, contactValue } = ticketFields.fields(req.body);
      this.db.run("INSERT INTO order_tickets(id,orderId,userId,subject,status,version,createdAt,updatedAt,feedbackType,contactType,contactValue) VALUES(?,?,?,?,'open',1,?,?,?,?,?)", id, row.id, row.userId, subject, this.now(), this.now(), feedbackType, contactType, contactValue);
      this.db.run("INSERT INTO ticket_updates(id,ticketId,authorId,message,status,createdAt) VALUES(?,?,?,?,'open',?)", randomUUID(), id, req.user.id, message, this.now());
      this.event(row, req.user, 'ticket_created', { ticketId: id }); return this.ticket(req.user, id, req.session);
    });
    return this.ticket(req.user,result.id,req.session);
  }
  createFeedback(req){
    const result=this.idempotent(req,'create_general_feedback',()=>{
      const message=v.string(req.body.message,'message',{min:1,max:4000}),subject=message.slice(0,120),id=randomUUID();
      const {contactType,contactValue}=ticketFields.fields(req.body),now=this.now();
      this.db.run('INSERT INTO general_feedback(id,userId,subject,createdAt,updatedAt,contactType,contactValue) VALUES(?,?,?,?,?,?,?)',id,req.user.id,subject,now,now,contactType,contactValue);
      this.db.run("INSERT INTO general_feedback_updates(id,feedbackId,authorId,message,status,createdAt) VALUES(?,?,?,?,'open',?)",randomUUID(),id,req.user.id,message,now);
      return this.ticket(req.user,id,req.session);
    });
    return this.ticket(req.user,result.id,req.session);
  }
  listTickets(actor, query, session = null) {
    v.keys(query, ['page','pageSize','status','orderId','category',...(actor.role === 'admin' ? ['feedbackType'] : [])], 'query'); const { page, pageSize, offset } = v.pagination(query), where = [], args = [];
    const visible = this.access.visibleWhere(actor, session);
    if(actor.role==='admin')where.push('1=1');
    else {where.push(`((t.category='general' AND t.userId=?) OR (t.category='order' AND ${visible.sql}))`);args.push(actor.id,...visible.args);}
    if(query.category!==undefined){where.push('t.category=?');args.push(v.choice(query.category,['order','general'],'category'));}
    if (query.status !== undefined) { where.push('t.status=?'); args.push(v.choice(query.status, ['open','in_progress','resolved'], 'status')); }
    if (query.feedbackType !== undefined) { where.push('t.feedbackType=?'); args.push(v.choice(query.feedbackType,ticketFields.FEEDBACK_TYPES,'feedbackType')); }
    if (query.orderId !== undefined) { this.access.resolve(actor, query.orderId, session, 'tickets'); where.push('t.orderId=?'); args.push(query.orderId); }
    const clause = "FROM (SELECT id,orderId,userId,status,feedbackType,createdAt,'order' AS category FROM order_tickets UNION ALL SELECT id,NULL AS orderId,userId,status,'other' AS feedbackType,createdAt,'general' AS category FROM general_feedback) t LEFT JOIN print_orders o ON o.id=t.orderId WHERE "+where.join(' AND '), total = this.db.get(`SELECT COUNT(*) AS n ${clause}`, ...args).n;
    return { items: this.db.all(`SELECT t.id ${clause} ORDER BY t.createdAt DESC,t.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset).map(row => this.ticket(actor, row.id, session)), page, pageSize, total };
  }
  updateTicket(req) {
    return this.idempotent(req, `ticket_update:${req.params.id}`, () => {
      const ticket = this.ticket(req.user, req.params.id); r.integer(req.body.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
      if (ticket.version !== req.body.expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT', '工单已更新，请刷新');
      const message = v.string(req.body.message, 'message', { min: 1, max: 4000 }), status = v.choice(req.body.status, ['open','in_progress','resolved'], 'status');
      if(ticket.category==='general'){
        this.db.run('INSERT INTO general_feedback_updates(id,feedbackId,authorId,message,status,createdAt) VALUES(?,?,?,?,?,?)',randomUUID(),ticket.id,req.user.id,message,status,this.now());
        this.db.run('UPDATE general_feedback SET status=?,version=version+1,updatedAt=? WHERE id=?',status,this.now(),ticket.id);
      }else{
        this.db.run('INSERT INTO ticket_updates(id,ticketId,authorId,message,status,createdAt) VALUES(?,?,?,?,?,?)', randomUUID(), ticket.id, req.user.id, message, status, this.now());
        this.db.run('UPDATE order_tickets SET status=?,version=version+1,updatedAt=? WHERE id=?', status, this.now(), ticket.id);
        this.event({ id: ticket.orderId }, req.user, 'ticket_updated', { ticketId: ticket.id, status });
      }
      return this.ticket(req.user, ticket.id);
    });
  }
  users(query) {
    v.keys(query, ['page','pageSize','q'], 'query'); const { page, pageSize, offset } = v.pagination(query), args = [];
    const where = query.q === undefined ? "WHERE role='admin'" : "WHERE role='admin' AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')";
    if (query.q !== undefined) { const q = '%'+v.string(query.q, 'q', { max: 120 }).replace(/[\\%_]/g, '\\$&')+'%'; args.push(q,q); }
    return { items: this.db.all(`SELECT * FROM users ${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset).map(row => ({ ...userDto(row, this.activity), orderCount: this.db.get('SELECT COUNT(*) AS n FROM print_orders WHERE userId=?', row.id).n })), page, pageSize, total: this.db.get(`SELECT COUNT(*) AS n FROM users ${where}`, ...args).n };
  }
  dashboard() {
    this.coupons.scan();
    const orders = this.db.all('SELECT * FROM print_orders WHERE hiddenFromMerchant=0'), statuses = orders.map(row => this.display(row));
    const confirmedReceivedFen = this.db.get('SELECT COALESCE(SUM(amountFen),0) AS n FROM payment_receipts').n, actualRefundFen = this.db.get("SELECT COALESCE(SUM(amountFen),0) AS n FROM order_refunds WHERE status='paid_out'").n;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.config.clock());
    const start = new Date(`${day}T00:00:00+08:00`).toISOString(), end = new Date(Date.parse(start)+86400000).toISOString();
    const todayReceivedFen = this.db.get('SELECT COALESCE(SUM(amountFen),0) AS n FROM payment_receipts WHERE confirmedAt>=? AND confirmedAt<?', start,end).n;
    const todayRefundFen = this.db.get("SELECT COALESCE(SUM(amountFen),0) AS n FROM order_refunds WHERE status='paid_out' AND paidAt>=? AND paidAt<?", start,end).n;
    return { totalOrders: orders.length, awaitingPaymentReview: statuses.filter(status => status === 'payment_review').length,
      awaitingPrint: statuses.filter(status => status === 'awaiting_print').length, awaitingDelivery: statuses.filter(status => ['awaiting_delivery','delivering'].includes(status)).length,
      fulfillmentCounts:Object.fromEntries(['pending_acceptance','in_progress','paused','completed','cancelled'].map(stage=>[stage,orders.filter(row=>this.fulfillment.snapshot(row,{role:'admin'},this.availability(row),'admin').stage===stage).length])),
      exceptions: orders.filter(row => row.financialHold || row.fulfillmentHold || row.refundFulfillmentHold || row.workflowHold || this.coupons.hold(row.id) || this.pendingRefund(row.id) || row.lifecycle === 'cancel_requested' || row.productionStatus === 'failed' || row.deliveryStatus === 'failed').length,
      confirmedReceivedFen, actualRefundFen, netReceivedFen: confirmedReceivedFen - actualRefundFen, today: { date: day, confirmedReceivedFen: todayReceivedFen, actualRefundFen: todayRefundFen, netReceivedFen: todayReceivedFen-todayRefundFen },
      userCount: this.db.get("SELECT COUNT(*) AS n FROM users WHERE role='user'").n, activeUsers: this.db.all("SELECT * FROM users WHERE role='user' ORDER BY lastActiveAt DESC,id LIMIT 5").map(row => userDto(row, this.activity)),
      acceptingOrders: !!this.settingsRow().acceptingOrders, paymentConfigured: this.payments.snapshot().configured, maintenance: this.maintenance(), cleanup: this.files.cleanupStatus() };
  }
  settings() {
    const row = this.settingsRow(); return { version: row.version, ...this.printConfig(), updatedAt: row.updatedAt, updatedBy: row.updatedBy,
      paymentAssetCleanup: this.db.all('SELECT assetId,attempts,lastError FROM payment_asset_cleanup ORDER BY queuedAt,assetId') };
  }
  settingsVersion(value) { r.integer(value, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER); if (value !== this.settingsRow().version) throw new ApiError(409, 'VERSION_CONFLICT', '经营设置已改变，请刷新后重试'); }
  updateSettings(req) {
    this.settingsVersion(req.body.expectedVersion); const old = this.settingsRow(), body = req.body;
    const label = body.buildingLabel === undefined ? old.buildingLabel : v.string(body.buildingLabel, 'buildingLabel', { min: 1, max: 80 });
    const accepting = body.acceptingOrders === undefined ? !!old.acceptingOrders : r.bool(body.acceptingOrders, 'acceptingOrders');
    const notice = body.serviceNotice === undefined ? old.serviceNotice : r.optional(body.serviceNotice, 'serviceNotice', 2000), instructions = body.paymentInstructions === undefined ? old.paymentInstructions : r.optional(body.paymentInstructions, 'paymentInstructions', 1000);
    if (body.maintenance !== undefined) { v.keys(body.maintenance, ['enabled','message'], 'maintenance'); const enabled = r.bool(body.maintenance.enabled, 'maintenance.enabled'), message = r.optional(body.maintenance.message, 'maintenance.message', 500); this.db.run('UPDATE maintenance SET enabled=?,message=?,updatedAt=? WHERE id=1', enabled ? 1 : 0, message, this.now()); }
    this.db.run('UPDATE print_settings SET buildingLabel=?,acceptingOrders=?,serviceNotice=?,paymentInstructions=?,version=version+1,updatedAt=?,updatedBy=? WHERE id=1', label, accepting ? 1 : 0, notice, instructions, this.now(), req.user.id); return this.settings();
  }
  async drainAssets() { return this.payments.drain(); }
  async replacePayment(req) { return this.payments.replace(req); }
  async clearPayment(req) { return this.payments.clear(req); }
}
module.exports = { OrderService };
