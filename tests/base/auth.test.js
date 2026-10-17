'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated, Client, TEST_PASSWORD } = require('../helpers/runtime');
test('空库、独立身份、会话与路由边界', async t => {
  const runtime = await isolated({ studentAccountsEnabled: true }); t.after(() => runtime.destroy());
  assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
  assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM files').n, 0);
  const tables = runtime.db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name);
  assert(!tables.some(name => /skill|github|favorite|generation/.test(name)));
  const guest = new Client(runtime), student = new Client(runtime), admin = new Client(runtime);
  await t.test('公共配置与已实现业务返回真实状态', async () => {
    const config = await guest.request('GET', '/api/public/config');
    assert.equal(config.body.data.product.id, 'campus-print-v1'); assert.equal(config.body.data.capabilities.orders, true);
    assert.equal(config.body.data.uploadLimits.maxSourcePages, 2000);
    for (const route of ['/api/skills', '/api/github/import', '/api/orders', '/var/db/campus-print.sqlite', '/student-files/test']) assert.equal((await guest.request('GET', route)).status, 404);
    assert.equal((await guest.request('GET', '/api/print/config')).status, 200);
    assert.equal((await guest.request('GET', '/api/auth/me')).status, 401);
  });
  await t.test('注册不能指定管理员角色；CSRF 与来源校验覆盖匿名写入', async () => {
    const csrf = await student.csrfToken(); assert.match(student.cookie, /^cp_student_session=/);
    const before = student.cookie, token = csrf.body.data.csrfToken;
    assert.equal((await student.request('POST', '/api/auth/register', { username: 'tester', password: TEST_PASSWORD }, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    assert.equal((await student.request('POST', '/api/auth/register', { username: 'tester', password: TEST_PASSWORD, role: 'admin' })).status, 400);
    assert.equal((await student.request('GET', '/api/public/config', undefined, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
    await student.register('STUDENT_01'); assert.equal(student.user.username, 'student_01'); assert.equal(student.user.role, 'user');
    assert.notEqual(student.cookie, before); assert.notEqual(student.csrf, token);
    assert(!JSON.stringify(student.user).includes('passwordHash'));
    const stale = new Client(runtime); stale.cookie = before;
    assert.equal((await stale.request('GET', '/api/auth/me')).status, 401);
    assert.equal((await student.request('PATCH', '/api/me/profile', { nickname: '更新昵称' })).body.data.nickname, '更新昵称');
    const user = runtime.db.get('SELECT * FROM users WHERE id=?', student.user.id);
    assert(user.lastLoginAt && user.lastActiveAt); assert.notEqual(user.passwordHash, TEST_PASSWORD);
  });
  await t.test('管理员独立登录与角色拒绝、退出失效', async () => {
    await admin.admin();
    assert.equal((await student.request('GET', '/api/admin/files/cleanup-status')).status, 403);
    assert.equal((await admin.request('GET', '/api/admin/files/cleanup-status')).status, 200);
    const separate = new Client(runtime); await separate.csrfToken();
    assert.equal((await separate.request('POST', '/api/auth/login', { username: admin.user.username, password: TEST_PASSWORD })).status, 403);
    await separate.forSurface('admin').csrfToken(); assert.equal((await separate.forSurface('admin').request('POST', '/api/auth/admin-login', { username: student.user.username, password: TEST_PASSWORD })).status, 403);
    assert.equal((await admin.request('POST', '/api/admin/files/cleanup-run', { path: 'D:/' })).status, 400);
    assert.equal((await admin.request('POST', '/api/admin/files/cleanup-run?now=2099', {})).status, 400);
    const signedCookie = student.cookie; assert.equal((await student.request('POST', '/api/auth/logout', {})).status, 200);
    const stale = new Client(runtime); stale.cookie = signedCookie; assert.equal((await stale.request('GET', '/api/auth/me')).status, 401);
  });
});
test('会话到期和限流有确定错误', async t => {
  let milliseconds = Date.parse('2026-10-14T00:00:00.000Z');
  const runtime = await isolated({ studentAccountsEnabled: true, clock: () => new Date(milliseconds), sessionMs: 1000, rateLimits: { authIp: 30, authAccount: 12, writeUser: 120, writeIp: 600, csrfIp: 2, uploadUser: 20, previewUser: 90 } });
  t.after(() => runtime.destroy()); const student = new Client(runtime); await student.register();
  assert.equal((await student.csrfToken()).status, 200);
  const limited = await student.csrfToken(); assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'));
  milliseconds += 1000; assert.equal((await student.request('GET', '/api/auth/me')).status, 401);
});
