'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { isolated, Client, PROJECT } = require('../helpers/runtime');
function multipart(actor, data, name = 'payment.png', mime = 'image/png') {
  const boundary = 'controlled-payment-image-test';
  const request = Readable.from([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }; request.user = actor; request.is = value => value === 'multipart/form-data'; return request;
}
test('B 可复用的收款图片解析器是真实处理，权限和存储独立', async t => {
  const runtime = await isolated(); t.after(() => runtime.destroy()); const admin = new Client(runtime), student = new Client(runtime); await admin.admin(); await student.guest();
  const sample = await fs.readFile(path.join(PROJECT, 'tests/fixtures/sample-chinese.png'));
  await assert.rejects(runtime.files.receivePaymentImage(multipart(student.user, sample)), error => error.status === 403);
  const asset = await runtime.files.receivePaymentImage(multipart(admin.user, sample));
  assert.equal(asset.mimeType, 'image/png'); assert(asset.byteSize > 0); assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM files').n, 0); assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM artifacts').n, 0);
  const handle = await runtime.files.openPaymentAsset(asset.assetId); await handle.close(); await runtime.files.purgeExpiredFiles();
  assert((await fs.stat(path.join(runtime.config.paymentRoot, `${asset.assetId}.png`))).size > 0); assert.deepEqual(await fs.readdir(runtime.config.tempRoot), []);
  await runtime.files.deletePaymentAsset(asset.assetId); await assert.rejects(fs.stat(path.join(runtime.config.paymentRoot, `${asset.assetId}.png`)), { code: 'ENOENT' });
});
