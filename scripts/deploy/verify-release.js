'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {ROOT,inside}=require('../../backend/config');
const {legacyFixture}=require('../../tests/helpers/legacy-guest');
async function checkDesktop(directory,root){
  if(process.platform!=='win32')return {executed:false,reason:'Windows desktop launcher'};
  const net=require('node:net'),probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'',TRUST_PROXY:'',DATA_DIR:path.join(root,'desktop-private'),DB_PATH:'',STUDENT_FILES_DIR:'',PAYMENT_ASSETS_DIR:'',ADVERTISEMENT_ASSETS_DIR:'',PROCESSING_DIR:'',FILE_LEDGER_DIR:'',MANAGED_BACKUPS_DIR:'',STUDENT_ACCOUNTS_ENABLED:'false'};
  const exe=path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const run=view=>new Promise((resolve,reject)=>{const child=spawn(exe,['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(directory,'scripts/desktop/open-campus-print.ps1'),'-View',view,'-SkipBrowser'],{cwd:directory,env,windowsHide:true});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});
  let started,stopped;
  try{started=await run('user');if(started.code!==0)throw Error('Packaged desktop start failed: '+started.output);const payload=await(await fetch('http://127.0.0.1:'+port+'/api/public/config')).json();if(payload.data.product.version!=='1.2.0')throw Error('Packaged desktop version mismatch');}
  finally{stopped=await run('stop');if(stopped.code!==0)throw Error('Packaged desktop stop failed: '+stopped.output);}
  return {executed:true,windowsPowerShell5:true,startExit:started.code,stopExit:stopped.code,version:'1.2.0',separatePrivateStorage:true};
}
async function main(){
  const evidence=JSON.parse(await fs.readFile(process.argv[2],'utf8')),directory=path.resolve(evidence.extractedDirectory),root=path.dirname(directory);
  if(!inside(path.join(ROOT,'tmp/tests'),root))throw Error('Only isolated extracted releases may be tested');
  const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  const installed=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[npmCli,'ci','--omit=dev','--no-audit','--no-fund'],{cwd:directory,windowsHide:true});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});child.on('error',reject);child.on('exit',code=>resolve({code,output}));});
  if(installed.code!==0)throw Error(installed.output);
  const data=path.join(root,'private'),startServer=require(path.join(directory,'backend/server')).startServer;
  const runtime=await startServer({host:'127.0.0.1',port:0,dataDir:data,dbPath:path.join(data,'db/campus-print.sqlite'),fileRoot:path.join(data,'student-files'),paymentRoot:path.join(data,'payment-assets'),tempRoot:path.join(data,'processing'),ledgerRoot:path.join(data,'ledger'),backupRoot:path.join(data,'managed-backups')});
  let report;
  try{
    const counts=Object.fromEntries(['users','files','print_orders','payment_receipts','order_refunds','coupons','advertisements'].map(table=>[table,runtime.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));if(Object.values(counts).some(count=>count!==0))throw Error('Extracted package contains business data');
    const statuses=[];for(const route of ['/','/user/','/admin/'])statuses.push((await fetch(runtime.url+route)).status);if(statuses.some(status=>status!==200))throw Error('Package entrypoint failed');
    const publicConfig=(await(await fetch(runtime.url+'/api/public/config')).json()).data,config=(await(await fetch(runtime.url+'/api/print/config')).json()).data;
    if(publicConfig.product.version!=='1.2.0'||publicConfig.studentAccountsEnabled!==false||config.pricingVersion!=='1.1.0'||config.doubleSidedSheetPriceFen!==90||config.payment.configured)throw Error('Release configuration mismatch');
    const cookies=new Map(),tokens=new Map();
    async function call(surface,method,route,body,form=false,extraHeaders={}){
      const response=await fetch(runtime.url+'/api'+route,{method,headers:{'X-CP-Surface':surface,Origin:runtime.url,Cookie:[...cookies].map(([name,value])=>name+'='+value).join('; '),...(method==='GET'?{}:{'X-CSRF-Token':tokens.get(surface)||'','Idempotency-Key':randomUUID()}),...(body&&!form?{'Content-Type':'application/json'}:{}),...extraHeaders},body:body===undefined?undefined:form?body:JSON.stringify(body)});
      for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');if(pair.slice(at+1))cookies.set(pair.slice(0,at),pair.slice(at+1));else cookies.delete(pair.slice(0,at));}
      const payload=await response.json();if(response.headers.get('x-csrf-token'))tokens.set(surface,response.headers.get('x-csrf-token'));if(route==='/auth/csrf'&&payload.success)tokens.set(surface,payload.data.csrfToken);
      if(!response.ok||!payload.success)throw Error('Packaged request failed: '+method+' '+route+' '+response.status+' '+payload.error?.code);return payload.data;
    }
    await call('student','GET','/auth/csrf');const guest=await call('student','POST','/auth/guest',{});if(guest.identityKind!=='guest')throw Error('Guest bootstrap failed');
    const password='Clean1'+randomUUID().replaceAll('-','').slice(0,6),username='clean_release_admin';await require(path.join(directory,'backend/auth')).createAdmin(runtime.db,runtime.config,{username,password,nickname:'隔离发行验证'});
    await call('admin','GET','/auth/csrf');await call('admin','POST','/auth/admin-login',{username,password});if((await call('student','GET','/auth/me')).id!==guest.id)throw Error('Surface identity collision');
    const batch=await call('admin','POST','/admin/coupon-batches',{type:'discount',payRatePercent:85});const revealed=await call('admin','POST','/admin/coupons/reveal-codes',{couponIds:[batch.coupons[0].id]});
    const form=new FormData();form.append('file',new Blob([await fs.readFile(path.join(ROOT,'tests/fixtures/sample-chinese.pdf'))],{type:'application/pdf'}),'clean-fixture.pdf');const file=await call('student','POST','/files',form,true);await runtime.files.waitForIdle();
    let quote=await call('student','POST','/print/quotes',{items:[{fileId:file.id,pages:'all',copies:1,duplex:true}],couponCode:revealed.items[0].code});await runtime.files.waitForIdle();quote=await call('student','GET','/print/quotes/'+quote.id);if(!quote.valid||quote.totalAmountFen!==43||quote.discountAmountFen!==7)throw Error('Packaged coupon pricing failed');
    const order=await call('student','POST','/orders',{quoteId:quote.id,quoteFingerprint:quote.fingerprint,deliveryAddress:{buildingId:'local-dorm',room:'clean-release',contact:'',notes:''},confirmedPreview:true,acceptedRules:true});if(order.totals.totalAmountFen!==43)throw Error('Packaged order amount mismatch');
    const fixture=await fs.readFile(path.join(ROOT,'tests/fixtures/sample-chinese.png'));
    for(const channel of ['wechat','alipay']){const settings=await call('admin','GET','/admin/settings'),body=new FormData();body.append('file',new Blob([fixture],{type:'image/png'}),'software-payment.png');await call('admin','POST','/admin/payment-qr/'+channel,body,true,{'X-Settings-Version':String(settings.version)});}
    for(let i=0;i<2;i++){const current=await call('admin','GET','/admin/advertisements'),body=new FormData();body.append('file',new Blob([fixture],{type:'image/png'}),'software-ad.png');await call('admin','POST','/admin/advertisements',body,true,{'X-Advertisements-Version':String(current.version)});}
    const ads=await call('student','GET','/public/advertisements');if(ads.items.length!==2)throw Error('Packaged advertisement route failed');
    for(const item of ads.items)if((await fetch(runtime.url+item.imageUrl)).status!==200)throw Error('Packaged advertisement asset failed');
    const backupTools=require(path.join(directory,'scripts/deploy/backup')),snapshot=await backupTools.createSnapshot(runtime),authority=path.join(root,'archive-authority');await backupTools.exportAuthority(runtime,authority);
    const restoredRoot=path.join(root,'archive-restored'),restoredConfig=require('../../tests/helpers/runtime').configAt(restoredRoot,{clock:runtime.config.clock});
    const restored=await backupTools.restoreSnapshot({snapshotRoot:snapshot.directory,authorityRoot:authority,config:restoredConfig});if(restored.advertisements.referenced!==2||restored.orders!==1)throw Error('Packaged advertisement backup/restore failed');
    require(path.join(directory,'node_modules/@napi-rs/canvas')).createCanvas(10,10);await require(path.join(directory,'node_modules/sharp'))({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
    report={kind:'B-v1.2.0-archive-clean-install-live-api',archiveSha256:evidence.sha256,zipChecksumsMatched:true,verifiedFiles:evidence.verifiedFiles,installExit:installed.code,emptyCounts:counts,entrypointStatuses:statuses,productVersion:publicConfig.product.version,pricingVersion:config.pricingVersion,studentAccountsEnabled:false,guestBootstrap:true,dualSurfaceIdentity:true,adminLogin:true,liveCouponQuote:{printAmountFen:50,discountAmountFen:7,totalAmountFen:43},liveCouponOrder:true,nativeDependenciesLoaded:true,initialPaymentConfigured:false,merchantAssets:{channels:2,advertisements:2,restoredAdvertisements:restored.advertisements.referenced,imagesReturned200:true},publicDeployment:false};
  }finally{await runtime.close();}
  const legacy=await legacyFixture(path.join(root,'upgrade-private')),raw=new DatabaseSync(legacy.config.dbPath),sha=value=>createHash('sha256').update(value).digest('hex'),stamp=new Date().toISOString();
  const image=await fs.readFile(path.join(ROOT,'tests/fixtures/sample-chinese.png')),assetId=randomUUID(),ticketId=randomUUID(),batchId=randomUUID(),couponId=randomUUID(),code='2'.repeat(25),expiry=new Date(Date.now()+86400000).toISOString();let oldTables;
  try{
    for(const name of ['102-guest-access.sql','103-pricing-coupons.sql']){const sql=await fs.readFile(path.join(directory,'backend/migrations',name),'utf8');raw.exec(sql);raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name,sha(sql),stamp);}
    raw.prepare('UPDATE print_settings SET paymentAssetJson=? WHERE id=1').run(JSON.stringify({assetId,mimeType:'image/png',byteSize:image.length,sha256:sha(image)}));
    raw.prepare("INSERT INTO order_tickets(id,orderId,userId,subject,status,version,createdAt,updatedAt) VALUES(?,?,?,?,'open',1,?,?)").run(ticketId,legacy.orderId,legacy.users.student.id,'1.1历史工单',stamp,stamp);
    raw.prepare('INSERT INTO coupon_batches(id,quantity,rulesJson,createdAt,expiresAt,createdBy) VALUES(?,1,?,?,?,?)').run(batchId,'{}',stamp,expiry,legacy.users.admin.id);
    raw.prepare("INSERT INTO coupons(id,batchId,codeHash,code,type,minPrintAmountFen,payRatePercent,createdAt,expiresAt,createdBy) VALUES(?,?,?,?,'discount',0,85,?,?,?)").run(couponId,batchId,sha(code),code,stamp,expiry,legacy.users.admin.id);
    oldTables=Object.fromEntries(['users','print_orders','coupons','coupon_batches','payment_receipts','order_refunds'].map(table=>[table,sha(JSON.stringify(raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))]));
  }finally{raw.close();}
  await fs.mkdir(legacy.config.paymentRoot,{recursive:true});await fs.writeFile(path.join(legacy.config.paymentRoot,assetId+'.png'),image);
  const upgraded=await startServer(legacy.config);
  try{const row=upgraded.db.get('SELECT itemsJson,totalsJson,addressJson,totalAmountFen FROM print_orders WHERE id=?',legacy.orderId);if(row.itemsJson!==legacy.itemsJson||row.totalsJson!==legacy.totalsJson||row.addressJson!==legacy.addressJson||row.totalAmountFen!==1300)throw Error('Packaged legacy snapshots changed');for(const [table,digest]of Object.entries(oldTables))if(sha(JSON.stringify(upgraded.db.all(`SELECT * FROM ${table} ORDER BY rowid`)))!==digest)throw Error('Packaged old data changed: '+table);const payment=upgraded.context.orders.printConfig().payment;if(!payment.legacy.available||payment.channels.some(item=>item.configured))throw Error('Packaged legacy QR compatibility failed');const ticket=upgraded.db.get('SELECT feedbackType,contactValue FROM order_tickets WHERE id=?',ticketId);if(ticket.feedbackType!=='other'||ticket.contactValue!==null)throw Error('Packaged historical ticket compatibility failed');report.legacyUpgrade={fromMigrations:7,amountFen:row.totalAmountFen,snapshotsUnchanged:true,preservedTables:Object.keys(oldTables),legacyQrUnassigned:true,historicalTicketCompatible:true,migrations:upgraded.db.all('SELECT version FROM schema_migrations ORDER BY version').map(row=>row.version),queryCodeCreated:upgraded.db.get('SELECT COUNT(*) AS n FROM order_query_codes').n===1,oldStudentSessionRevoked:upgraded.db.get('SELECT COUNT(*) AS n FROM sessions WHERE tokenHash=?',legacy.sessions.student.tokenHash).n===0};}finally{await upgraded.close();}
  report.desktopLauncher=await checkDesktop(directory,root);
  const output=process.env.CP_VERIFICATION_DIR||path.join(ROOT,'docs/verification/merchant-service-v1.2.0/B/local-release');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'release-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({installExit:0,passed:true,archiveSha256:evidence.sha256,liveCouponOrder:true,legacyUpgrade:true}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
