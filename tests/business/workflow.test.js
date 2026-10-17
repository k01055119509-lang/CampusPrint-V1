'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { isolated, PROJECT, TEST_PASSWORD } = require('../helpers/runtime');
const h = require('./helpers');

test('真实业务接口：报价、收款、异常、履约、售后与七天清理', async t => {
  let instant = new Date('2026-10-14T04:00:00.000Z');
  // This retention regression explicitly exercises original account re-login after seven days.
  const runtime = await isolated({ clock: () => new Date(instant), studentAccountsEnabled: true }); t.after(() => runtime.destroy());
  const { user, other, admin } = await h.actors(runtime); let q, source, value, completedAt, expiresAt;
  await t.test('正式配置收款图片为空；权限与 CSRF 隔离', async () => {
    const cfg = h.data(await user.request('GET', '/api/print/config'));
    assert.deepEqual(cfg.payment, { configured: false, qrUrl: null, instructions: '',
      channels: ['wechat','alipay'].map(channel=>({channel,configured:false,available:false,imageUrl:null})),
      legacy:{configured:false,available:false,imageUrl:null} });
    assert.equal((await user.request('GET', '/api/public/payment-qr')).body.error.code, 'PAYMENT_NOT_CONFIGURED');
    assert.equal((await user.request('GET', '/api/admin/orders')).status, 403);
    assert.equal((await user.request('GET', '/api/admin/settings')).status, 403);
    assert.equal((await user.request('PATCH', '/api/me/print-defaults', { room: '101' }, { headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
  });
  await t.test('100 页来源选 1、2、100 页；异步确定生产版本与预览', async () => {
    source = await h.upload(runtime, user, 'source-100-pages.pdf'); q = await h.quote(runtime, user, source, { pages: '100,2,1', copies: 3, duplex: true });
    assert.deepEqual(q.items[0].pageNumbers, [1,2,100]); assert.equal(q.contentPages, 9); assert.equal(q.sheetCount, 6); assert.equal(q.totalAmountFen, 420);
    const preview = await user.request('GET', `/api/print/quotes/${q.id}/items/${q.items[0].itemId}/preview?page=2`, undefined, { raw: true });
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('x-print-artifact-sha256'), q.items[0].printArtifactSha256);
    assert.equal((await other.request('GET', `/api/print/quotes/${q.id}`)).status, 404);
    assert.equal((await other.request('GET', `/api/print/quotes/${q.id}/items/${q.items[0].itemId}/preview`)).status, 404);
  });
  await t.test('金额篡改、错误确认、本栋/房间规则与重复提交', async () => {
    assert.equal((await h.post(user, '/api/orders', { ...h.orderBody(q), totalAmountFen: 1 })).status, 400);
    assert.equal((await h.post(user, '/api/orders', h.orderBody(q, { quoteFingerprint: 'a'.repeat(64) }))).body.error.code, 'QUOTE_CONFIRMATION_MISMATCH');
    assert.equal((await h.post(user, '/api/orders', h.orderBody(q, { deliveryAddress: { buildingId: 'other-dorm', room: '101' } }))).body.error.code, 'BUILDING_NOT_SUPPORTED');
    assert.equal((await h.post(user, '/api/orders', h.orderBody(q, { deliveryAddress: { buildingId: 'local-dorm', room: ' ' } }))).status, 400);
    const headers = h.key(); const body = h.orderBody(q);
    const [first, second] = await Promise.all([h.post(user, '/api/orders', body, headers),h.post(user, '/api/orders', body, headers)]);
    value = h.data(first,201); assert.deepEqual(second.body, first.body); assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM print_orders').n, 1);
    assert.equal((await h.post(user, '/api/orders', { ...body, deliveryAddress: { ...body.deliveryAddress, room: '102' } }, headers)).body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await h.post(user, '/api/orders', body)).body.error.code, 'QUOTE_ALREADY_USED');
    assert.equal((await h.post(user, '/api/print/quotes', { items: [{ fileId: source.id, pages: '1', copies: 1, duplex: false }] })).body.error.code, 'FILE_ALREADY_CLAIMED');
    assert.equal((await other.request('GET', `/api/me/orders/${value.id}`)).status, 404);
    assert.equal((await other.request('GET', `/api/me/orders/${value.id}/items/${value.items[0].itemId}/file`)).status, 404);
  });
  await t.test('默认信息和楼栋名称只影响未来填写，不能回写快照', async () => {
    const result = h.data(await user.request('PATCH', '/api/me/print-defaults', { room: '新房间', contact: '', copies: 2, duplex: true })); assert.equal(result.room, '新房间');
    const settings = h.data(await admin.request('GET', '/api/admin/settings'));
    h.data(await admin.request('PATCH', '/api/admin/settings', { expectedVersion: settings.version, buildingLabel: '测试楼栋' }));
    const latest = h.data(await user.request('GET', `/api/me/orders/${value.id}`)); assert.equal(latest.deliveryAddress.room, 'B-测试房间'); assert.equal(latest.deliveryAddress.buildingLabel, '本栋宿舍'); assert.equal(latest.version, value.version);
  });
  await t.test('收款码为空时拒绝学生声明且不可打印；隔离配置真实图片处理', async () => {
    assert.equal((await h.post(user, `/api/me/orders/${value.id}/payment-submissions`, { expectedVersion: value.version, channel: 'other', reference: '软件测试' })).body.error.code, 'PAYMENT_NOT_CONFIGURED');
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/production-action`, { expectedVersion: value.version, action: 'start' })).status, 409);
    h.data(await h.paymentQr(admin)); const publicImage = await user.request('GET', '/api/public/payment-qr', undefined, { raw: true }); assert.equal(publicImage.status, 200); assert.equal(publicImage.headers.get('content-type'), 'image/png'); assert.match(publicImage.headers.get('cache-control'), /no-store/);
    value = h.data(await h.post(user, `/api/me/orders/${value.id}/payment-submissions`, { expectedVersion: value.version, channel: 'other', reference: '软件测试声明', note: '模拟声明未真实付款' }));
    assert.equal(value.payment.status, 'submitted'); assert.equal(value.displayStatus, 'payment_review'); assert.equal(value.payment.receipt, null);
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/production-action`, { expectedVersion: value.version, action: 'start' })).status, 409);
  });
  await t.test('金额不符无新异常；旧异常精确确认后显式解除；重复确认幂等', async () => {
    const mismatch=await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,{expectedVersion:value.version,action:'confirm',amountFen:419,channel:'other',reference:'MISMATCH-SOFTWARE'});assert.equal(mismatch.body.error.code,'PAYMENT_AMOUNT_MISMATCH');assert.equal(runtime.db.get('SELECT count(*) n FROM financial_exceptions').n,0);value=h.legacyFinancial(runtime,value);
    assert.equal(value.payment.status, 'rejected'); assert.equal(value.payment.financialHold, true); assert.equal(value.payment.receipt, null);
    value = await h.confirm(admin, value, { reference: 'TEST-UNIQUE-RECEIPT' }); assert.equal(value.payment.status, 'confirmed'); assert.equal(value.payment.financialHold, true); assert(!value.allowedActions.includes('start_print'));
    const headers = h.key(), body = { expectedVersion: value.version, action: 'resolve_exception', note: '核对模拟补足到账，允许生产' };
    const first = await h.post(admin, `/api/admin/orders/${value.id}/payment-review`, body, headers); value = h.data(first);
    assert.deepEqual((await h.post(admin, `/api/admin/orders/${value.id}/payment-review`, body, headers)).body, first.body);
    assert.equal(value.payment.financialHold, false); assert(value.allowedActions.includes('start_print'));
    assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM payment_receipts WHERE orderId=?', value.id).n, 1);
  });
  await t.test('生产下载与报价预览同版本；仅含单份已选内容；下载不改变状态', async () => {
    const response = await admin.request('GET', `/api/admin/orders/${value.id}/items/${value.items[0].itemId}/print-file`, undefined, { raw: true });
    assert.equal(response.status, 200); assert.equal(createHash('sha256').update(response.body).digest('hex'), q.items[0].printArtifactSha256);
    const pdf = await PDFDocument.load(response.body); assert.equal(pdf.getPageCount(),3);
    assert.equal(h.data(await admin.request('GET', `/api/admin/orders/${value.id}`)).production.status, 'not_started');
    const preview = await admin.request('GET', `/api/admin/orders/${value.id}/items/${value.items[0].itemId}/preview`, undefined, { raw: true }); assert.equal(preview.headers.get('x-print-artifact-sha256'), q.items[0].printArtifactSha256);
  });
  await t.test('生产进度/缺纸失败/重试，配送失败不完成', async () => {
    value = await h.action(admin, value, 'production-action', { action: 'start' }); assert.equal(value.completedAt, null);
    value = await h.action(admin, value, 'production-action', { action: 'progress', completedContentPages: 3, note: '软件模拟第一份完成' });
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/production-action`, { expectedVersion: value.version, action: 'progress', completedContentPages: 2, note: '进度倒退' })).status, 400);
    value = await h.action(admin, value, 'production-action', { action: 'fail', completedContentPages: 3, note: '软件模拟缺纸' });
    assert.equal(value.displayStatus,'print_failed');
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/production-action`, { expectedVersion: value.version, action: 'retry', note: '补纸' })).status, 400);
    value = await h.action(admin, value, 'production-action', { action: 'retry', note: '核对仅剩余两份', independentCopiesConfirmed: true });
    value = await h.action(admin, value, 'production-action', { action: 'complete', actualCompletionConfirmed: true });
    value = await h.action(admin, value, 'delivery-action', { action: 'start' }); value = await h.action(admin, value, 'delivery-action', { action: 'fail', note: '软件模拟未能接收' });
    assert.equal(value.completedAt,null); assert.equal(value.filesExpireAt,null); assert.equal(value.lifecycle,'active'); assert.equal(value.displayStatus,'delivery_failed');
  });
  await t.test('实际送达原子写首次完成和七天；重复操作不延长', async () => {
    value = await h.action(admin, value, 'delivery-action', { action: 'retry', note: '软件模拟再次配送' });
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/delivery-action`, { expectedVersion: value.version, action: 'delivered' })).status, 400);
    const headers = h.key(), body = { expectedVersion: value.version, action: 'delivered', actualDeliveryConfirmed: true, note: '软件模拟实际送达' };
    const first = await h.post(admin, `/api/admin/orders/${value.id}/delivery-action`, body, headers); value = h.data(first); completedAt = value.completedAt; expiresAt = value.filesExpireAt;
    assert.equal(completedAt, instant.toISOString()); assert.equal(Date.parse(expiresAt)-Date.parse(completedAt), 7*86400000);
    instant = new Date(instant.getTime()+1000); assert.deepEqual((await h.post(admin, `/api/admin/orders/${value.id}/delivery-action`, body, headers)).body,first.body);
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/delivery-action`, { ...body,expectedVersion: value.version })).status,409);
    assert.equal(h.data(await user.request('GET', `/api/files/${source.id}`)).expiresAt, expiresAt);
    assert(runtime.db.all('SELECT expiresAt FROM artifacts WHERE fileId=?', source.id).every(row => row.expiresAt === expiresAt));
  });
  await t.test('售后文字与部分退款保留收款/送达事实；批准不等于实退', async () => {
    const ticket = h.data(await h.post(user, `/api/me/orders/${value.id}/tickets`, { subject: '软件测试售后', message: '测试文字记录保留' }),201);
    assert.equal((await other.request('GET', `/api/me/tickets/${ticket.id}`)).status,404);
    const updatedTicket = h.data(await h.post(admin, `/api/admin/tickets/${ticket.id}/updates`, { expectedVersion: ticket.version, status: 'resolved', message: '软件测试回复关闭，不自动退款' })); assert.equal(updatedTicket.status,'resolved'); assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM order_refunds').n,0);
    value = await h.action(admin, value, 'refunds', { action:'request', amountFen: 100, reason:'软件模拟部分退款' }); const refundId = value.refunds[0].id;
    value = await h.action(admin, value, 'refunds', { action:'approve', refundId, note:'批准软件模拟退款，保留剩余履约', fulfillmentDecision:'resume' }); assert.equal(value.actualRefundFen,0);
    value = await h.action(admin, value, 'refunds', { action:'paid_out', refundId, note:'模拟实际退回，无真实资金', payoutReference:'SOFTWARE-REFUND-1', actualRefundConfirmed:true, fulfillmentDecision:'resume' });
    assert.equal(value.actualRefundFen,100); assert.equal(value.payment.status,'confirmed'); assert.equal(value.payment.receipt.amountFen,420); assert.equal(value.completedAt,completedAt); assert.equal(value.filesExpireAt,expiresAt);
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/refunds`, { expectedVersion:value.version,action:'paid_out',refundId,note:'重复',payoutReference:'SOFTWARE-REFUND-2',actualRefundConfirmed:true,fulfillmentDecision:'resume' })).status,409);
    assert.equal((await h.post(admin, `/api/admin/orders/${value.id}/refunds`, { expectedVersion:value.version,action:'request',amountFen:321,reason:'超过余额' })).body.error.code,'REFUND_LIMIT');
  });
  await t.test('经营统计、筛选、暂停接单；已有订单和财务历史不受影响', async () => {
    const free = await h.upload(runtime,user);
    const settings = h.data(await admin.request('GET','/api/admin/settings'));
    h.data(await admin.request('PATCH','/api/admin/settings',{ expectedVersion:settings.version,acceptingOrders:false }));
    assert.equal((await user.upload(await h.fixture('sample-chinese.png'),'paused.png','image/png')).body.error.code,'ORDERS_PAUSED');
    assert.equal((await h.post(user,'/api/print/quotes',{ items:[{fileId:free.id,pages:'all',copies:1,duplex:false}] })).body.error.code,'ORDERS_PAUSED');
    const dashboard = h.data(await admin.request('GET','/api/admin/dashboard')); assert.equal(dashboard.confirmedReceivedFen,420); assert.equal(dashboard.actualRefundFen,100); assert.equal(dashboard.netReceivedFen,320); assert.equal(dashboard.totalOrders,1);
    assert.equal(h.data(await admin.request('GET','/api/admin/orders?room='+encodeURIComponent('B-测试房间'))).total,1);
    assert.equal(h.data(await user.request('GET','/api/me/orders?status=completed')).total,1);
    assert.equal(h.data(await admin.request('GET','/api/admin/users')).total,1);
  });
  await t.test('七天少 1ms 可读，恰好七天学生/管理员预览下载均 410；清理后订单和统计保留', async () => {
    instant = new Date(Date.parse(expiresAt)-1);
    // The session lifetime is also seven days; reauthenticate without moving the system clock.
    for (const client of [user,admin]) { await client.csrfToken(); h.data(await client.request('POST', client === admin ? '/api/auth/admin-login' : '/api/auth/login', { username: client.user.username,password:TEST_PASSWORD })); }
    const route = `/api/me/orders/${value.id}/items/${value.items[0].itemId}/file`;
    assert.equal((await user.request('GET',route,undefined,{raw:true})).status,200);
    instant = new Date(expiresAt);
    assert.equal((await user.request('GET',route)).status,410);
    assert.equal((await user.request('GET',route.replace('/file','/preview'))).status,410);
    assert.equal((await admin.request('GET',`/api/admin/orders/${value.id}/items/${value.items[0].itemId}/print-file`)).status,410);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/production-action`,{expectedVersion:value.version,action:'reprint',note:'试图重印到期文件'})).status,409);
    const cleanup = h.data(await admin.request('POST','/api/admin/files/cleanup-run',{})); assert(cleanup.purged>=1);
    await assert.rejects(fs.access(path.join(runtime.config.fileRoot,source.id)));
    value = h.data(await user.request('GET',`/api/me/orders/${value.id}`)); assert.equal(value.fileAvailability,'deleted'); assert.equal(value.lifecycle,'completed'); assert.equal(value.payment.receipt.amountFen,420); assert.equal(value.actualRefundFen,100); assert.equal(value.completedAt,completedAt); assert.equal(value.filesExpireAt,expiresAt);
    assert.equal(h.data(await user.request('GET','/api/me/tickets')).total,1); assert.equal(h.data(await admin.request('GET','/api/admin/dashboard')).netReceivedFen,320);
    const evidence = { kind:'B-isolated-software-workflow', order:value, completedAt,filesExpireAt:expiresAt,cleanup,realPayment:false,realPrinting:false,realDelivery:false };
    const evidenceRoot = process.env.CP_VERIFICATION_DIR || path.join(PROJECT,'docs/verification/B');
    await fs.mkdir(evidenceRoot,{recursive:true}); await fs.writeFile(path.join(evidenceRoot,'workflow-evidence.json'),JSON.stringify(evidence,null,2));
  });
});
