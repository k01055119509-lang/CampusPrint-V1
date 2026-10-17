'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateStorageConfig, loadConfig } = require('../../backend/config');
const { openDatabase } = require('../../backend/db');
const { createApp } = require('../../backend/app');
const { isolated, configAt, TEST_ROOT } = require('../helpers/runtime');
test('配置隔离和同步事务边界', async t => {
  const runtime = await isolated(); t.after(() => runtime.destroy());
  assert.throws(() => validateStorageConfig({ ...runtime.config, fileRoot: 'D:/SkillWorkbench-V1/var/files' }), /reference/);
  assert.throws(() => validateStorageConfig({ ...runtime.config, tempRoot: runtime.config.fileRoot }), /disjoint/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), /explicit/);
  assert.throws(() => runtime.db.tx(() => Promise.resolve()), /synchronous/);
  await assert.rejects(createApp(configAt(runtime.root)), /already owned/);
  runtime.db.tx(() => {
    assert.throws(() => runtime.db.tx(() => { runtime.db.run('UPDATE maintenance SET enabled=1 WHERE id=1'); throw new Error('rollback nested'); }), /rollback/);
    assert.equal(runtime.db.get('SELECT enabled FROM maintenance').enabled, 0);
    runtime.db.run("UPDATE maintenance SET message='outer committed' WHERE id=1");
  });
  assert.equal(runtime.db.get('SELECT message FROM maintenance').message, 'outer committed');
});
