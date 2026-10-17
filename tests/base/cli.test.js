'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PROJECT, TEST_ROOT, TEST_PASSWORD } = require('../helpers/runtime');
const { openDatabase } = require('../../backend/db');
const { removeTree } = require('../../backend/files/safety');
test('真实初始化命令：空库、无默认管理员密码、独立管理员创建', async t => {
  const name = randomUUID(), root = path.join(TEST_ROOT, name); await fs.mkdir(root, { recursive: true }); t.after(() => removeTree(TEST_ROOT, name));
  const environment = { ...process.env, DATA_DIR: root, HOST: '127.0.0.1', NODE_ENV: 'development', PUBLIC_ORIGIN: '', TRUST_PROXY: '', DB_PATH: '', STUDENT_FILES_DIR: '', PAYMENT_ASSETS_DIR: '', PROCESSING_DIR: '', FILE_LEDGER_DIR: '', CP_ADMIN_PASSWORD: '', CP_ADMIN_USERNAME: '' };
  const command = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(PROJECT, script), ...args], { env: { ...environment, ...extra }, encoding: 'utf8', windowsHide: true });
  const initialized = command('scripts/backend/init-db.js'); assert.equal(initialized.status, 0); assert.equal(JSON.parse(initialized.stdout).users, 0);
  const withoutPassword = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin']); assert.equal(withoutPassword.status, 1);
  const created = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin'], { CP_ADMIN_PASSWORD: TEST_PASSWORD }); assert.equal(created.status, 0); assert(!created.stdout.includes(TEST_PASSWORD));
  const duplicate = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin'], { CP_ADMIN_PASSWORD: TEST_PASSWORD }); assert.equal(duplicate.status, 1);
  const db = openDatabase(path.join(root, 'db/campus-print.sqlite'));
  try { assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 1); assert.equal(db.get('SELECT role FROM users').role, 'admin'); assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, 0); }
  finally { db.close(); }
});
