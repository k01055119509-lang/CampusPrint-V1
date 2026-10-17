'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { isolated, Client } = require('../helpers/runtime');
test('网络中断不留下上传正文或业务元数据', async t => {
  const runtime = await isolated(); t.after(() => runtime.destroy()); const student = new Client(runtime); await student.guest();
  await new Promise(resolve => {
    const boundary = 'campusprint-network-test', request = http.request(runtime.url + '/api/files', { method: 'POST', headers: {
      Cookie: student.cookie, Origin: runtime.url, 'X-CSRF-Token': student.csrf,
      'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    request.on('error', () => resolve()); request.on('close', resolve);
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="interrupted.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`);
    request.write(Buffer.alloc(128 * 1024)); setTimeout(() => request.destroy(), 50);
  });
  for (let n = 0; n < 100 && (runtime.files.activeUploads.size || (await fs.readdir(runtime.config.tempRoot)).length); n++) await delay(20);
  assert.equal(runtime.files.activeUploads.size, 0); assert.deepEqual(await fs.readdir(runtime.config.tempRoot), []);
  assert.deepEqual(await fs.readdir(runtime.config.fileRoot), []); assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM files').n, 0);
});
