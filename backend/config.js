'use strict';
const path = require('node:path');
const { isIP } = require('node:net');
const ROOT = path.resolve(__dirname, '..');
const PRODUCT = Object.freeze(require('../config/product.json'));
const LIMITS = Object.freeze({
  requestBytes: 64 * 1024, pageSize: 100,
  allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png'],
  allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxFileBytes: 40 * 1024 * 1024, maxSourcePages: 2000,
  maxImagePixels: 40_000_000, maxPagePixels: 16_000_000,
  maxPreparedPages: 100, maxDerivedBytes: 120 * 1024 * 1024,
  maxTemporaryFilesPerUser: 20, maxSourceBytesPerUser: 256 * 1024 * 1024,
  maxActiveFilesPerUser: 100, maxTotalActiveFiles: 10000,
  maxTotalSourceBytes: 2 * 1024 * 1024 * 1024,
  maxTotalDerivedBytes: 4 * 1024 * 1024 * 1024, minFreeDiskBytes: 512 * 1024 * 1024,
  maxUploadsInFlight: 4, maxJobsInFlight: 2, maxQueuedJobs: 24,
  maxJobsPerFile: 4, maxJobAttempts: 2,
  uploadTimeoutMs: 120000, processingTimeoutMs: 180000,
  previewTimeoutMs: 45000, inspectionTimeoutMs: 45000,
  temporaryUploadHours: 24, cleanupIntervalMs: 300000,
  printDpi: 200, previewWidthPx: 1200, marginMm: 5,
  paymentImageMaxBytes: 5 * 1024 * 1024,
  activityThrottleMs: 30000
});
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}: use true or false`);
}
function validateStorageConfig(config) {
  config.advertisementRoot ||= path.join(config.dataDir, 'advertisement-assets');
  const roots = [config.fileRoot, config.paymentRoot, config.advertisementRoot, config.tempRoot, config.ledgerRoot, config.backupRoot, path.dirname(config.dbPath)];
  const forbidden = [path.join(ROOT, 'frontend'), 'D:/SkillWorkbench-V1'];
  for (const target of roots) {
    if (!path.isAbsolute(target) || target === path.parse(target).root || target === ROOT) throw new Error('Storage roots must be dedicated absolute directories');
    if (forbidden.some(root => inside(root, target) || inside(target, root))) throw new Error('Storage must not touch the reference application or public frontend');
  }
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) throw new Error('Database, files, payment, advertisements, processing, ledger and backup roots must be disjoint');
  }
  return config;
}
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  const port = integer(env.PORT, 4328, 0, 65535, 'PORT');
  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an origin');
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin?.startsWith('https://')) throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !publicOrigin) throw new Error('Non-loopback HOST requires PUBLIC_ORIGIN');
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'var');
  const trustProxy = env.TRUST_PROXY ? env.TRUST_PROXY.split(',').map(s => s.trim()) : false;
  if (trustProxy) for (const network of trustProxy) {
    if (network === 'loopback') continue;
    const [address, bits, extra] = network.split('/'), version = isIP(address);
    if (!version || extra || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128)))) throw new Error('TRUST_PROXY must contain explicit IP/CIDR');
  }
  const resolve = (key, fallback) => path.resolve(ROOT, env[key] || path.join(dataDir, fallback));
  return validateStorageConfig({
    host, port, production, publicOrigin, trustProxy, dataDir,
    dbPath: resolve('DB_PATH', 'db/campus-print.sqlite'),
    fileRoot: resolve('STUDENT_FILES_DIR', 'student-files'),
    paymentRoot: resolve('PAYMENT_ASSETS_DIR', 'payment-assets'),
    advertisementRoot: resolve('ADVERTISEMENT_ASSETS_DIR', 'advertisement-assets'),
    tempRoot: resolve('PROCESSING_DIR', 'processing'),
    ledgerRoot: resolve('FILE_LEDGER_DIR', 'file-ledger'),
    backupRoot: resolve('MANAGED_BACKUPS_DIR', 'managed-backups'),
    studentAccountsEnabled: boolean(env.STUDENT_ACCOUNTS_ENABLED, false, 'STUDENT_ACCOUNTS_ENABLED'),
    advertisementsEnabled: boolean(env.ADVERTISEMENTS_ENABLED, false, 'ADVERTISEMENTS_ENABLED'),
    studentCookieName: production ? '__Host-cp_student_session' : 'cp_student_session',
    adminCookieName: production ? '__Host-cp_admin_session' : 'cp_admin_session',
    legacyCookieName: production ? '__Host-cp_session' : 'cp_session',
    sessionMs: integer(env.SESSION_HOURS, 168, 1, 720, 'SESSION_HOURS') * 3600000,
    anonymousSessionMs: 30 * 60000, clock: () => new Date(), limits: LIMITS,
    rateLimits: { authIp: 30, authAccount: 12, writeUser: 120, writeIp: 600, csrfIp: 60, uploadUser: 20, previewUser: 90,
      guestIp: 30, recoverIp: 30, recoverSession: 10 }
  });
}
module.exports = { ROOT, PRODUCT, LIMITS, loadConfig, validateStorageConfig, inside };
