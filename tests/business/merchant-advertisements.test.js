'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {isolated,Client}=require('../helpers/runtime');
const h=require('./helpers');
const m=require('./merchant-helpers');
const upload=(admin,options={})=>m.image(admin,'/api/admin/advertisements',{kind:'advertisement',...options});
test('广告0/1/2/5张、上限、排序启停、间隔、权限和独立存储',async t=>{
  let instant=new Date();const runtime=await isolated({clock:()=>new Date(instant),advertisementsEnabled:true});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime),anon=new Client(runtime);
  const ads=runtime.context.advertisements;
  let publicConfig=h.data(await anon.request('GET','/api/public/advertisements'));assert.deepEqual(publicConfig,{enabled:true,version:1,intervalSeconds:5,items:[]});
  let state=h.data(await upload(admin),201);assert.equal(h.data(await anon.request('GET','/api/public/advertisements')).items.length,1);
  state=h.data(await upload(admin),201);assert.equal(h.data(await anon.request('GET','/api/public/advertisements')).items.length,2);
  while(state.items.length<5)state=h.data(await upload(admin),201);const ids=state.items.map(item=>item.id);
  assert.equal((await upload(admin)).body.error.code,'ADVERTISEMENT_LIMIT');assert.equal((await fs.readdir(runtime.config.advertisementRoot)).length,5);
  assert.equal((await upload(user,{version:state.version})).status,403);assert.equal((await upload(anon.forSurface('admin'),{version:state.version})).status,401);
  assert.equal((await upload(admin,{version:state.version,headers:{'X-CSRF-Token':'wrong'}})).status,403);
  const before=state.version;state=h.data(await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,intervalSeconds:2,order:[...ids].reverse()}));
  assert.deepEqual(state.items.map(item=>item.id),[...ids].reverse());assert.equal(state.intervalSeconds,2);
  assert.equal((await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:before,intervalSeconds:30})).body.error.code,'VERSION_CONFLICT');
  state=h.data(await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,intervalSeconds:30}));
  for(const intervalSeconds of [1,31,2.5,'5',null])assert.equal((await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,intervalSeconds})).status,400);
  for(const order of [ids.slice(1),[...ids.slice(1),ids[1]],[...ids.slice(1),'00000000-0000-4000-8000-000000000000']])assert.equal((await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,order,intervalSeconds:7})).status,400);
  assert.equal(ads.settings().intervalSeconds,30);assert.equal(ads.settings().version,state.version);
  const first=state.items[0];state=h.data(await admin.request('PATCH',`/api/admin/advertisements/${first.id}`,{expectedVersion:state.version,enabled:false,altText:'隔离广告替代文字'}));
  publicConfig=h.data(await anon.request('GET','/api/public/advertisements'));assert.equal(publicConfig.items.length,4);assert(!publicConfig.items.some(item=>item.id===first.id));
  assert.equal((await anon.request('GET',`/api/public/advertisements/${first.id}/image`)).status,404);
  assert.equal((await admin.request('GET',`/api/admin/advertisements/${first.id}/image`,undefined,{raw:true})).status,200);
  for(const item of publicConfig.items){const image=await anon.request('GET',item.imageUrl,undefined,{raw:true});assert.equal(image.status,200);assert.match(image.headers.get('cache-control'),/no-store/);assert.deepEqual(Object.keys(item).sort(),['altText','id','imageUrl']);}
  assert.equal((await anon.request('GET','/api/public/advertisements?path=../../')).status,400);
  assert.equal((await anon.request('GET','/api/public/advertisements/%2e%2e/image')).status,404);
  instant=new Date(instant.getTime()+8*86400000);await runtime.files.purgeExpiredFiles();assert.equal((await fs.readdir(runtime.config.advertisementRoot)).length,5);assert.equal((await fs.readdir(runtime.config.paymentRoot)).length,0);
  await m.evidence('merchant-advertisements',{empty:{version:1,intervalSeconds:5,items:[]},maximumStored:5,overLimit:'ADVERTISEMENT_LIMIT',publicConfig,minimumInterval:2,maximumInterval:30,studentRetentionDidNotRemoveAdvertisements:true});
});
test('广告替换、删除、失败回滚、可重试清理和并发版本',async t=>{
  const runtime=await isolated({advertisementsEnabled:true});t.after(()=>runtime.destroy());const {admin}=await h.actors(runtime),anon=new Client(runtime),ads=runtime.context.advertisements;
  let state=h.data(await upload(admin),201),id=state.items[0].id,old=JSON.parse(ads.row(id).assetJson);
  state=h.data(await admin.request('PATCH',`/api/admin/advertisements/${id}`,{expectedVersion:state.version,enabled:false,altText:'保留替代文字'}));
  await t.test('替换保留身份/顺序/启停；错误格式及事务失败不破坏原图',async()=>{
    for(const options of [{bytes:Buffer.from('<html/>')},{bytes:Buffer.alloc(5*1024*1024+1)},{bytes:Buffer.from('<svg/>'),name:'bad.svg',mime:'image/svg+xml'}])assert((await m.image(admin,`/api/admin/advertisements/${id}/image`,{kind:'advertisement',version:state.version,...options})).status>=400);
    runtime.db.raw.exec("CREATE TEMP TRIGGER fail_ad BEFORE UPDATE ON advertisements BEGIN SELECT RAISE(ABORT,'injected'); END");
    try{assert.equal((await m.image(admin,`/api/admin/advertisements/${id}/image`,{kind:'advertisement',version:state.version})).status,500);}finally{runtime.db.raw.exec('DROP TRIGGER fail_ad');}
    assert.equal(JSON.parse(ads.row(id).assetJson).assetId,old.assetId);assert.equal((await fs.readdir(runtime.config.advertisementRoot)).length,1);
    state=h.data(await m.image(admin,`/api/admin/advertisements/${id}/image`,{kind:'advertisement',version:state.version}));
    assert.equal(state.items[0].id,id);assert.equal(state.items[0].enabled,false);assert.equal(state.items[0].altText,'保留替代文字');await assert.rejects(fs.stat(path.join(ads.root,old.assetId+'.png')),{code:'ENOENT'});
  });
  await t.test('删除先撤销引用，磁盘删除失败持久化并重试',async()=>{
    const remove=ads.deleteAsset.bind(ads);ads.deleteAsset=async()=>{throw Object.assign(new Error('injected'),{code:'EBUSY'});};
    try{state=h.data(await admin.request('DELETE',`/api/admin/advertisements/${id}`,{expectedVersion:state.version}));}finally{ads.deleteAsset=remove;}
    assert.equal(state.items.length,0);assert.equal(state.cleanup.length,1);assert.equal(state.cleanup[0].lastError,'EBUSY');assert.equal((await anon.request('GET',`/api/public/advertisements/${id}/image`)).status,404);
    await ads.drain();assert.equal(ads.cleanupStatus().length,0);assert.deepEqual(await fs.readdir(ads.root),[]);
    h.data(await admin.request('DELETE',`/api/admin/advertisements/${id}`,{expectedVersion:state.version}));
  });
  await t.test('同版本两个真实上传仅一个提交；同版本设置竞争不相互覆盖',async()=>{
    const results=await Promise.all([upload(admin,{version:state.version}),upload(admin,{version:state.version})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    state=ads.list(true);assert.equal(state.items.length,1);assert.equal((await fs.readdir(ads.root)).length,1);
    const updates=await Promise.all([admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,intervalSeconds:2}),admin.request('PATCH','/api/admin/advertisements',{expectedVersion:state.version,intervalSeconds:30})]);assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
    assert.deepEqual(await fs.readdir(runtime.config.tempRoot),[]);
  });
});
