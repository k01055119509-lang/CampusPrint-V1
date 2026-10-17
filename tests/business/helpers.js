'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, PROJECT } = require('../helpers/runtime');
const fixture = name => fs.readFile(path.join(PROJECT, 'tests/fixtures', name));
function key() { return { 'Idempotency-Key': randomUUID() }; }
async function post(client, route, body, headers = key()) { return client.request('POST', route, body, { headers }); }
function data(response, status = 200) { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body.data; }
async function actors(runtime) { const user = new Client(runtime), other = new Client(runtime), admin = new Client(runtime); await user.student(); await other.student(); await admin.admin(); return { user, other, admin }; }
async function upload(runtime, user, name = 'sample-chinese.png', filename = name) {
  const type = name.endsWith('pdf') ? 'application/pdf' : name.endsWith('jpg') ? 'image/jpeg' : 'image/png';
  const value = data(await user.upload(await fixture(name), filename, type), 202); await runtime.files.waitForIdle();
  return data(await user.request('GET', `/api/files/${value.id}`));
}
async function quote(runtime, user, file, options = {}) {
  const created = data(await post(user, '/api/print/quotes', { items: [{ fileId: file.id, pages: 'all', copies: 1, duplex: false, ...options }] }), 202);
  await runtime.files.waitForIdle(); const value = data(await user.request('GET', `/api/print/quotes/${created.id}`));
  assert.equal(value.status, 'ready', JSON.stringify(value)); assert.equal(value.valid, true); return value;
}
function orderBody(q, overrides = {}) { return { quoteId: q.id, quoteFingerprint: q.fingerprint, deliveryAddress: { buildingId: 'local-dorm', room: 'B-测试房间', contact: '', notes: '', receiptMethod:'handover',receiptNote:'' }, confirmedPreview: true, ...overrides }; }
async function order(runtime, user, options = {}) { const source = await upload(runtime, user), q = await quote(runtime, user, source, options); return data(await post(user, '/api/orders', orderBody(q)), 201); }
async function paymentQr(admin, name = 'sample-chinese.png', headers = {}) {
  const settings = data(await admin.request('GET', '/api/admin/settings')), form = new FormData();
  form.append('file', new Blob([await fixture(name)], { type: 'image/png' }), 'software-test-payment.png');
  return admin.request('POST', '/api/admin/payment-qr', form, { form: true, headers: { 'X-Settings-Version': String(settings.version), ...headers } });
}
async function confirm(admin, value, overrides = {}) { return data(await post(admin, `/api/admin/orders/${value.id}/payment-review`, { expectedVersion: value.version, action: 'confirm', amountFen: value.totals.totalAmountFen, channel: 'other', reference: 'SOFTWARE-TEST-'+randomUUID(), note: '隔离软件模拟记款，没有真实转账', ...overrides })); }
async function action(admin, value, resource, body) { return data(await post(admin, `/api/admin/orders/${value.id}/${resource}`, { expectedVersion: value.version, ...body })); }
async function delivered(admin, value) {
  value = await action(admin, value, 'production-action', { action: 'start' });
  value = await action(admin, value, 'production-action', { action: 'complete', actualCompletionConfirmed: true });
  value = await action(admin, value, 'delivery-action', { action: 'start' });
  return action(admin, value, 'delivery-action', { action: 'delivered', actualDeliveryConfirmed: true, note: '软件模拟送达' });
}
// Construct an existing historical exception only inside the UUID test store.
// The removed API must never be used to manufacture compatibility state.
function legacyFinancial(runtime,value){
  const {TEST_ROOT}=require('../helpers/runtime');assert(runtime.config.dbPath.startsWith(TEST_ROOT+path.sep));
  runtime.db.tx(()=>{runtime.db.run('INSERT INTO financial_exceptions(id,orderId,amountFen,reason,reference,createdAt,createdBy) VALUES(?,?,?,?,?,?,?)',randomUUID(),value.id,0,'历史财务核对说明','LEGACY-PRIVATE-REFERENCE',runtime.context.now(),runtime.db.get("SELECT id FROM users WHERE role='admin' LIMIT 1").id);runtime.db.run("UPDATE print_orders SET financialHold=1,paymentStatus=CASE WHEN paymentStatus='confirmed' THEN paymentStatus ELSE 'rejected' END,version=version+1 WHERE id=?",value.id);});
  return runtime.context.orders.detail({role:'admin',id:runtime.db.get("SELECT id FROM users WHERE role='admin' LIMIT 1").id},value.id);
}
module.exports = { fixture, key, post, data, actors, upload, quote, orderBody, order, paymentQr, confirm, action, delivered,legacyFinancial };
