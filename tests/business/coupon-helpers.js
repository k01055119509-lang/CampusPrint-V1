'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const h = require('./helpers');
const { PROJECT } = require('../helpers/runtime');
async function batch(admin, input = {}, headers = h.key()) {
  return h.data(await h.post(admin, '/api/admin/coupon-batches', { type: 'discount', ...(input.type === 'threshold' ? {} : { payRatePercent: 80 }), ...input }, headers), 201);
}
async function reveal(admin, id) {
  const response = await admin.request('POST', '/api/admin/coupons/reveal-codes', { couponIds: [id] });
  assert.equal(response.status, 200, 'authorized coupon reveal must succeed');
  assert.match(response.headers.get('cache-control'), /no-store/);
  return response.body.data.items[0].code;
}
async function issued(admin, input) { const created = await batch(admin, input); return { batch: created, coupon: created.coupons[0], code: await reveal(admin, created.coupons[0].id) }; }
async function quote(runtime, user, file, code, options = {}) {
  const created = h.data(await h.post(user, '/api/print/quotes', { items: [{ fileId: file.id, pages: 'all', copies: 1, duplex: false, ...options }], couponCode: code }), 202);
  await runtime.files.waitForIdle(); const value = h.data(await user.request('GET', '/api/print/quotes/' + created.id));
  assert.equal(value.status, 'ready', 'coupon quote is ready'); assert.equal(value.valid, true, value.invalidReason); return value;
}
async function order(runtime, user, code, options) { const file = await h.upload(runtime, user); const q = await quote(runtime, user, file, code, options); return h.data(await h.post(user, '/api/orders', h.orderBody(q)), 201); }
async function get(admin, value) { return h.data(await admin.request('GET', '/api/admin/orders/' + value.id)); }
function row(runtime, coupon) { return runtime.db.get('SELECT state,version,disabledAt,reservedOrderId,redeemedAt FROM coupons WHERE id=?', coupon.id); }
function assertNoCodes(value, codes) { for (const code of codes) assert(!JSON.stringify(value).includes(code), 'full code is absent from ordinary data'); }
async function evidence(name, value) {
  const dir = process.env.CP_VERIFICATION_DIR || path.join(PROJECT, 'docs/verification/B');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify(value, null, 2));
}
module.exports = { batch, reveal, issued, quote, order, get, row, assertNoCodes, evidence };
