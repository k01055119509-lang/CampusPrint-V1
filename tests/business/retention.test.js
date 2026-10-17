'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {backup}=require('node:sqlite');
const {startServer}=require('../../backend/server');
const {removeTree}=require('../../backend/files/safety');
const {isolated,Client,configAt,TEST_ROOT,TEST_PASSWORD,PROJECT}=require('../helpers/runtime');
const h=require('./helpers');

test('售后重印和到期后退款不重算完成时间；日净收款可为负',async t=>{
  let instant=new Date('2026-10-14T04:00:00.000Z');const runtime=await isolated({clock:()=>new Date(instant),sessionMs:30*86400000});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);
  let value=await h.confirm(admin,await h.order(runtime,user,{copies:2}));value=await h.delivered(admin,value);const completedAt=value.completedAt,expiry=value.filesExpireAt;
  instant=new Date(instant.getTime()+6*86400000);
  value=await h.action(admin,value,'production-action',{action:'reprint',note:'软件模拟售后重印'});value=await h.action(admin,value,'production-action',{action:'reprint_fail',completedContentPages:1,note:'软件重印卡纸'});
  value=await h.action(admin,value,'production-action',{action:'reprint_retry',note:'只重试剩余一份',independentCopiesConfirmed:true});value=await h.action(admin,value,'production-action',{action:'reprint_complete',actualCompletionConfirmed:true});
  assert.equal(value.completedAt,completedAt);assert.equal(value.filesExpireAt,expiry);assert.equal(value.lifecycle,'completed');assert.equal(value.production.attempt,3);
  instant=new Date(expiry);await runtime.files.purgeExpiredFiles();
  value=await h.action(admin,value,'refunds',{action:'request',amountFen:50,reason:'文件已清理仍能处理文字售后退款'});const refundId=value.refunds[0].id;
  value=await h.action(admin,value,'refunds',{action:'approve',refundId,note:'人工批准，不转账',fulfillmentDecision:'resume'});
  value=await h.action(admin,value,'refunds',{action:'paid_out',refundId,note:'软件实际退款记录，无真实资金',payoutReference:'POST-EXPIRY-SOFTWARE',actualRefundConfirmed:true,fulfillmentDecision:'resume'});
  assert.equal(value.fileAvailability,'deleted');assert.equal(value.completedAt,completedAt);assert.equal(value.filesExpireAt,expiry);assert.equal(value.payment.receipt.amountFen,100);
  const dashboard=h.data(await admin.request('GET','/api/admin/dashboard'));assert.equal(dashboard.netReceivedFen,50);assert.equal(dashboard.today.confirmedReceivedFen,0);assert.equal(dashboard.today.actualRefundFen,50);assert.equal(dashboard.today.netReceivedFen,-50);
});

test('送达与期限事务一起回滚；删除失败禁访问并重试，不误删未完成订单',async t=>{
  let instant=new Date('2026-10-14T04:00:00.000Z'),failOnce=false;
  const runtime=await isolated({clock:()=>new Date(instant),sessionMs:30*86400000,studentAccountsEnabled:true,fileServiceOptions:{deleteTree:async(root,name)=>{if(failOnce&&root.endsWith('student-files')){failOnce=false;throw Object.assign(new Error('isolated deletion failure'),{code:'EACCES'});}return removeTree(root,name);}}});t.after(()=>runtime.destroy());
  const {user,admin}=await h.actors(runtime);let value=await h.confirm(admin,await h.order(runtime,user));const unfinished=await h.order(runtime,user);
  value=await h.action(admin,value,'production-action',{action:'start'});value=await h.action(admin,value,'production-action',{action:'complete',actualCompletionConfirmed:true});value=await h.action(admin,value,'delivery-action',{action:'start'});
  const expiryFunction=runtime.files.setOrderFileExpiry.bind(runtime.files);runtime.files.setOrderFileExpiry=args=>{expiryFunction(args);throw new (require('../../backend/errors').ApiError)(503,'SERVICE_UNAVAILABLE','软件注入提交前失败');};
  const result=await h.post(admin,`/api/admin/orders/${value.id}/delivery-action`,{expectedVersion:value.version,action:'delivered',actualDeliveryConfirmed:true});assert.equal(result.status,503);
  assert.equal(h.data(await admin.request('GET',`/api/admin/orders/${value.id}`)).completedAt,null);assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE claimedOrderId=?',value.id).expiresAt,null);assert.equal(runtime.files.ledger.facts.get(value.items[0].fileId).expiresAt,null);
  runtime.files.setOrderFileExpiry=expiryFunction;value=await h.action(admin,value,'delivery-action',{action:'delivered',actualDeliveryConfirmed:true});instant=new Date(value.filesExpireAt);failOnce=true;
  const first=await runtime.files.purgeExpiredFiles();assert.equal(first.failed,1);assert.equal(h.data(await user.request('GET',`/api/me/orders/${value.id}`)).fileAvailability,'expired');assert.equal((await admin.request('GET',`/api/admin/orders/${value.id}/items/${value.items[0].itemId}/print-file`)).status,410);
  const second=await runtime.files.purgeExpiredFiles();assert.equal(second.purged,1);assert.equal((await runtime.files.purgeExpiredFiles()).purged,0);
  const live=h.data(await user.request('GET',`/api/me/orders/${unfinished.id}`));assert.equal(live.fileAvailability,'available');assert.equal(live.completedAt,null);assert.equal((await user.request('GET',`/api/me/orders/${live.id}/items/${live.items[0].itemId}/file`,undefined,{raw:true})).status,200);
});

