'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {isolated}=require('../helpers/runtime');
const h=require('./helpers');
const m=require('./merchant-helpers');
test('营业休息：服务端三入口、成功幂等重试和已有订单全流程',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);
  h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));
  const source=await h.upload(runtime,user),quote=await h.quote(runtime,user,source),body=h.orderBody(quote),key=h.key();
  const created=await h.post(user,'/api/orders',body,key);let order=h.data(created,201);
  const waiting=await h.quote(runtime,other,await h.upload(runtime,other));
  const settings=h.data(await admin.request('GET','/api/admin/settings'));
  assert.equal((await user.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false})).status,403);
  h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false}));
  const before={files:runtime.db.get('SELECT COUNT(*) n FROM files').n,temp:await fs.readdir(runtime.config.tempRoot)};
  const upload=await user.upload(await h.fixture('sample-chinese.png'),'test.png','image/png');
  const quoteFail=await h.post(other,'/api/print/quotes',{items:[{fileId:waiting.items[0].fileId,pages:'all',copies:1,duplex:false}]});
  const orderFail=await h.post(other,'/api/orders',h.orderBody(waiting));
  for(const response of [upload,quoteFail,orderFail]){assert.equal(response.status,409);assert.equal(response.body.error.code,'ORDERS_PAUSED');}
  assert.equal(runtime.db.get('SELECT COUNT(*) n FROM files').n,before.files);assert.deepEqual(await fs.readdir(runtime.config.tempRoot),before.temp);
  assert.deepEqual((await h.post(user,'/api/orders',body,key)).body,created.body);
  assert.equal((await user.request('GET',`/api/me/orders/${order.id}`)).status,200);
  order=h.data(await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:'软件休息期间声明'}));
  assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts').n,0);
  h.data(await h.post(user,`/api/me/orders/${order.id}/tickets`,{feedbackType:'delivery',subject:'软件售后',message:'休息期间处理已有订单'}),201);
  order=await h.confirm(admin,order,{channel:'wechat'});order=await h.delivered(admin,order);
  const expiry=order.filesExpireAt;
  const stopped=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:stopped.version,acceptingOrders:true}));
  const latest=h.data(await user.request('GET',`/api/me/orders/${order.id}`));assert.equal(latest.filesExpireAt,expiry);assert.equal(latest.totals.totalAmountFen,50);
  h.data(await h.post(other,'/api/orders',h.orderBody(waiting)),201);
  await m.evidence('merchant-paused',{rejections:[upload,quoteFail,orderFail].map(r=>({status:r.status,code:r.body.error.code})),idempotentOrderPreserved:true,existingOrderCompleted:latest.lifecycle==='completed',expiryUnchanged:true});
});
test('请求已被接受的上传可在切为休息后完成',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);
  const original=runtime.files.upload.bind(runtime.files);let accepted,release;
  const entered=new Promise(resolve=>{accepted=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  runtime.files.upload=async req=>{accepted();await gate;return original(req);};
  const pending=user.upload(await h.fixture('sample-chinese.png'),'accepted.png','image/png');await entered;
  try{const settings=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false}));}finally{release();}
  h.data(await pending,202);await runtime.files.waitForIdle();assert.equal(runtime.db.get('SELECT COUNT(*) n FROM files').n,1);
  assert.equal((await user.upload(await h.fixture('sample-chinese.png'),'later.png','image/png')).body.error.code,'ORDERS_PAUSED');
});
