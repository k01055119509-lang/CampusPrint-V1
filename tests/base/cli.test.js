'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PROJECT, TEST_ROOT, TEST_PASSWORD, configAt, Client } = require('../helpers/runtime');
const { openDatabase } = require('../../backend/db');
const { verifyPassword } = require('../../backend/auth');
const { startServer } = require('../../backend/server');
const { removeTree } = require('../../backend/files/safety');
test('真实初始化命令：空库、无默认管理员密码、独立管理员创建', async t => {
  const name = randomUUID(), root = path.join(TEST_ROOT, name); await fs.mkdir(root, { recursive: true }); t.after(() => removeTree(TEST_ROOT, name));
  const environment = { ...process.env, DATA_DIR: root, HOST: '127.0.0.1', NODE_ENV: 'development', PUBLIC_ORIGIN: '', TRUST_PROXY: '', DB_PATH: '', STUDENT_FILES_DIR: '', PAYMENT_ASSETS_DIR: '', ADVERTISEMENT_ASSETS_DIR: '', PROCESSING_DIR: '', FILE_LEDGER_DIR: '', MANAGED_BACKUPS_DIR: '', CP_ADMIN_PASSWORD: '', CP_ADMIN_USERNAME: '', CP_ADMIN_NICKNAME: '' };
  const command = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(PROJECT, script), ...args], { env: { ...environment, ...extra }, encoding: 'utf8', windowsHide: true });
  const initialized = command('scripts/backend/init-db.js'); assert.equal(initialized.status, 0); assert.equal(JSON.parse(initialized.stdout).users, 0);
  const withoutPassword = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin']); assert.equal(withoutPassword.status, 1);
  const created = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin'], { CP_ADMIN_PASSWORD: TEST_PASSWORD }); assert.equal(created.status, 0); assert(!created.stdout.includes(TEST_PASSWORD));
  const duplicate = command('scripts/backend/init-admin.js', ['--username', 'cli_test_admin'], { CP_ADMIN_PASSWORD: TEST_PASSWORD }); assert.equal(duplicate.status, 1);
  const db = openDatabase(path.join(root, 'db/campus-print.sqlite'));
  try { assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 1); assert.equal(db.get('SELECT role FROM users').role, 'admin'); assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, 0); }
  finally { db.close(); }
});

test('管理员部署初始化：显示名称、隐藏凭据、拒绝覆盖及实际登录', async t => {
  const name=randomUUID(),root=path.join(TEST_ROOT,name);await fs.mkdir(root,{recursive:true});
  let runtime;
  t.after(async()=>{if(runtime)await runtime.close();await removeTree(TEST_ROOT,name);});
  const environment={...process.env,DATA_DIR:root,HOST:'127.0.0.1',NODE_ENV:'development',PUBLIC_ORIGIN:'',TRUST_PROXY:'',DB_PATH:'',STUDENT_FILES_DIR:'',PAYMENT_ASSETS_DIR:'',ADVERTISEMENT_ASSETS_DIR:'',PROCESSING_DIR:'',FILE_LEDGER_DIR:'',MANAGED_BACKUPS_DIR:'',CP_ADMIN_USERNAME:'',CP_ADMIN_PASSWORD:'',CP_ADMIN_NICKNAME:''};
  const command=(args=[],extra={})=>spawnSync(process.execPath,[path.join(PROJECT,'scripts/backend/init-admin.js'),...args],{env:{...environment,...extra},encoding:'utf8',windowsHide:true});
  for(const args of [['--password',TEST_PASSWORD],['--username','cli_named_admin','--nickname'],['--username','cli_named_admin','--username','duplicate']]){
    const rejected=command(args);assert.equal(rejected.status,1);assert(!(rejected.stdout+rejected.stderr).includes(TEST_PASSWORD));
  }
  assert.equal(await fs.stat(path.join(root,'db/campus-print.sqlite')).then(()=>true,()=>false),false);
  const created=command(['--nickname','CLI Display Name','--username','CLI_NAMED_ADMIN'],{CP_ADMIN_PASSWORD:TEST_PASSWORD,CP_ADMIN_NICKNAME:'Ignored environment name'});
  assert.equal(created.status,0,created.stderr);assert(!(created.stdout+created.stderr).includes(TEST_PASSWORD));
  const envCreated=command([],{CP_ADMIN_USERNAME:'cli_env_admin',CP_ADMIN_NICKNAME:'环境显示名',CP_ADMIN_PASSWORD:TEST_PASSWORD});
  assert.equal(envCreated.status,0,envCreated.stderr);assert(!(envCreated.stdout+envCreated.stderr).includes(TEST_PASSWORD));
  const db=openDatabase(path.join(root,'db/campus-print.sqlite'));
  let original;
  try{
    original=db.get('SELECT * FROM users WHERE username=?','cli_named_admin');
    assert.equal(original.nickname,'CLI Display Name');assert.equal(original.role,'admin');
    assert(await verifyPassword(TEST_PASSWORD,original.passwordHash));
    assert.equal(db.get('SELECT nickname FROM users WHERE username=?','cli_env_admin').nickname,'环境显示名');
  }finally{db.close();}
  const replacement='Changed91Abc';
  const duplicate=command(['--username','cli_named_admin','--nickname','Changed name'],{CP_ADMIN_PASSWORD:replacement});
  assert.equal(duplicate.status,1);assert(!(duplicate.stdout+duplicate.stderr).includes(replacement));
  runtime=await startServer(configAt(root));
  assert.deepEqual(runtime.db.get('SELECT * FROM users WHERE username=?','cli_named_admin'),original);
  assert.equal(runtime.db.get('SELECT COUNT(*) n FROM users').n,2);
  const admin=new Client(runtime,{surface:'admin'});await admin.csrfToken();
  assert.equal((await admin.request('POST','/api/auth/admin-login',{username:'cli_named_admin',password:replacement})).status,401);
  const logged=await admin.request('POST','/api/auth/admin-login',{username:'cli_named_admin',password:TEST_PASSWORD});
  assert.equal(logged.status,200);assert.equal(logged.body.data.nickname,'CLI Display Name');assert.equal(logged.body.data.role,'admin');
  assert(!JSON.stringify(logged.body).includes(TEST_PASSWORD));assert(!JSON.stringify(logged.body).includes('passwordHash'));
  assert.equal((await admin.request('GET','/api/admin/dashboard')).status,200);
  assert.equal((await admin.request('POST','/api/auth/logout',{})).status,200);
});
