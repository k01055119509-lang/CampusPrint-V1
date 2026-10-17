'use strict';
const { loadConfig } = require('../../backend/config');
const { openDatabase } = require('../../backend/db');
const { ensureRoot, assertNoLinks } = require('../../backend/files/safety');
const path = require('node:path');
async function main() {
  const config = loadConfig(); await ensureRoot(path.dirname(config.dbPath)); await assertNoLinks(config.dbPath, { missing: true });
  const db = openDatabase(config.dbPath);
  try { console.log(JSON.stringify({ product: 'campus-print-v1', migrations: db.all('SELECT version FROM schema_migrations'), users: db.get('SELECT COUNT(*) AS n FROM users').n, files: db.get('SELECT COUNT(*) AS n FROM files').n, defaultAdminPassword: false })); }
  finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
