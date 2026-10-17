'use strict';
const v = require('../validation');
const { ApiError, invalid, missing } = require('../errors');
const { uuid } = require('./rules');
const { OrderService } = require('./service');
module.exports = function registerOrders(context) {
  const { add, files, auth, config, sendArtifact } = context, service = new OrderService(context);
  context.orders = service; context.capabilities.orders = true;
  const noQuery = req => { if (Object.keys(req.query).length) invalid('query', '不支持查询参数'); };
  const page = req => { v.keys(req.query, ['page'], 'query'); const raw = req.query.page ?? '1'; if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalid('page', '页码须为正整数'); return Number(raw); };
  const write = (route, bodyKeys, handler, { role = 'admin', ...options } = {}) => add('post', route, { role, bodyKeys, ...options }, req => { noQuery(req); return handler(req); });
  add('get', '/print/config', {}, req => { noQuery(req); return service.printConfig(); });
  add('get','/admin/reason-catalog',{role:'admin'},req=>{noQuery(req);return require('./reasons').catalog();});
  add('get', '/me/print-defaults', { role: 'user' }, req => { noQuery(req); return service.defaults(req.user.id); });
  add('patch', '/me/print-defaults', { role: 'user', bodyKeys: ['buildingId','room','contact','notes','copies','duplex','receiptMethod','receiptNote'] }, req => { noQuery(req); return service.saveDefaults(req); });
  write('/print/quotes', ['items','couponCode'], req => service.createQuote(req), { role: 'user', status: 202 });
  add('get', '/print/quotes/:id', { role: 'user', transaction: false }, req => { noQuery(req); return service.quotes.refresh(req.user.id, req.params.id); });
  add('get', '/print/quotes/:id/items/:itemId/preview', { role: 'user', transaction: false, raw: true }, async (req, res) => {
    const productionPage = page(req); uuid(req.params.itemId, 'itemId'); const row = service.quotes.ready(req.user.id, req.params.id), item = JSON.parse(row.itemsJson).find(item => item.itemId === req.params.itemId); if (!item) missing();
    auth.rate(`preview:${req.user.id}`, config.rateLimits.previewUser, 60000, res);
    await sendArtifact(req, res, await files.openArtifactForRead({ actor: req.user, artifactId: item.printArtifactId, purpose: 'preview', page: productionPage }));
  });
  write('/orders', ['quoteId','quoteFingerprint','deliveryAddress','confirmedPreview','acceptedRules'], req => service.createOrder(req), { role: 'user', status: 201 });
  add('post', '/orders/recover', { role: 'user', transaction: false, bodyKeys: ['queryCode'] }, (req, res) => {
    noQuery(req); const id = service.access.recover(req, res); return service.detail(req.user, id, req.session);
  });
  add('get', '/me/orders', { role: 'user' }, req => service.listOrders(req.user, req.query, req.session));
  add('get', '/me/orders/:id', { role: 'user' }, req => { noQuery(req); return service.detail(req.user, req.params.id, req.session); });
  add('get', '/me/orders/:id/query-code', { role: 'user' }, req => { noQuery(req); return service.access.reveal(req.user, req.params.id, req.session); });
  add('get','/me/orders/:id/compensation-code',{role:'user'},req=>{noQuery(req);return service.cancellation.reveal(req);});
  add('get','/admin/compensation-policy',{role:'admin'},req=>{noQuery(req);return require('./cancellation').COMPENSATION_POLICY;});
  add('get', '/admin/orders/:id/query-code', { role: 'admin' }, req => { noQuery(req); return service.access.reveal(req.user, req.params.id, req.session); });
  add('get', '/admin/orders', { role: 'admin' }, req => service.listOrders(req.user, req.query));
  add('get', '/admin/orders/:id', { role: 'admin' }, req => { noQuery(req); return service.detail(req.user, req.params.id); });
  const orderBinary = purpose => async (req, res) => {
    const productionPage = purpose === 'preview' ? page(req) : (noQuery(req), 1); uuid(req.params.itemId, 'itemId');
    const { row } = service.access.resolve(req.user, req.params.id, req.session, 'files'), item = JSON.parse(row.itemsJson).find(item => item.itemId === req.params.itemId); if (!item) missing();
    if (purpose === 'preview') auth.rate(`preview:${req.user.id}`, config.rateLimits.previewUser, 60000, res);
    await sendArtifact(req, res, await files.openArtifactForRead({ actor: req.user, artifactId: item.printArtifactId, purpose, page: productionPage }), { attachment: purpose === 'production' });
  };
  add('get', '/me/orders/:id/items/:itemId/preview', { role: 'user', raw: true, transaction: false }, orderBinary('preview'));
  add('get', '/me/orders/:id/items/:itemId/file', { role: 'user', raw: true, transaction: false }, orderBinary('production'));
  add('get', '/admin/orders/:id/items/:itemId/print-file', { role: 'admin', raw: true, transaction: false }, orderBinary('production'));
  add('get', '/admin/orders/:id/items/:itemId/preview', { role: 'admin', raw: true, transaction: false }, orderBinary('preview'));
  write('/me/orders/:id/payment-submissions', ['expectedVersion','channel','reference','note'], req => service.paymentSubmission(req), { role: 'user' });
  write('/me/orders/:id/cancel-requests', ['expectedVersion','reason','reasonCode','reasonText'], req => service.cancelRequest(req), { role: 'user' });
  write('/me/feedback',['message','contactType','contactValue'],req=>service.createFeedback(req),{role:'user',status:201});
  write('/me/orders/:id/tickets', ['subject','message','feedbackType','contactType','contactValue'], req => service.createTicket(req), { role: 'user', status: 201 });
  add('get', '/me/orders/:id/tickets', { role: 'user' }, req => {
    service.access.resolve(req.user, req.params.id, req.session, 'tickets'); v.keys(req.query, ['page','pageSize','status'], 'query');
    return service.listTickets(req.user, { ...req.query, orderId: req.params.id }, req.session);
  });
  add('get', '/me/tickets', { role: 'user' }, req => service.listTickets(req.user, req.query, req.session));
  add('get', '/me/tickets/:id', { role: 'user' }, req => { noQuery(req); return service.ticket(req.user, req.params.id, req.session); });
  // Preflight commits detection even when a subsequent action is refused or rolled back.
  const couponWrite = (route, keys, handler) => write(route, keys, req => service.couponOperation(req, () => handler(req)), { transaction: false });
  write('/admin/orders/:id/payment-review', ['expectedVersion','action','amountFen','channel','reference','note','resolutionOutcome','reasonCode','reasonText'], req => {
    service.assertPaymentAction(req); // Reject the removed action before coupon preflight or cached success.
    return service.couponOperation(req,()=>service.paymentReview(req));
  },{transaction:false});
  couponWrite('/admin/orders/:id/fulfillment-action',['expectedVersion','action','actualDeliveryConfirmed','note','reasonCode','reasonText','pauseCode','independentCopiesConfirmed'],req=>service.fulfillment.action(req));
  couponWrite('/admin/orders/:id/production-action', ['expectedVersion','action','completedContentPages','note','independentCopiesConfirmed','actualCompletionConfirmed','reasonCode','reasonText'], req => service.productionAction(req));
  couponWrite('/admin/orders/:id/delivery-action', ['expectedVersion','action','note','actualDeliveryConfirmed','reasonCode','reasonText'], req => service.deliveryAction(req));
  couponWrite('/admin/orders/:id/coupon-resolution', ['expectedVersion','action','note','reasonCode','reasonText'], req => service.coupons.resolve(req));
  write('/admin/orders/:id/cancel-resolution', ['expectedVersion','action','note','settlement','noReceiptConfirmed','reasonCode','reasonText','compensate'], req => service.cancelResolution(req));
  write('/admin/coupon-batches', ['quantity','type','expiresAt','minPrintAmountFen','payRatePercent','maxDiscountFen','reductionFen'], req => service.coupons.createBatch(req), { status: 201 });
  add('get', '/admin/coupons', { role: 'admin' }, req => service.coupons.list(req.query));
  write('/admin/coupons/reveal-codes', ['couponIds'], req => service.coupons.reveal(req));
  write('/admin/coupons/:id/disable', ['expectedVersion','note','reasonCode','reasonText'], req => service.coupons.disable(req));
  write('/admin/orders/:id/refunds', ['expectedVersion','action','amountFen','reason','refundId','note','payoutReference','actualRefundConfirmed','fulfillmentDecision','reasonCode','reasonText'], req => service.refundAction(req));
  add('get', '/admin/dashboard', { role: 'admin' }, req => { noQuery(req); return service.dashboard(); });
  add('get', '/admin/users', { role: 'admin' }, req => service.users(req.query));
  add('get', '/admin/tickets', { role: 'admin' }, req => service.listTickets(req.user, req.query));
  add('get','/admin/tickets/:id',{role:'admin'},req=>{noQuery(req);return service.ticket(req.user,req.params.id);});
  write('/admin/tickets/:id/updates', ['expectedVersion','message','status'], req => service.updateTicket(req));
  add('get', '/admin/settings', { role: 'admin', transaction: false }, async req => { noQuery(req); await service.drainAssets(); return service.settings(); });
  add('patch', '/admin/settings', { role: 'admin', bodyKeys: ['expectedVersion','buildingLabel','acceptingOrders','serviceNotice','paymentInstructions','maintenance'] }, req => { noQuery(req); return service.updateSettings(req); });
  add('post', '/admin/payment-qr', { role: 'admin', multipart: true, transaction: false }, req => { noQuery(req); return service.replacePayment(req); });
  add('delete', '/admin/payment-qr', { role: 'admin', bodyKeys: ['expectedVersion'], transaction: false }, req => { noQuery(req); return service.clearPayment(req); });
  add('get', '/public/payment-qr', { raw: true, transaction: false }, async (req, res) => {
    noQuery(req); await sendArtifact(req,res,await service.payments.open());
  });
};
