'use strict';
const express = require('express');
const path = require('node:path');
const { ROOT, PRODUCT, loadConfig, validateStorageConfig } = require('./config');
const { openDatabase } = require('./db');
const { createAuth } = require('./auth');
const { createActivity } = require('./activity');
const { ApiError } = require('./errors');
const v = require('./validation');
const { FileService } = require('./files/service');
const { acquireRuntimeLock } = require('./runtime-lock');
async function createApp(options = {}) {
  const defaults = loadConfig();
  const config = validateStorageConfig({ ...defaults, ...options,
    advertisementRoot: options.advertisementRoot || (options.dataDir ? path.join(options.dataDir, 'advertisement-assets') : defaults.advertisementRoot),
    limits: { ...defaults.limits, ...options.limits }, rateLimits: { ...defaults.rateLimits, ...options.rateLimits } });
  if (config.limits.cleanupIntervalMs > 300000 || config.limits.cleanupIntervalMs < 10) throw new Error('Cleanup interval must be at most five minutes');
  const pendingRestore = path.join(path.dirname(config.dbPath), 'campus-print.restore.pending');
  if (!options.allowPendingRestore) {
    let pending = false;
    try { require('node:fs').lstatSync(pendingRestore); pending = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending) throw new Error('Unfinished restore: refuse service startup; restore again into a new empty storage directory');
  }
  const releaseLock = await acquireRuntimeLock(config.dbPath);
  let db, files, context;
  try {
    db = openDatabase(config.dbPath); const auth = createAuth(db, config), activity = createActivity(db, config);
    files = new FileService(db, config, options.fileServiceOptions);
    // Expired objects and interrupted work are handled before the first HTTP request.
    await files.initialize({ recoverJobs: options.recoverFileJobs !== false });
    const app = express(), routes = [];
    app.disable('x-powered-by'); app.disable('etag'); app.set('query parser', 'simple'); app.set('trust proxy', config.trustProxy);
    app.use((req, res, next) => {
      res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
      if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
      const port = req.socket.localPort;
      const origins = config.publicOrigin ? [config.publicOrigin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
      if (!origins.some(origin => new URL(origin).host === req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return next(new ApiError(403, 'FORBIDDEN_ORIGIN', '请求来源不被允许'));
      next();
    });
    const api = express.Router(); app.use('/api', api);
    api.use((req, res, next) => {
      res.set('Cache-Control', 'no-store'); req.authSurface = auth.surfaceFrom(req); req.session = auth.sessionFrom(req, res);
      req.user = req.session?.userId ? db.get('SELECT * FROM users WHERE id=?', req.session.userId) : null;
      if (req.user) activity.record(req); next();
    });
    api.use(express.json({ limit: config.limits.requestBytes, strict: true, inflate: false }));
    const maintenance = () => { const { id, enabled, ...rest } = db.get('SELECT * FROM maintenance WHERE id=1'); return { enabled: !!enabled, ...rest }; };
    function add(method, route, options, handler) {
      const { role = null, bodyKeys, write = !['get', 'head'].includes(method), transaction = write && !options.multipart,
        blocked = false, status = 200, multipart = false, raw = false } = options;
      if (multipart && transaction) throw new Error('Multipart I/O must run outside database transactions');
      routes.push({ method: method.toUpperCase(), path: `/api${route}`, role, write, multipart });
      api[method](route, async (req, res) => {
        if (options.studentAccount) auth.requireStudentAccounts();
        if (options.account) auth.requireAccount(req);
        if (role) auth.requireAuth(req, role);
        if (write) {
          auth.csrf(req);
          auth.rate(`write:ip:${req.ip}`, config.rateLimits.writeIp, 60000, res);
          if (req.user) auth.rate(`write:user:${req.user.id}`, config.rateLimits.writeUser, 60000, res);
          if (multipart) { if (!req.is('multipart/form-data')) throw new ApiError(415, 'MULTIPART_REQUIRED', '上传须使用 multipart/form-data'); }
          else {
            if (!req.is('application/json')) throw new ApiError(415, 'JSON_REQUIRED', '写请求须使用 application/json');
            if (bodyKeys) v.keys(req.body, bodyKeys);
          }
        }
        if (blocked && maintenance().enabled) throw new ApiError(503, 'MAINTENANCE', maintenance().message || '系统维护中，请稍后重试');
        const data = transaction ? db.tx(() => handler(req, res)) : await handler(req, res);
        if (!raw) res.status(status).json({ success: true, data });
      });
    }
    const capabilities = { privateFiles: true, orders: false, advertisements: config.advertisementsEnabled };
    context = { db, config, auth, activity, add, files, fileService: files, maintenance, capabilities, now: () => config.clock().toISOString(),
      sendArtifact: require('./files/register').sendArtifact };
    require('./routes/auth')(context); require('./routes/account-security')(context); require('./files/register')(context);
    require('./orders/register')(context);
    require('./merchant/register')(context);
    await context.orders.payments.initialize();
    await context.advertisements.initialize();
    add('get', '/public/config', {}, () => ({ product: PRODUCT, timezone: 'Asia/Shanghai', maintenance: maintenance(),
      studentAccountsEnabled: config.studentAccountsEnabled, guestSessionDays: 7,
      auth: { usernameRule: 'NFKC + trim + lowercase; [a-z0-9_]{3,32}', passwordMinLength: 6, passwordMaxLength: 12, passwordPattern: v.passwordPattern, roles: ['user', 'admin'] },
      uploadLimits: config.limits, capabilities }));
    api.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', '接口不存在')));
    app.use(express.static(path.join(ROOT, 'frontend'), { dotfiles: 'deny', index: 'index.html', etag: false, maxAge: 0, fallthrough: true }));
    app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', '页面不存在')));
    app.use((err, req, res, next) => {
      if (res.headersSent) return next(err);
      let error = err;
      if (err.type === 'entity.too.large') error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON 请求超过服务器上限');
      else if (['entity.parse.failed', 'encoding.unsupported', 'charset.unsupported'].includes(err.type)) error = new ApiError(400, 'VALIDATION_ERROR', '请求必须是未压缩的 UTF-8 JSON');
      else if (/UNIQUE constraint failed/.test(err.message)) error = new ApiError(409, 'CONFLICT', '记录已存在或请求发生冲突');
      else if (/database is (locked|busy)/.test(err.message)) error = new ApiError(503, 'SERVICE_UNAVAILABLE', '数据库繁忙，请稍后重试');
      if (!(error instanceof ApiError)) { console.error('CampusPrint request error:', error.code || error.name); error = new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误'); }
      if (error.status === 429 && !res.hasHeader('Retry-After')) res.set('Retry-After', '1');
      res.status(error.status).json({ success: false, error: { code: error.code, message: error.message, fields: error.fields } });
    });
    return { app, db, files, config, routes, context, async close() { context.orders?.coupons.close(); await context.orders?.payments.close(); await context.advertisements?.close(); await files.close(); db.close(); await releaseLock(); } };
  } catch (error) { context?.orders?.coupons.close(); await context?.orders?.payments.close(); await context?.advertisements?.close(); await files?.close(); db?.close(); await releaseLock(); throw error; }
}
module.exports = { createApp };
