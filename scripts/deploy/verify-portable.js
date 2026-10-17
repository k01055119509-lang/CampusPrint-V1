'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { ROOT, inside } = require('../../backend/config');
const { inventory } = require('./package');
const { removeTree } = require('../../backend/files/safety');
const sha = value => createHash('sha256').update(value).digest('hex');
function run(exe, args, cwd, env, verbatim = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim }); let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Command timed out: ' + path.basename(exe))); }, 90000);
    child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end();
  });
}
class Client {
  constructor(url, surface = 'student') { this.url = url; this.surface = surface; this.cookies = new Map(); this.csrf = ''; }
  async request(method, route, data, options = {}) {
    const headers = { Origin: this.url, 'X-CP-Surface': this.surface, ...options.headers };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => k + '=' + v).join('; ');
    if (method !== 'GET') { headers['X-CSRF-Token'] = this.csrf; headers['Idempotency-Key'] ||= randomUUID(); }
    if (data !== undefined && !options.form) headers['Content-Type'] = 'application/json';
    const response = await fetch(this.url + route, { method, headers, body: data === undefined ? undefined : options.form ? data : JSON.stringify(data), signal: AbortSignal.timeout(45000) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], split = pair.indexOf('='); this.cookies.set(pair.slice(0, split), pair.slice(split + 1)); }
    const body = await response.json();
    this.csrf = response.headers.get('x-csrf-token') || this.csrf;
    if (route === '/api/auth/csrf' && body.success) this.csrf = body.data.csrfToken;
    assert.equal(response.status, options.status || 200, route + ': ' + JSON.stringify(body));
    return body.data;
  }
}
async function main() {
  const build = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const output = path.resolve(process.env.CP_VERIFICATION_DIR || path.join(ROOT, 'docs/verification/portable-v1.4.0/verify-20261016'));
  await fs.mkdir(output, { recursive: true });
  assert.equal(sha(await fs.readFile(build.archive)), build.sha256);
  const testId = randomUUID(), testRoot = path.join(ROOT, 'tmp/tests', testId);
  await fs.mkdir(testRoot, { recursive: true });
  const extractParent = path.join(testRoot, '初次解压 目录'), movedParent = path.join(testRoot, '另一台电脑 中文空格');
  await fs.mkdir(extractParent); await fs.mkdir(movedParent);
  let directory = path.join(movedParent, path.basename(build.directory));
  const ps = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const cmd = path.join(process.env.WINDIR, 'System32/cmd.exe');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = path.join(output, 'extract-test.ps1');
  await fs.writeFile(script, '\uFEFF' + `$ErrorActionPreference='Stop'\r\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\r\n[IO.Compression.ZipFile]::ExtractToDirectory(${quote(build.archive)},${quote(extractParent)})\r\n`);
  const extracted = await run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], ROOT, process.env);
  assert.equal(extracted.code, 0, extracted.output);
  await fs.rename(path.join(extractParent, path.basename(build.directory)), directory);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package-manifest.json'), 'utf8'));
  const rows = (await inventory(directory)).filter(r => r.path !== 'package-manifest.json');
  const map = new Map(rows.map(r => [r.path, r]));
  assert.equal(rows.length, manifest.files.length);
  for (const row of manifest.files) assert.equal(map.get(row.path)?.sha256, row.sha256, row.path);
  assert(!rows.some(r => /(^|\/)(var|tests|\.env)(\/|$)|\.(sqlite|db)$/i.test(r.path)));
  const net = require('node:net'), probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const guard = path.join(testRoot, 'offline-guard.cjs');
  await fs.writeFile(guard, `const net=require('node:net'),dns=require('node:dns');const local=h=>!h||['127.0.0.1','localhost','::1'].includes(h);const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const x=a[0];const h=Array.isArray(x)?(typeof x[0]==='object'?x[0].host:x[1]):typeof x==='object'?x.host:typeof a[1]==='string'?a[1]:null;if(!local(h))throw Error('PORTABLE_TEST_EXTERNAL_NETWORK_BLOCKED');return connect.apply(this,a);};const lookup=dns.lookup;dns.lookup=function(h,...a){if(!local(h))throw Error('PORTABLE_TEST_EXTERNAL_NETWORK_BLOCKED');return lookup.call(this,h,...a);};`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['path', 'node_path', 'node_options'].includes(key.toLowerCase())) delete env[key];
  Object.assign(env, { Path: [path.join(process.env.WINDIR, 'System32'), process.env.WINDIR, path.dirname(ps)].join(';'), NODE_PATH: '', NODE_OPTIONS: '--require="' + guard.replaceAll('\\', '/') + '"', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: 'var', PUBLIC_ORIGIN: '', TRUST_PROXY: '', DB_PATH: '', STUDENT_FILES_DIR: '', PAYMENT_ASSETS_DIR: '', ADVERTISEMENT_ASSETS_DIR: '', PROCESSING_DIR: '', FILE_LEDGER_DIR: '', MANAGED_BACKUPS_DIR: '', STUDENT_ACCOUNTS_ENABLED: 'false', ADVERTISEMENTS_ENABLED: 'false', CP_PORTABLE_SKIP_BROWSER: '1', CP_PORTABLE_NO_PAUSE: '1', CP_ADMIN_USERNAME: '', CP_ADMIN_PASSWORD: '' });
  const steps = [];
  const action = async (filename, overrides = {}) => {
    const result = await run(cmd, ['/d', '/s', '/c', '""' + path.join(directory, filename) + '""'], directory, { ...env, ...overrides }, true);
    await fs.writeFile(path.join(output, 'launcher-' + steps.length + '.log'), result.output);
    steps.push({ action: filename, exit: result.code }); return result;
  };
  const node = () => path.join(directory, 'runtime/node.exe');
  const dataCounts = () => {
    const db = new DatabaseSync(path.join(directory, 'var/db/campus-print.sqlite'), { readOnly: true });
    try { return Object.fromEntries(['users', 'files', 'print_orders', 'payment_receipts', 'order_refunds', 'coupons', 'advertisements', 'general_feedback'].map(t => [t, db.prepare('SELECT count(*) AS n FROM ' + t).get().n])); } finally { db.close(); }
  };
  let running = false;
  try {
    const missing = await run(path.join(process.env.WINDIR, 'System32/where.exe'), ['node.exe'], directory, env); assert.notEqual(missing.code, 0, 'Global Node is still discoverable');
    const check = await action('05-检查运行环境.cmd'); assert.equal(check.code, 0, check.output);
    assert(!await fs.stat(path.join(directory, 'var')).then(() => true, () => false), 'Check must not create business storage');
    const blocked = await run(node(), ['-e', "require('node:net').connect(443,'example.com')"], directory, env); assert.notEqual(blocked.code, 0); assert(blocked.output.includes('PORTABLE_TEST_EXTERNAL_NETWORK_BLOCKED'));
    const beforeSetup = await action('02-启动用户端.cmd'); assert.notEqual(beforeSetup.code, 0); assert(!await fs.stat(path.join(directory, '.env')).then(() => true, () => false));
    const noCredentials = await action('01-首次设置.cmd'); assert.notEqual(noCredentials.code, 0); const empty = dataCounts(); assert(Object.values(empty).every(n => n === 0));
    const username = 'portable_operator', password = 'Port9' + randomUUID().replaceAll('-', '').slice(0, 6);
    const setup = await action('01-首次设置.cmd', { CP_ADMIN_USERNAME: username, CP_ADMIN_PASSWORD: password }); assert.equal(setup.code, 0, setup.output); assert(!setup.output.includes(password)); assert.equal(dataCounts().users, 1);
    const repeatSetup = await action('01-首次设置.cmd'); assert.equal(repeatSetup.code, 0, repeatSetup.output); assert.equal(dataCounts().users, 1);
    const start = await action('02-启动用户端.cmd'); assert.equal(start.code, 0, start.output); running = true;
    const url = 'http://127.0.0.1:' + port;
    const started = JSON.parse(await fs.readFile(path.join(directory, 'var/desktop-control/instance.json'), 'utf8'));
    assert.equal((await fs.readFile(path.join(directory, 'var/db/campus-print.runtime.lock'), 'utf8')).includes(String(started.pid)), true);
    const publicConfig = (await (await fetch(url + '/api/public/config')).json()).data; assert.equal(publicConfig.product.version, '1.4.0');
    const prices = (await (await fetch(url + '/api/print/config')).json()).data;
    assert.equal(prices.pricingVersion, '1.1.0'); assert.deepEqual([prices.singleSidedSheetPriceFen, prices.doubleSidedSheetPriceFen, prices.oddTailSheetPriceFen], [50, 90, 50]); assert.equal(prices.payment.configured, false);
    assert.equal((await fetch(url + '/api/admin/orders')).status, 401);
    for (const route of ['/', '/user/', '/admin/']) assert.equal((await fetch(url + route)).status, 200);
    const admin = new Client(url, 'admin'), user = new Client(url);
    await admin.request('GET', '/api/auth/csrf'); await admin.request('POST', '/api/auth/admin-login', { username, password });
    await user.request('GET', '/api/auth/csrf'); await user.request('POST', '/api/auth/guest', {});
    const upload = async (filename, mime) => {
      const form = new FormData(); form.append('file', new Blob([await fs.readFile(path.join(ROOT, 'tests/fixtures', filename))], { type: mime }), filename);
      const uploaded = await user.request('POST', '/api/files', form, { form: true, status: 202 });
      for (let i = 0; i < 150; i++) { const file = await user.request('GET', '/api/files/' + uploaded.id); if (file.status === 'ready') return file; assert.equal(file.status, 'processing', JSON.stringify(file.error)); await delay(200); }
      throw Error('Packaged file processing timed out');
    };
    const pdf = await upload('sample-chinese.pdf', 'application/pdf'); const image = await upload('sample-chinese.png', 'image/png'); assert(image.sourcePageCount > 0);
    const q = await user.request('POST', '/api/print/quotes', { items: [{ fileId: pdf.id, pages: 'all', copies: 1, duplex: true }] }, { status: 202 }); let quote;
    for (let i = 0; i < 150; i++) { quote = await user.request('GET', '/api/print/quotes/' + q.id); if (quote.status === 'ready') break; assert.equal(quote.status, 'processing'); await delay(200); } assert.equal(quote.status, 'ready');
    let order = await user.request('POST', '/api/orders', { quoteId: quote.id, quoteFingerprint: quote.fingerprint, deliveryAddress: { buildingId: 'local-dorm', room: '隔离验证', contact: '', notes: '', receiptMethod: 'handover', receiptNote: '' }, confirmedPreview: true }, { status: 201 });
    const code = await user.request('GET', '/api/me/orders/' + order.id + '/query-code'); assert.equal(typeof code.queryCode, 'string');
    const settings = await admin.request('GET', '/api/admin/settings'), qr = new FormData(); qr.append('file', new Blob([await fs.readFile(path.join(ROOT, 'tests/fixtures/sample-chinese.png'))], { type: 'image/png' }), 'isolated-payment.png');
    await admin.request('POST', '/api/admin/payment-qr/wechat', qr, { form: true, headers: { 'X-Settings-Version': String(settings.version) } });
    order = await user.request('POST', '/api/me/orders/' + order.id + '/payment-submissions', { expectedVersion: order.version, channel: 'wechat' });
    order = await admin.request('POST', '/api/admin/orders/' + order.id + '/payment-review', { expectedVersion: order.version, action: 'confirm', amountFen: order.totals.totalAmountFen, channel: 'wechat', reference: 'ISOLATED-' + randomUUID(), note: '软件模拟，无真实到账' }); assert.equal(order.fulfillment.stage, 'in_progress');
    order = await admin.request('POST', '/api/admin/orders/' + order.id + '/fulfillment-action', { expectedVersion: order.version, action: 'delivered', actualDeliveryConfirmed: true }); assert.equal(order.fulfillment.stage, 'completed');
    const a = await admin.request('GET', '/api/admin/announcement'); await admin.request('PATCH', '/api/admin/announcement', { expectedVersion: a.version, enabled: true, content: '隔离便携包验证公告' });
    assert.equal((await (await fetch(url + '/api/public/announcement')).json()).data.enabled, true);
    const beforeStop = dataCounts();
    const repeated = await action('03-启动经营后台.cmd'); assert.equal(repeated.code, 0, repeated.output); assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'var/desktop-control/instance.json'), 'utf8')).pid, started.pid);
    const stop = await action('04-停止服务.cmd'); assert.equal(stop.code, 0, stop.output); running = false; assert(!await fs.stat(path.join(directory, 'var/desktop-control/instance.json')).then(() => true, () => false));
    const relocated = path.join(testRoot, '移动后继续使用'); await fs.rename(directory, relocated); directory = relocated;
    const restart = await action('02-启动用户端.cmd'); assert.equal(restart.code, 0, restart.output); running = true; assert.deepEqual(dataCounts(), beforeStop);
    const afterMove = new Client(url, 'admin'); await afterMove.request('GET', '/api/auth/csrf'); await afterMove.request('POST', '/api/auth/admin-login', { username, password }); assert.equal((await afterMove.request('GET', '/api/admin/dashboard')).confirmedReceivedFen, order.totals.totalAmountFen);
    const finalStop = await action('04-停止服务.cmd'); assert.equal(finalStop.code, 0, finalStop.output); running = false;
    const stale = path.join(directory, 'var/desktop-control/instance.json'); await fs.writeFile(stale, JSON.stringify({ pid: 2147483647, instanceId: 'isolated-stale' })); assert.equal((await action('04-停止服务.cmd')).code, 0); assert(!await fs.stat(stale).then(() => true, () => false));
    const report = { at: new Date().toISOString(), passed: true, archive: build.archive, archiveSha256: build.sha256, manifestFiles: manifest.files.length, verifiedExactArchive: true, extractionRelocatedBeforeUse: true, chineseAndSpacePaths: true, systemNodeAbsentFromPath: true, externalNodeNetworkBlocked: true, offlineRuntimeCheck: true, checkDidNotCreateData: true, missingSetupRejected: true, emptyInitialCounts: empty, hiddenPasswordInitialization: true, repeatSetupPreservedAccount: true, bundledNodeDesktopStart: true, entrypoints: [200, 200, 200], anonymousAdminStatus: 401, livePdfAndImageProcessing: true, liveQuoteOrderPaymentDelivery: true, queryCodeOwnerRead: true, announcement: true, duplicateStartSamePid: true, stopAndRelocationRestartPreservedData: true, staleStopRecovered: true, nativeDependencies: ['sqlite', 'canvas', 'sharp', 'pdfjs'], steps, realMoney: false, physicalOtherComputerTested: false, publicDeployment: false, testRoot };
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, sha256: build.sha256, manifestFiles: manifest.files.length, offlineLaunch: true, pdfImageOrder: true, movedFolderRestart: true }));
  } catch (error) {
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), message: error.message, stack: error.stack, steps, testRoot }, null, 2)); throw error;
  } finally {
    if (running) { const stopped = await action('04-停止服务.cmd'); assert.equal(stopped.code, 0, stopped.output); }
    if (await fs.stat(path.join(output, 'verification.json')).then(() => true, () => false)) {
      assert(inside(path.join(ROOT, 'tmp/tests'), testRoot)); await removeTree(path.join(ROOT, 'tmp/tests'), testId);
      await fs.writeFile(path.join(output, 'cleanup.json'), JSON.stringify({ testRoot, removed: true, at: new Date().toISOString() }));
    }
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
