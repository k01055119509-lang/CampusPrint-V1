'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startServer } = require('../../backend/server');
const { createAdmin } = require('../../backend/auth');
const { removeTree } = require('../../backend/files/safety');
const PROJECT = path.resolve(__dirname, '../..'), TEST_ROOT = path.join(PROJECT, 'tmp/tests');
const TEST_PASSWORD = 'TestOnly9Abc';
function configAt(root, overrides = {}) {
  return { host: '127.0.0.1', port: 0, dataDir: root, studentAccountsEnabled: false, advertisementsEnabled:false, dbPath: path.join(root, 'db/campus-print.sqlite'),
    fileRoot: path.join(root, 'student-files'), paymentRoot: path.join(root, 'payment-assets'), advertisementRoot: path.join(root, 'advertisement-assets'),
    tempRoot: path.join(root, 'processing'), ledgerRoot: path.join(root, 'ledger'), backupRoot: path.join(root, 'managed-backups'), ...overrides };
}
async function isolated(overrides = {}) {
  const name = randomUUID(), root = path.join(TEST_ROOT, name); await fs.mkdir(root, { recursive: true });
  const runtime = await startServer(configAt(root, overrides));
  return { ...runtime, root, name, async destroy() { await runtime.close(); await removeTestStorage(name); } };
}
async function removeTestStorage(name) {
  for (let attempt = 0; ; attempt++) {
    try { await removeTree(TEST_ROOT, name); return; }
    catch (error) { if (!['EBUSY','EPERM'].includes(error.code) || attempt >= 10) throw error; await new Promise(resolve=>setTimeout(resolve,100)); }
  }
}
class Client {
  constructor(runtime, { surface = 'student', browser = { cookies: new Map(), csrf: new Map() } } = {}) {
    this.runtime = runtime; this.surface = surface; this.browser = browser;
  }
  get cookie() { return [...this.browser.cookies].map(([key,value]) => key + '=' + value).join('; '); }
  set cookie(value) {
    this.browser.cookies.clear();
    for (const pair of value.split(';').filter(Boolean)) { const index = pair.indexOf('='); this.browser.cookies.set(pair.slice(0,index).trim(),pair.slice(index+1)); }
  }
  get csrf() { return this.browser.csrf.get(this.surface) || ''; }
  set csrf(value) { this.browser.csrf.set(this.surface, value); }
  forSurface(surface) { return new Client(this.runtime, { surface, browser: this.browser }); }
  async request(method, route, data, { headers = {}, raw = false, form = false } = {}) {
    const requestHeaders = { Origin: this.runtime.url, 'X-CP-Surface': this.surface, ...headers };
    if (this.cookie) requestHeaders.Cookie = this.cookie;
    if (!['GET', 'HEAD'].includes(method) && !('X-CSRF-Token' in requestHeaders)) requestHeaders['X-CSRF-Token'] = this.csrf;
    if (data !== undefined && !form) requestHeaders['Content-Type'] ||= 'application/json';
    const response = await fetch(this.runtime.url + route, { method, headers: requestHeaders,
      body: data === undefined ? undefined : form ? data : JSON.stringify(data) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0], index = pair.indexOf('='), name = pair.slice(0,index), token = pair.slice(index+1);
      if (token) this.browser.cookies.set(name,token); else this.browser.cookies.delete(name);
    }
    const result = raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
    if (response.headers.get('x-csrf-token')) this.browser.csrf.set(requestHeaders['X-CP-Surface'], response.headers.get('x-csrf-token'));
    if (route === '/api/auth/csrf' && result.success) this.browser.csrf.set(requestHeaders['X-CP-Surface'], result.data.csrfToken);
    return { status: response.status, headers: response.headers, body: result };
  }
  async csrfToken() { return this.request('GET', '/api/auth/csrf'); }
  async guest() {
    this.surface = 'student'; await this.csrfToken(); const result = await this.request('POST', '/api/auth/guest', {});
    if (result.status !== 200) throw new Error(JSON.stringify(result.body)); this.user = result.body.data; return result;
  }
  async student(username) { return this.runtime.config.studentAccountsEnabled ? this.register(username) : this.guest(); }
  async register(username = 'student_' + randomUUID().slice(0, 8)) {
    await this.csrfToken(); const result = await this.request('POST', '/api/auth/register', { username, password: TEST_PASSWORD });
    if (result.status !== 201) throw new Error(JSON.stringify(result.body)); this.user = result.body.data; return result;
  }
  async admin() {
    this.surface = 'admin';
    const username = 'operator_' + randomUUID().slice(0, 8);
    await createAdmin(this.runtime.db, this.runtime.config, { username, password: TEST_PASSWORD, nickname: '软件测试经营者' });
    await this.csrfToken(); const result = await this.request('POST', '/api/auth/admin-login', { username, password: TEST_PASSWORD });
    if (result.status !== 200) throw new Error(JSON.stringify(result.body)); this.user = result.body.data; return result;
  }
  async upload(buffer, name = 'sample.pdf', type = 'application/pdf', headers = {}) {
    const form = new FormData(); form.append('file', new Blob([buffer], { type }), name);
    return this.request('POST', '/api/files', form, { form: true, headers });
  }
}
module.exports = { isolated, configAt, TEST_ROOT, PROJECT, TEST_PASSWORD, Client, removeTestStorage };
