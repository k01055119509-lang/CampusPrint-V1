'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {ROOT,inside}=require('../../backend/config');
const {legacyFixture}=require('../../tests/helpers/legacy-guest');
const {configAt,Client}=require('../../tests/helpers/runtime');
const h=require('../../tests/business/helpers');
const sha=value=>createHash('sha256').update(value).digest('hex');
function run(executable,args,cwd,env=process.env){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd,env,windowsHide:true});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});}
async function desktop(directory,root){
  if(process.platform!=='win32')throw Error('This delivery requires a Windows desktop launch check');
  const probe=require('node:net').createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'',TRUST_PROXY:'',DATA_DIR:path.join(root,'desktop-private'),DB_PATH:'',STUDENT_FILES_DIR:'',PAYMENT_ASSETS_DIR:'',ADVERTISEMENT_ASSETS_DIR:'',PROCESSING_DIR:'',FILE_LEDGER_DIR:'',MANAGED_BACKUPS_DIR:'',STUDENT_ACCOUNTS_ENABLED:'false',ADVERTISEMENTS_ENABLED:'false'};
  const exe=path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');let started,stopped,version;
  const launch=view=>run(exe,['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(directory,'scripts/desktop/open-campus-print.ps1'),'-View',view,'-SkipBrowser'],directory,env);
  try{started=await launch('user');if(started.code!==0)throw Error('Packaged desktop start failed: '+started.output);const data=(await(await fetch('http://127.0.0.1:'+port+'/api/public/config')).json()).data;version=data.product.version;if(version!=='1.3.0'||data.capabilities.advertisements!==false)throw Error('Packaged desktop configuration mismatch');}
  finally{stopped=await launch('stop');if(stopped.code!==0)throw Error('Packaged desktop stop failed: '+stopped.output);}
  return {executed:true,windowsPowerShell5:true,startExit:started.code,stopExit:stopped.code,version,advertisementsEnabled:false,separatePrivateStorage:true};
}
async function legacyUpgrade(directory,root){
  const target=path.join(root,'upgrade-private'),legacy=await legacyFixture(target),db=new DatabaseSync(legacy.config.dbPath),image=await h.fixture('sample-chinese.png'),stamp=new Date().toISOString(),assets=[];let old;
  try{
    for(const name of ['102-guest-access.sql','103-pricing-coupons.sql','104-merchant-service.sql']){const sql=await fs.readFile(path.join(directory,'backend/migrations',name),'utf8');db.exec(sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name,sha(sql),stamp);}
    for(const channel of ['wechat','alipay']){const asset={assetId:randomUUID(),mimeType:'image/png',byteSize:image.length,sha256:sha(image)};assets.push({root:'paymentRoot',...asset});db.prepare('UPDATE payment_channels SET assetJson=?,updatedAt=?,updatedBy=? WHERE channel=?').run(JSON.stringify(asset),stamp,legacy.users.admin.id,channel);}
    for(let n=0;n<2;n++){const asset={assetId:randomUUID(),mimeType:'image/png',byteSize:image.length,sha256:sha(image)};assets.push({root:'advertisementRoot',...asset});db.prepare('INSERT INTO advertisements(id,assetJson,enabled,position,altText,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),JSON.stringify(asset),n===0?1:0,n,'Historical software image',stamp,stamp);}
    db.prepare("UPDATE print_orders SET paymentStatus='confirmed',productionStatus='printed',deliveryStatus='delivered',lifecycle='completed',completedAt=?,filesExpireAt=? WHERE id=?").run(stamp,new Date(Date.parse(stamp)+7*86400000).toISOString(),legacy.orderId);
    db.prepare("INSERT INTO payment_receipts(id,orderId,amountFen,channel,reference,referenceKey,confirmedAt,confirmedBy,note) VALUES(?,?,1300,'wechat','OLD-SOFTWARE-RECEIPT','old-software-receipt',?,?,'old software receipt')").run(randomUUID(),legacy.orderId,stamp,legacy.users.admin.id);
    if(db.prepare('SELECT count(*) n FROM schema_migrations').get().n!==8)throw Error('Legacy package test did not start at eight migrations');
    old=Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>[name,{columns:db.prepare(`PRAGMA table_info("${name}")`).all().map(row=>row.name),sha256:sha(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all().map(row=>JSON.stringify(row)).sort()))}]));
  }finally{db.close();}
  for(const asset of assets){await fs.mkdir(legacy.config[asset.root],{recursive:true});await fs.writeFile(path.join(legacy.config[asset.root],asset.assetId+'.png'),image);}
  const packaged=require(path.join(directory,'backend/server')),tools=require(path.join(directory,'scripts/deploy/backup'));
  const runtime=await packaged.startServer({...legacy.config,advertisementsEnabled:false});let backupProof;
  try{
    for(const [table,prior]of Object.entries(old))if(!['schema_migrations','sessions','file_cleanup_runs','order_query_codes'].includes(table)){const columns=prior.columns.map(name=>'"'+name+'"').join(',');if(sha(JSON.stringify(runtime.db.all(`SELECT ${columns} FROM "${table}"`).map(row=>JSON.stringify(row)).sort()))!==prior.sha256)throw Error('Packaged upgrade altered old columns: '+table);}
    const order=runtime.db.get('SELECT * FROM print_orders WHERE id=?',legacy.orderId);if(order.itemsJson!==legacy.itemsJson||order.totalsJson!==legacy.totalsJson||order.addressJson!==legacy.addressJson||order.totalAmountFen!==1300||order.acceptedAt!==null)throw Error('Packaged legacy order snapshot/acceptance changed');
    if((await(await fetch(runtime.url+'/api/public/advertisements')).json()).data.items.length!==0)throw Error('Historical advertisements played while disabled');
    const sourceCompletion={completedAt:order.completedAt,filesExpireAt:order.filesExpireAt};
    const snapshot=await tools.createSnapshot(runtime),authority=path.join(root,'upgrade-authority');await tools.exportAuthority(runtime,authority);
    const restoredConfig=configAt(path.join(root,'upgrade-restored'),{advertisementsEnabled:false,clock:()=>new Date()}),restored=await tools.restoreSnapshot({snapshotRoot:snapshot.directory,authorityRoot:authority,config:restoredConfig});
    if(restored.advertisements.referenced!==2)throw Error('Packaged backup lost historical advertisement assets');
    const verify=await packaged.startServer(restoredConfig);
    try{const after=verify.db.get('SELECT completedAt,filesExpireAt FROM print_orders WHERE id=?',legacy.orderId);if(JSON.stringify(after)!==JSON.stringify(sourceCompletion))throw Error('Restoration changed completed order expiry');for(const asset of assets)if(sha(await fs.readFile(path.join(verify.config[asset.root],asset.assetId+'.png')))!==asset.sha256)throw Error('Restored merchant image mismatch');}
    finally{await verify.close();}
    const enabled=await packaged.startServer({...restoredConfig,advertisementsEnabled:true});try{const list=(await(await fetch(enabled.url+'/api/public/advertisements')).json()).data;if(list.items.length!==1||(await fetch(enabled.url+list.items[0].imageUrl)).status!==200)throw Error('Isolated re-enabled historical advertisement unreadable');}finally{await enabled.close();}
    backupProof={restoredAdvertisements:2,restoredPaymentImages:2,disabledBeforeAndAfterRestore:true,isolatedReenableImage200:true,completedExpiryPreserved:true};
    return {fromMigrations:8,toMigrations:runtime.db.get('SELECT count(*) n FROM schema_migrations').n,oldColumnsPreserved:true,amountFen:1300,noInferredAcceptanceTime:true,completedExpiryPreserved:true,merchantAssets:backupProof};
  }finally{await runtime.close();}
}
async function main(){
  const evidence=JSON.parse(await fs.readFile(process.argv[2],'utf8')),directory=path.resolve(evidence.extractedDirectory),root=path.dirname(directory),output=path.resolve(process.env.CP_VERIFICATION_DIR||path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/C/local-release'));
  if(!inside(path.join(ROOT,'tmp/tests'),root))throw Error('Only an isolated extracted archive may be tested');await fs.mkdir(output,{recursive:true});
  const installed=await run(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--no-audit','--no-fund'],directory);await fs.writeFile(path.join(output,'install.log'),installed.output);if(installed.code!==0)throw Error('Extracted archive install failed');
  const runtime=await require(path.join(directory,'backend/server')).startServer(configAt(path.join(root,'private')));let report;
  try{
    const counts=Object.fromEntries(['users','files','print_orders','payment_receipts','order_refunds','coupons','advertisements','general_feedback'].map(table=>[table,runtime.db.get(`SELECT count(*) n FROM ${table}`).n]));if(Object.values(counts).some(Boolean))throw Error('Release contains business data');
    const publicConfig=(await(await fetch(runtime.url+'/api/public/config')).json()).data,config=(await(await fetch(runtime.url+'/api/print/config')).json()).data;
    if(publicConfig.product.version!=='1.3.0'||publicConfig.capabilities.advertisements!==false||publicConfig.studentAccountsEnabled!==false||config.pricingVersion!=='1.1.0'||config.payment.configured)throw Error('Release default configuration mismatch');
    const entrypoints=[];for(const route of ['/','/user/','/admin/'])entrypoints.push((await fetch(runtime.url+route)).status);if(entrypoints.some(status=>status!==200))throw Error('Release entrypoint failed');
    const user=new Client(runtime),admin=new Client(runtime,{surface:'admin'});await user.guest();const username='release_operator',password='Rel9'+randomUUID().replaceAll('-','').slice(0,6);await require(path.join(directory,'backend/auth')).createAdmin(runtime.db,runtime.config,{username,password,nickname:'隔离发行检查'});await admin.csrfToken();h.data(await admin.request('POST','/api/auth/admin-login',{username,password}));
    const batch=h.data(await h.post(admin,'/api/admin/coupon-batches',{type:'discount',payRatePercent:85}),201),code=h.data(await h.post(admin,'/api/admin/coupons/reveal-codes',{couponIds:[batch.coupons[0].id]})).items[0].code;
    const image=await h.fixture('sample-chinese.png');for(const channel of ['wechat','alipay']){const settings=h.data(await admin.request('GET','/api/admin/settings')),form=new FormData();form.append('file',new Blob([image],{type:'image/png'}),'release-software.png');h.data(await admin.request('POST','/api/admin/payment-qr/'+channel,form,{form:true,headers:{'X-Settings-Version':String(settings.version)}}));}
    const file=await h.upload(runtime,user,'sample-chinese.pdf'),q0=h.data(await h.post(user,'/api/print/quotes',{items:[{fileId:file.id,pages:'all',copies:1,duplex:true}],couponCode:code}),202);await runtime.files.waitForIdle();const quote=h.data(await user.request('GET','/api/print/quotes/'+q0.id));if(quote.totalAmountFen!==43)throw Error('Packaged coupon quote incorrect');let order=h.data(await h.post(user,'/api/orders',h.orderBody(quote)),201);
    // Use the actual owner payment route; omitted reference is intentional in 1.3.0.
    order=h.data(await h.post(user,'/api/me/orders/'+order.id+'/payment-submissions',{expectedVersion:order.version,channel:'wechat'}));
    order=await h.confirm(admin,order,{channel:'wechat'});if(order.fulfillment.stage!=='in_progress'||order.production.status!=='not_started')throw Error('Packaged acceptance invented print completion');
    order=await h.action(admin,order,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});if(order.fulfillment.stage!=='completed'||Date.parse(order.filesExpireAt)-Date.parse(order.completedAt)!==7*86400000)throw Error('Packaged direct delivery/expiry failed');
    const general=h.data(await h.post(user,'/api/me/feedback',{message:'Isolated release feedback',contactType:'wechat',contactValue:'release-software-contact'}),201);h.data(await h.post(admin,'/api/admin/tickets/'+general.id+'/updates',{expectedVersion:general.version,message:'Release software reply',status:'resolved'}));const projected=h.data(await user.request('GET','/api/me/tickets/'+general.id));if(projected.category!=='general'||Object.hasOwn(projected,'contactValue'))throw Error('Packaged feedback isolation failed');
    require(path.join(directory,'node_modules/@napi-rs/canvas')).createCanvas(10,10);await require(path.join(directory,'node_modules/sharp'))({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
    report={kind:'C-v1.3.0-archive-clean-install-real-api',archiveSha256:evidence.sha256,zipChecksumsMatched:true,verifiedFiles:evidence.verifiedFiles,installExit:installed.code,emptyCounts:counts,entrypoints,productVersion:'1.3.0',pricingVersion:'1.1.0',studentAccountsEnabled:false,advertisementsEnabled:false,liveCouponOrderAmountFen:43,directTwoStepFulfillment:true,optionalPaymentReference:true,generalFeedbackReply:true,contactProjection:true,nativeDependenciesLoaded:true};
  }finally{await runtime.close();}
  report.legacyUpgrade=await legacyUpgrade(directory,root);report.desktopLauncher=await desktop(directory,root);report.passed=true;report.realMoney=report.realPrinting=report.realDelivery=report.realPhone=report.publicDeployment=false;
  await fs.writeFile(path.join(output,'release-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,installExit:0,version:'1.3.0',legacyUpgrade:'8-to-9',desktopLauncher:true,archiveSha256:evidence.sha256}));
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