test('停机恢复先清理，旧未完成快照不能复活已完成到期文件或重算期限',async t=>{
  const name=randomUUID(),root=path.join(TEST_ROOT,name);let instant=new Date('2026-10-14T04:00:00.000Z'),runtime;
  const options=configAt(root,{clock:()=>new Date(instant),sessionMs:30*86400000,studentAccountsEnabled:true});runtime=await startServer(options);
  t.after(async()=>{await runtime?.close();await removeTree(TEST_ROOT,name);});const {user,admin}=await h.actors(runtime);let value=await h.confirm(admin,await h.order(runtime,user));
  const snapshot=path.join(root,'db/pre-delivery.sqlite');await backup(runtime.db.raw,snapshot);value=await h.delivered(admin,value);const completedAt=value.completedAt,expiry=value.filesExpireAt;
  const body={expectedVersion:value.version,action:'reprint',note:'停机前售后记录'},headers=h.key();const first=await h.post(admin,`/api/admin/orders/${value.id}/production-action`,body,headers);value=h.data(first);
  await runtime.close();instant=new Date(expiry);runtime=await startServer(options);
  const reuser=new Client(runtime),readmin=new Client(runtime,{surface:'admin'});await reuser.csrfToken();h.data(await reuser.request('POST','/api/auth/login',{username:user.user.username,password:TEST_PASSWORD}));await readmin.csrfToken();h.data(await readmin.request('POST','/api/auth/admin-login',{username:admin.user.username,password:TEST_PASSWORD}));
  const persisted=h.data(await reuser.request('GET',`/api/me/orders/${value.id}`));assert.equal(persisted.fileAvailability,'deleted');assert.equal(persisted.completedAt,completedAt);assert.equal(persisted.filesExpireAt,expiry);
  assert.deepEqual((await h.post(readmin,`/api/admin/orders/${value.id}/production-action`,body,headers)).body,first.body);
  const stopped=await h.action(readmin,persisted,'production-action',{action:'reprint_fail',completedContentPages:0,note:'到期后记录停机事实，不再读取文件'});assert.equal(stopped.filesExpireAt,expiry);
  await runtime.close();await fs.copyFile(snapshot,options.dbPath);runtime=await startServer(options);
  const afterRestore=new Client(runtime,{surface:'admin'});await afterRestore.csrfToken();h.data(await afterRestore.request('POST','/api/auth/admin-login',{username:admin.user.username,password:TEST_PASSWORD}));
  const restored=h.data(await afterRestore.request('GET',`/api/admin/orders/${value.id}`));assert.equal(restored.lifecycle,'active');assert.equal(restored.fileAvailability,'deleted');assert(!restored.allowedActions.includes('start_print'));
  assert.equal((await afterRestore.request('GET',`/api/admin/orders/${value.id}/items/${value.items[0].itemId}/print-file`)).status,410);assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE id=?',value.items[0].fileId).expiresAt,expiry);
  const evidenceRoot = process.env.CP_VERIFICATION_DIR || path.join(PROJECT,'docs/verification/B');
  await fs.mkdir(evidenceRoot,{recursive:true}); await fs.writeFile(path.join(evidenceRoot,'restart-evidence.json'),JSON.stringify({kind:'B-isolated-restart-and-old-snapshot',completedAt,filesExpireAt:expiry,persistedFileAvailability:persisted.fileAvailability,restoredFileAvailability:restored.fileAvailability,restoredSnapshotLifecycle:restored.lifecycle,accessStatus:410,productionBlocked:true},null,2));
});
