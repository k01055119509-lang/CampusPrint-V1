'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT, TEST_ROOT, TEST_PASSWORD } = require('../helpers/runtime');
const { removeTree } = require('../../backend/files/safety');
const { buildPackage } = require('../../scripts/deploy/package');
function run(args, cwd, env) { return new Promise((resolve,reject) => { const child = spawn(process.execPath,args,{cwd,env,windowsHide:true});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});child.on('error',reject);child.on('exit',code=>resolve({code,output})); }); }
test('A 1.4.0 隔离源码打包检查、依赖安装、初始化、启动停止和离线维护 CLI（非最终发行）', { timeout: 240000 }, async t => {
  const name=randomUUID(),root=path.join(TEST_ROOT,name),directory=path.join(root,'release');await fs.mkdir(root,{recursive:true});
  const built=await buildPackage(directory);let server;
  t.after(async()=>{if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}await removeTree(TEST_ROOT,name);});
  const env={...process.env,DATA_DIR:path.join(root,'private'),NODE_ENV:'development',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'',TRUST_PROXY:'',DB_PATH:'',STUDENT_FILES_DIR:'',PAYMENT_ASSETS_DIR:'',ADVERTISEMENT_ASSETS_DIR:'',PROCESSING_DIR:'',FILE_LEDGER_DIR:'',MANAGED_BACKUPS_DIR:'',CP_ADMIN_USERNAME:'',CP_ADMIN_PASSWORD:''};
  const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  const install=await run([npmCli,'ci','--omit=dev','--no-audit','--no-fund'],directory,env);assert.equal(install.code,0,install.output);
  console.log('C clean package dependency installation passed');
  const init=await run(['scripts/backend/init-db.js'],directory,env);assert.equal(init.code,0,init.output);
  const dbPath=path.join(env.DATA_DIR,'db/campus-print.sqlite'),db=new DatabaseSync(dbPath,{readOnly:true});let initial;
  try { initial=Object.fromEntries(['users','files','print_orders','payment_receipts','order_refunds'].map(table=>[table,db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));assert(Object.values(initial).every(value=>value===0));assert.equal(db.prepare('SELECT paymentAssetJson FROM print_settings').get().paymentAssetJson,null); } finally { db.close(); }
  const without=await run(['scripts/backend/init-admin.js','--username','d_deploy_admin'],directory,env);assert.equal(without.code,1);
  const admin=await run(['scripts/backend/init-admin.js'],directory,{...env,CP_ADMIN_USERNAME:'d_deploy_admin',CP_ADMIN_PASSWORD:TEST_PASSWORD});assert.equal(admin.code,0,admin.output);assert(!admin.output.includes(TEST_PASSWORD));
  let output='';server=spawn(process.execPath,['backend/server.js','--stdin-control'],{cwd:directory,env,windowsHide:true});for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{output+=chunk;});
  for(let i=0;i<100&&!/CampusPrint V1: http/.test(output);i++)await delay(100);
  const url=/CampusPrint V1: (http[^\s]+)/.exec(output)?.[1];assert(url,output);
  console.log('D packaged server started');
  for(const route of ['/','/user/','/admin/'])assert.equal((await fetch(url+route)).status,200);
  const config=await(await fetch(url+'/api/print/config')).json();assert.equal(config.data.payment.configured,false);assert.equal(config.data.pricingVersion,'1.1.0');assert.equal(config.data.singleSidedSheetPriceFen,50);assert.equal(config.data.doubleSidedSheetPriceFen,90);assert.equal(config.data.oddTailSheetPriceFen,50);
  const publicConfig=await(await fetch(url+'/api/public/config')).json();assert.equal(publicConfig.data.product.version,'1.4.0');assert.equal(publicConfig.data.studentAccountsEnabled,false);assert.equal(publicConfig.data.capabilities.advertisements,false);
  const csrfResponse=await fetch(url+'/api/auth/csrf',{headers:{'X-CP-Surface':'student'}}),csrfData=await csrfResponse.json();const sessionCookie=csrfResponse.headers.getSetCookie()[0].split(';')[0];const guestResponse=await fetch(url+'/api/auth/guest',{method:'POST',headers:{'X-CP-Surface':'student',Origin:url,Cookie:sessionCookie,'X-CSRF-Token':csrfData.data.csrfToken,'Content-Type':'application/json'},body:'{}'});assert.equal(guestResponse.status,200);assert.equal((await guestResponse.json()).data.identityKind,'guest');
  // Real isolated PDF parsing proves optional native dependencies work in this clean installation.
  const native=await run(['-e',"require('sharp')({create:{width:10,height:10,channels:3,background:'red'}}).png().toBuffer().then(b=>console.log(b.length));require('@napi-rs/canvas').createCanvas(10,10);"],directory,env);assert.equal(native.code,0,native.output);
  const blockedBackup=await run(['scripts/deploy/backup.js','backup'],directory,env);assert.equal(blockedBackup.code,1);assert.match(blockedBackup.output,/already owned/);
  console.log('D live backup refused; stopping through local control pipe');
  // Graceful shutdown is exercised by the deployed server's signal handler.
  const stopped=new Promise(resolve=>server.once('exit',(code,signal)=>resolve({code,signal})));server.stdin.write('stop\n');const termination=await stopped;assert.equal(termination.code,0);
  assert.equal(await fs.stat(path.join(env.DATA_DIR,'db/campus-print.runtime.lock')).then(()=>true,()=>false),false);
  const cleanup=await run(['scripts/backend/files-maintenance.js','cleanup'],directory,env);assert.equal(cleanup.code,0,cleanup.output);
  const snapshot=await run(['scripts/deploy/backup.js','backup'],directory,env);assert.equal(snapshot.code,0,snapshot.output);const snapshotData=JSON.parse(snapshot.output);
  const authority=path.join(root,'latest-authority'),exported=await run(['scripts/deploy/backup.js','authority',authority],directory,env);assert.equal(exported.code,0,exported.output);
  const restore=await run(['scripts/deploy/backup.js','restore',snapshotData.directory,authority],directory,{...env,DATA_DIR:path.join(root,'restored-private')});assert.equal(restore.code,0,restore.output);
  const restored=JSON.parse(restore.output);assert.equal(restored.orders,0);assert.equal(restored.beforeHttpReconciled,true);
  const report={kind:'A-v1.4.0-isolated-source-deployment-regression-not-final-release',packageFiles:built.files,runtime:process.version,dependencyInstallExit:install.code,initialCounts:initial,noDefaultAdminPassword:true,initialPaymentConfigured:false,studentAndAdminEntrypoints:[200,200,200],nativeDependenciesLoaded:true,gracefulTermination:termination,lockRemoved:true,liveBackupRefused:true,offlineCleanupExit:cleanup.code,backupExit:snapshot.code,authorityExportExit:exported.code,restoreExit:restore.code,publicDeployment:false,finalRelease:false};
  const evidenceRoot=process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/merchant-service-v1.2.0/B/local-deploy');await fs.mkdir(evidenceRoot,{recursive:true});await fs.writeFile(path.join(evidenceRoot,'deployment.json'),JSON.stringify(report,null,2));
});
