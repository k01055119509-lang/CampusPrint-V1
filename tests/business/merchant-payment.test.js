'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {isolated,Client}=require('../helpers/runtime');
const h=require('./helpers');
const m=require('./merchant-helpers');
test('微信/支付宝：独立配置、声明、恢复投影及人工核款',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);
  let config=h.data(await user.request('GET','/api/print/config'));assert.equal(config.payment.configured,false);assert.equal(config.payment.channels.length,2);
  let order=await h.order(runtime,user);
  const missing=await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:'软件声明'});assert.equal(missing.body.error.code,'PAYMENT_NOT_CONFIGURED');
  let settings=h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));assert.deepEqual(settings.payment.channels.map(c=>c.available),[true,false]);
  assert.equal((await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'alipay',reference:'软件声明'})).body.error.code,'PAYMENT_NOT_CONFIGURED');
  assert.equal((await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'other',reference:'软件声明'})).body.error.code,'PAYMENT_NOT_CONFIGURED');
  settings=h.data(await m.image(admin,'/api/admin/payment-qr/alipay'));assert(settings.payment.channels.every(c=>c.available));
  for(const channel of ['wechat','alipay']){const image=await new Client(runtime).request('GET','/api/public/payment-qr/'+channel,undefined,{raw:true});assert.equal(image.status,200);assert.match(image.headers.get('content-type'),/image\/png/);}
  const code=h.data(await user.request('GET',`/api/me/orders/${order.id}/query-code`)).queryCode;
  let recovered=h.data(await other.request('POST','/api/orders/recover',{queryCode:code}));assert.equal(recovered.accessType,'recovered');assert.deepEqual(recovered.payment.channels,settings.payment.channels);
  const submissionBody={expectedVersion:recovered.version,channel:'alipay',reference:'软件支付宝声明'},key=h.key();
  const first=await h.post(other,`/api/me/orders/${order.id}/payment-submissions`,submissionBody,key);recovered=h.data(first);
  assert.equal(recovered.payment.lastSubmittedChannel,'alipay');assert.equal(recovered.payment.confirmedAt,null);assert.equal(recovered.payment.status,'submitted');assert(!Object.hasOwn(recovered.payment,'submissions'));
  assert.equal(runtime.db.get('SELECT channel FROM payment_submissions WHERE orderId=?',order.id).channel,'alipay');assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts').n,0);
  h.data(await admin.request('DELETE','/api/admin/payment-qr/alipay',{expectedVersion:settings.version}));
  assert.deepEqual((await h.post(other,`/api/me/orders/${order.id}/payment-submissions`,submissionBody,key)).body,first.body);
  order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));order=await h.confirm(admin,order,{channel:'alipay'});assert.equal(order.payment.confirmedChannel,'alipay');assert.equal(order.payment.submissions[0].channel,'alipay');
  await m.evidence('merchant-payment',{initiallyEmpty:!config.payment.configured,configuredChannels:settings.payment.channels,lastSubmittedChannel:recovered.payment.lastSubmittedChannel,declaredOnly:recovered.payment.status,confirmedChannel:order.payment.confirmedChannel,recoveredContactAndFileDataHidden:!Object.hasOwn(recovered,'deliveryAddress')});
});
test('收款图片：版本冲突、异常格式、超限、磁盘/事务故障均保留原图',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {admin,user}=await h.actors(runtime);
  const service=runtime.context.orders.payments;let initial=h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));
  const original=service.asset('wechat'),target=path.join(runtime.config.paymentRoot,original.assetId+'.png');
  await t.test('权限、CSRF及渠道参数',async()=>{
    assert.equal((await m.image(user,'/api/admin/payment-qr/alipay',{version:initial.version})).status,403);
    const anon=new Client(runtime,{surface:'admin'});assert.equal((await m.image(anon,'/api/admin/payment-qr/alipay',{version:initial.version})).status,401);
    assert.equal((await m.image(admin,'/api/admin/payment-qr/alipay',{version:initial.version,headers:{'X-CSRF-Token':'invalid'}})).status,403);
    assert.equal((await m.image(admin,'/api/admin/payment-qr/other',{version:initial.version})).status,400);
    assert.equal((await admin.request('GET','/api/public/payment-qr/wechat?path=..')).status,400);
  });
  await t.test('错误图片、伪装、SVG、5MiB以上及旧设置版本',async()=>{
    for(const options of [{bytes:Buffer.from('<svg/>'),name:'bad.svg',mime:'image/svg+xml'},{bytes:Buffer.from('<html/>'),name:'bad.png'},{bytes:Buffer.from([137,80,78,71,13,10,26,10]),name:'bad.png'},{bytes:Buffer.alloc(5*1024*1024+1),name:'big.png'},{name:'bad.jpg'}]){
      const response=await m.image(admin,'/api/admin/payment-qr/wechat',{version:initial.version,...options});assert(response.status>=400);assert.equal(service.asset('wechat').assetId,original.assetId);
    }
    assert.equal((await m.image(admin,'/api/admin/payment-qr/wechat',{version:1})).body.error.code,'VERSION_CONFLICT');
    assert.deepEqual(await fs.readdir(runtime.config.tempRoot),[]);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,1);
  });
  await t.test('真实接收后数据库写入失败回滚',async()=>{
    runtime.db.raw.exec("CREATE TEMP TRIGGER fail_payment BEFORE UPDATE ON payment_channels BEGIN SELECT RAISE(ABORT,'injected'); END");
    try{assert.equal((await m.image(admin,'/api/admin/payment-qr/wechat',{version:initial.version})).status,500);}finally{runtime.db.raw.exec('DROP TRIGGER fail_payment');}
    assert.equal(service.asset('wechat').assetId,original.assetId);assert.equal(runtime.context.orders.settingsRow().version,initial.version);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,1);
  });
  await t.test('部分写入磁盘故障不发布孤儿资产',async()=>{
    const copy=fs.copyFile;
    fs.copyFile=async(src,dst,...args)=>{if(dst.startsWith(runtime.config.paymentRoot+path.sep)){await fs.writeFile(dst,'partial');throw Object.assign(new Error('injected'),{code:'EIO'});}return copy(src,dst,...args);};
    try{assert.equal((await m.image(admin,'/api/admin/payment-qr/wechat',{version:initial.version})).status,500);}finally{fs.copyFile=copy;}
    assert.equal(service.asset('wechat').assetId,original.assetId);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,1);assert((await fs.stat(target)).size>0);
  });
  await t.test('不可读渠道禁用且声明失败；替换清理不影响另一渠道',async()=>{
    const other=h.data(await m.image(admin,'/api/admin/payment-qr/alipay'));const alipayId=service.asset('alipay').assetId;
    await fs.rename(target,target+'.offline');
    const config=h.data(await user.request('GET','/api/print/config'));assert.equal(config.payment.channels[0].available,false);assert.equal(config.payment.configured,true);
    const order=await h.order(runtime,user);assert.equal((await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:'软件不可读声明'})).body.error.code,'PAYMENT_ASSET_UNAVAILABLE');
    assert.equal((await user.request('GET','/api/public/payment-qr/wechat')).status,503);await fs.rename(target+'.offline',target);
    const next=h.data(await m.image(admin,'/api/admin/payment-qr/wechat',{version:other.version}));assert.equal(service.asset('alipay').assetId,alipayId);await assert.rejects(fs.stat(target),{code:'ENOENT'});
    const partial=h.data(await admin.request('DELETE','/api/admin/payment-qr/wechat',{expectedVersion:next.version}));assert.equal(partial.payment.configured,true);
    const cleared=h.data(await admin.request('DELETE','/api/admin/payment-qr/alipay',{expectedVersion:partial.version}));assert.equal(cleared.payment.configured,false);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,0);
  });
});
test('双渠道同版本并发上传仅一项提交，新文件回收不覆盖配置',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {admin}=await h.actors(runtime);
  const results=await Promise.all(['wechat','alipay'].map(channel=>m.image(admin,'/api/admin/payment-qr/'+channel,{version:1})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(runtime.context.orders.settingsRow().version,2);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,1);
});
test('同毫秒先后声明不同渠道：最新声明按写入顺序而非随机UUID排序',async t=>{
  const instant=new Date(),runtime=await isolated({clock:()=>new Date(instant)});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);
  h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));h.data(await m.image(admin,'/api/admin/payment-qr/alipay'));
  let order=await h.order(runtime,user);
  order=h.data(await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:'软件第一份声明'}));
  // Force the earlier random identifier to sort after every possible later UUID.
  runtime.db.run('UPDATE payment_submissions SET id=? WHERE orderId=?','ffffffff-ffff-4fff-bfff-ffffffffffff',order.id);
  order=await h.action(admin,order,'payment-review',{action:'reject',reasonCode:'not_received'});
  order=h.data(await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'alipay',reference:'软件第二份声明'}));
  assert.equal(order.payment.lastSubmittedChannel,'alipay');assert.equal(order.payment.lastSubmittedAt,instant.toISOString());
  assert.deepEqual(order.payment.submissions.map(row=>row.channel),['wechat','alipay']);
  assert.equal(h.data(await admin.request('GET',`/api/admin/orders/${order.id}`)).payment.lastSubmittedChannel,'alipay');
  assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts').n,0);
});
