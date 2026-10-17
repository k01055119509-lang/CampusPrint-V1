'use strict';
const { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const v = require('./validation');
const { ApiError, conflict } = require('./errors');
const derive = promisify(scrypt);
const hashToken = value => createHash('sha256').update(value).digest('hex');
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const dummyHash = `scrypt$131072$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
const GUEST_SESSION_MS = 7 * 86400000;
let inflight = 0;
async function derivePassword(password, salt) {
  // Bound memory usage even if requests arrive from many IPs.
  if (inflight >= 2) throw new ApiError(429, 'RATE_LIMITED', '认证繁忙，请稍后重试');
  inflight++;
  try { return await derive(password, salt, 64, SCRYPT); } finally { inflight--; }
}
async function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derivePassword(secret, salt);
  return `scrypt$131072$8$1$${salt}$${hash.toString('hex')}`;
}
async function hashPassword(password) { return hashSecret(v.password(password)); }
async function verifyPassword(password, stored = dummyHash) {
  const [, N, r, p, salt, expected] = stored.split('$');
  if (N !== '131072' || r !== '8' || p !== '1') return false;
  const hash = await derivePassword(password, salt);
  const other = Buffer.from(expected, 'hex');
  return hash.length === other.length && timingSafeEqual(hash, other);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y);
}
function createAuth(db, config) {
  const now = () => config.clock().toISOString();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' };
  // Run before the first HTTP request; reopening accounts never revives these sessions.
  if (!config.studentAccountsEnabled) db.run("DELETE FROM sessions WHERE userId IN (SELECT id FROM users WHERE role='user' AND identityKind='account')");
  function surfaceFrom(req) {
    const hint = req.headers['x-cp-surface'];
    if (hint !== undefined && !['student','admin'].includes(hint)) throw new ApiError(403, 'FORBIDDEN', '请求端上下文无效');
    const route = req.path;
    const fixed = route.startsWith('/admin/') || route === '/auth/admin-login' ? 'admin' :
      route.startsWith('/print/') || route === '/orders' || route.startsWith('/orders/') || route.startsWith('/me/orders') ||
      route.startsWith('/me/tickets') || route === '/me/print-defaults' || ['/auth/register','/auth/login','/auth/guest'].includes(route) ||
      (route === '/files' && req.method === 'POST') || (route.startsWith('/files/') && req.method === 'DELETE') ? 'student' : null;
    if (fixed && hint && hint !== fixed) throw new ApiError(403, 'FORBIDDEN', '请求端与接口上下文不一致');
    return fixed || hint || 'student';
  }
  const cookieName = surface => surface === 'admin' ? config.adminCookieName : config.studentCookieName;
  function tokenFrom(req, name) {
    const pair = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`));
    if (!pair) return null;
    const token = pair.slice(name.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return token;
  }
  function sessionFrom(req, res) {
    const surface = req.authSurface || surfaceFrom(req), name = cookieName(surface), token = tokenFrom(req, name);
    // An explicit cookie, including an invalid one, must never fall back to legacy authority.
    const hasCookie = (req.headers.cookie || '').split(';').some(p => p.trim().startsWith(`${name}=`));
    let session = token ? db.get('SELECT * FROM sessions WHERE tokenHash=? AND expiresAt>? AND surface=?', hashToken(token), now(), surface) : null;
    if (!hasCookie && surface === 'admin' && (res || req.migratedAdminHash)) {
      const legacyToken = tokenFrom(req, config.legacyCookieName);
      const legacy = legacyToken && db.get("SELECT s.* FROM sessions s JOIN users u ON u.id=s.userId WHERE s.tokenHash=? AND s.expiresAt>? AND s.surface IN ('legacy','admin') AND u.role='admin' AND u.identityKind='account'", hashToken(legacyToken), now());
      if (legacy) {
        if (!res && req.migratedAdminHash !== legacy.tokenHash) return null;
        if (res) db.run("UPDATE sessions SET surface='admin' WHERE tokenHash=?", legacy.tokenHash);
        session = { ...legacy, surface: 'admin' };
        if (res) {
          req.migratedAdminHash = legacy.tokenHash;
          res.cookie(name, legacyToken, { ...cookieOptions, maxAge: Date.parse(legacy.expiresAt) - Date.parse(now()) });
          res.clearCookie(config.legacyCookieName, cookieOptions);
        }
      }
    }
    if (session?.userId) {
      const user = db.get('SELECT role,identityKind FROM users WHERE id=?', session.userId);
      if (!user || (surface === 'admin' ? user.role !== 'admin' || user.identityKind !== 'account' : user.role !== 'user')) return null;
      if (!config.studentAccountsEnabled && surface === 'student' && user.identityKind === 'account') return null;
    }
    return session || null;
  }
  function newSession(req, res, userId = null) {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const createdAt = now();
    const surface = req.authSurface || surfaceFrom(req), user = userId && db.get('SELECT role,identityKind FROM users WHERE id=?', userId);
    if (user && (surface === 'admin' ? user.role !== 'admin' : user.role !== 'user')) throw new ApiError(403, 'FORBIDDEN', '会话角色与请求端不一致');
    const duration = user ? user.identityKind === 'guest' ? GUEST_SESSION_MS : config.sessionMs : config.anonymousSessionMs;
    const session = { tokenHash: hashToken(token), userId, csrfToken, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + duration).toISOString(), lastSeen: createdAt, lastInteractionAt: null, surface };
    db.run('DELETE FROM sessions WHERE expiresAt<=?', createdAt);
    if (req.session) db.run('DELETE FROM sessions WHERE tokenHash=?', req.session.tokenHash);
    db.run('INSERT INTO sessions(tokenHash,userId,csrfToken,createdAt,expiresAt,lastSeen,surface) VALUES(?,?,?,?,?,?,?)',
      session.tokenHash,userId,csrfToken,createdAt,session.expiresAt,createdAt,surface);
    res.cookie(cookieName(surface), token, { ...cookieOptions, maxAge: duration });
    req.session = session;
    return session;
  }
  function requireAuth(req, role) {
    if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', '请先登录');
    if (role !== 'session' && req.user.role !== role) throw new ApiError(403, 'FORBIDDEN', '此账号没有操作权限');
  }
  function requireStudentAccounts() {
    if (!config.studentAccountsEnabled) throw new ApiError(403, 'STUDENT_ACCOUNTS_DISABLED', '学生账号功能暂时停用，请使用访客打印');
  }
  function requireAccount(req) {
    if (req.authSurface !== 'admin') requireStudentAccounts();
    if (req.user?.identityKind === 'guest') throw new ApiError(403, 'FORBIDDEN', '访客不能操作账号资料或账号安全');
  }
  function csrf(req) {
    if (!req.session || !safeEqual(req.headers['x-csrf-token'], req.session.csrfToken)) throw new ApiError(403, 'FORBIDDEN', 'CSRF 校验失败，请刷新认证状态');
  }
  function rate(key, max, windowMs, res) {
    const bucketKey = hashToken(key), time = now();
    db.tx(() => {
      db.run('DELETE FROM rate_limits WHERE resetAt<=?', time);
      const bucket = db.get('SELECT * FROM rate_limits WHERE bucketKey=?', bucketKey);
      if (bucket && bucket.count >= max) {
        res?.set('Retry-After', String(Math.max(1, Math.ceil((Date.parse(bucket.resetAt) - Date.parse(time)) / 1000))));
        throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
      }
      db.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(bucketKey) DO UPDATE SET count=count+1', bucketKey, new Date(Date.parse(time) + windowMs).toISOString());
    });
  }
  return { surfaceFrom, sessionFrom, newSession, requireAuth, requireAccount, requireStudentAccounts, csrf, rate,
    clearCookie: (req, res) => res.clearCookie(cookieName(req.authSurface), cookieOptions) };
}
async function createAdmin(db, config, { username, password, nickname }) {
  username = v.username(username); nickname = v.string(nickname, 'nickname', { max: 80, min: 1, fallback: username });
  if (db.get('SELECT id FROM users WHERE username=?', username)) conflict('该用户名已存在；此命令不会提升已有普通账号权限或重置密码');
  const passwordHash = await hashPassword(password);
  return db.tx(() => {
    if (db.get('SELECT id FROM users WHERE username=?', username)) conflict('该用户名已存在');
    const id = randomUUID();
    db.run('INSERT INTO users(id,username,nickname,passwordHash,role,createdAt) VALUES(?,?,?,?,?,?)', id,username,nickname,passwordHash,'admin',config.clock().toISOString());
    return { id, username };
  });
}
module.exports = { createAuth, hashPassword, hashSecret, verifyPassword, hashToken, createAdmin, GUEST_SESSION_MS };
