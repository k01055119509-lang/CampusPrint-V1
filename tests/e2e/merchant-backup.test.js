'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {isolated,Client,configAt,TEST_ROOT,PROJECT,removeTestStorage}=require('../helpers/runtime');
const {legacyFixture}=require('../helpers/legacy-guest');
const {startServer}=require('../../backend/server');
const {createSnapshot,restoreSnapshot,exportAuthority}=require('../../scripts/deploy/backup');
const {copyTree}=require('../../backend/files/backups');
const h=require('../business/helpers'),m=require('../business/merchant-helpers');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('B 1.2.0 广告有图快照恢复、旧快照兼容及存储边界', {timeout:120000},async t=>{
  let instant=new Date();const runtime=await isolated({clock:()=>new Date(instant),sessionMs:30*86400000,advertisementsEnabled:true}),admin=new Client(runtime);await admin.admin();const roots=[];const checks=[];
  t.after(async()=>{await runtime.destroy();for(const name of roots)await removeTestStorage(name);});
  const target=()=>{const name=randomUUID();roots.push(name);return configAt(path.join(TEST_ROOT,name),{clock:()=>new Date(),advertisementsEnabled:true});};
  let snapshot,authority;
  await t.test('有图恢复：双收款渠道、启用与停用广告、顺序和间隔与校验均保留',async()=>{
    h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));h.data(await m.image(admin,'/api/admin/payment-qr/alipay'));
    let ads=h.data(await m.image(admin,'/api/admin/advertisements',{kind:'advertisement'}),201);ads=h.data(await m.image(admin,'/api/admin/advertisements',{kind:'advertisement'}),201);
    ads=h.data(await admin.request('PATCH','/api/admin/advertisements/'+ads.items[0].id,{expectedVersion:ads.version,enabled:false,altText:'停用的合成广告'}));
    ads=h.data(await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:ads.version,intervalSeconds:2,order:ads.items.map(i=>i.id).reverse()}));
    snapshot=await createSnapshot(runtime);authority=path.join(runtime.root,'authority');await exportAuthority(runtime,authority);
    const config=target(),result=await restoreSnapshot({snapshotRoot:snapshot.directory,authorityRoot:authority,config});assert.equal(result.advertisements.files,2);assert.equal(result.advertisements.referenced,2);assert.equal(result.advertisements.legacyWithoutDirectory,false);
    const restored=await startServer(config);
    try{const reader=new Client(restored);await reader.csrfToken();const list=h.data(await reader.request('GET','/api/public/advertisements'));assert.equal(list.items.length,1);assert.equal(list.intervalSeconds,2);assert.equal(list.items[0].id,ads.items[0].id);assert.equal((await reader.request('GET',list.items[0].imageUrl,undefined,{raw:true})).status,200);assert.equal(restored.db.get('SELECT COUNT(*) n FROM sessions WHERE userId IS NOT NULL').n,0);for(const row of restored.db.all('SELECT assetJson FROM advertisements')){const asset=JSON.parse(row.assetJson);assert.equal(sha(await fs.readFile(path.join(config.advertisementRoot,asset.assetId+'.png'))),asset.sha256);}for(const channel of ['wechat','alipay'])assert.equal((await reader.request('GET','/api/public/payment-qr/'+channel,undefined,{raw:true})).status,200);}
    finally{await restored.close();}checks.push('two-channel-and-advertisement-assets-restored');
  });
  await t.test('损坏、丢图和链接在写目标库前拒绝；不生成可开放的半恢复实例',async()=>{
    for(const kind of ['corrupt','missing','link']){
      const source=path.join(runtime.root,'damaged-'+kind);await copyTree(snapshot.directory,source);const metadata=JSON.parse(await fs.readFile(path.join(source,'snapshot.json'),'utf8')),name=metadata.advertisementAssets[0].name,file=path.join(source,'advertisement-assets',name);
      if(kind==='corrupt')await fs.appendFile(file,'damage');else if(kind==='missing')await fs.unlink(file);else{await fs.unlink(file);await fs.link(path.join(snapshot.directory,'advertisement-assets',name),file);}
      try{const config=target();await assert.rejects(restoreSnapshot({snapshotRoot:source,config}),error=>error.code==='UNSAFE_STORAGE_PATH'||/checksum|reference|link|hard.?link/i.test(error.message));assert.equal(await fs.stat(config.dbPath).then(()=>true,()=>false),false);}
      finally{if(kind==='link')await fs.unlink(file);}
    }checks.push('damaged-and-linked-source-rejected-before-write');
  });
  await t.test('广告目标非空、嵌套、链接及authority重叠均拒绝',async()=>{
    const nonempty=target();await fs.mkdir(nonempty.advertisementRoot,{recursive:true});await fs.writeFile(path.join(nonempty.advertisementRoot,'keep.txt'),'keep');await assert.rejects(restoreSnapshot({snapshotRoot:snapshot.directory,config:nonempty}),/empty storage/);assert.equal(await fs.readFile(path.join(nonempty.advertisementRoot,'keep.txt'),'utf8'),'keep');
    const nested=target();nested.advertisementRoot=path.join(nested.fileRoot,'advertisements');await assert.rejects(restoreSnapshot({snapshotRoot:snapshot.directory,config:nested}),/disjoint/);
    const linked=target(),outside=target().advertisementRoot;await fs.mkdir(path.dirname(linked.advertisementRoot),{recursive:true});await fs.mkdir(outside,{recursive:true});await fs.symlink(outside,linked.advertisementRoot,'junction');try{await assert.rejects(restoreSnapshot({snapshotRoot:snapshot.directory,config:linked}),error=>error.code==='UNSAFE_STORAGE_PATH');}finally{await fs.unlink(linked.advertisementRoot);}
    await assert.rejects(exportAuthority(runtime,path.join(runtime.config.advertisementRoot,'authority')),/separate/);checks.push('advertisement-root-boundaries');
  });
  await t.test('真实七迁移1.1.0旧快照无广告目录可恢复，原账号订单金额保留并升104',async()=>{
    const name=randomUUID();roots.push(name);const root=path.join(TEST_ROOT,name),legacy=await legacyFixture(root),raw=new DatabaseSync(legacy.config.dbPath);
    for(const name of ['102-guest-access.sql','103-pricing-coupons.sql']){const sql=await fs.readFile(path.join(PROJECT,'backend/migrations',name),'utf8');raw.exec(sql);raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name,sha(sql),new Date().toISOString());}raw.close();
    const source=path.join(root,'old-snapshot');await fs.mkdir(source);await fs.copyFile(legacy.config.dbPath,path.join(source,'database.sqlite'));await fs.mkdir(path.join(source,'documents'));await fs.mkdir(path.join(source,'payment-assets'));const metadata={schemaVersion:1,product:'campus-print-v1',snapshotId:randomUUID(),createdAt:new Date().toISOString(),documents:[],complete:true,databaseSha256:sha(await fs.readFile(path.join(source,'database.sqlite')))};await fs.writeFile(path.join(source,'snapshot.json'),JSON.stringify(metadata));
    const config=target(),result=await restoreSnapshot({snapshotRoot:source,config});assert(result.advertisements.legacyWithoutDirectory);assert.equal(result.orders,1);
    const db=new DatabaseSync(config.dbPath,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n,10);const order=db.prepare('SELECT * FROM print_orders').get();assert.equal(order.totalAmountFen,1300);assert.equal(order.itemsJson,legacy.itemsJson);assert.equal(order.totalsJson,legacy.totalsJson);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM advertisements').get().n,0);}finally{db.close();}assert.deepEqual(await fs.readdir(config.advertisementRoot),[]);checks.push('real-1.1-seven-migration-snapshot-without-directory');
  });
  await t.test('送达七天清理学生及备份副本，不清理广告和收款图，过期恢复不复活文件',async()=>{
    const owner=new Client(runtime);await owner.guest();let order=await h.order(runtime,owner);order=await h.confirm(admin,order,{channel:'wechat'});order=await h.delivered(admin,order);const live=await createSnapshot(runtime);assert.equal(live.documents,1);
    instant=new Date(Date.parse(order.filesExpireAt)+1);await runtime.files.purgeExpiredFiles();const latest=path.join(runtime.root,'expired-authority');await exportAuthority(runtime,latest);assert.deepEqual(await fs.readdir(path.join(live.directory,'documents')),[]);assert.equal((await fs.readdir(path.join(live.directory,'advertisement-assets'))).length,2);assert.equal((await fs.readdir(runtime.config.advertisementRoot)).length,2);
    const config=target();config.clock=()=>new Date(instant);const result=await restoreSnapshot({snapshotRoot:live.directory,authorityRoot:latest,config});assert.equal(result.restoredFiles,0);assert.equal(result.advertisements.files,2);assert.equal(result.orders,1);checks.push('student-expiry-does-not-prune-business-images');
  });
  const output=process.env.CP_VERIFICATION_DIR;if(output){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'advertisement-backup-restore.json'),JSON.stringify({passed:checks.length===5,checks,usesIsolatedData:true,realBusinessDataUsed:false},null,2));}
});
