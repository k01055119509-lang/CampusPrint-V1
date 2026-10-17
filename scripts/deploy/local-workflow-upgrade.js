'use strict';
// Explicit local delivery action. Never invoked by automated test suites.
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {loadConfig}=require('../../backend/config'),{check}=require('./check-workflow-upgrade'),{audit}=require('./audit-workflow-local');
const ROOT=path.resolve(__dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  const output=path.resolve(process.argv[2]),directory=path.resolve(process.argv[3]);
  const tests=JSON.parse(await fs.readFile(path.join(output,'final-tests.json'),'utf8')),release=JSON.parse(await fs.readFile(path.join(output,'release-smoke.json'),'utf8')),archive=JSON.parse(await fs.readFile(path.join(output,'release-archive.json'),'utf8'));
  if(!tests.passed||tests.productVersion!=='1.3.0'||!release.passed||release.productVersion!=='1.3.0'||release.legacyUpgrade.fromMigrations!==8||release.legacyUpgrade.toMigrations!==9||!release.desktopLauncher.executed||release.legacyUpgrade.merchantAssets.restoredAdvertisements!==2)throw Error('Delivery gates are incomplete');
  if(archive.sha256!==release.archiveSha256||sha(await fs.readFile(archive.archive))!==archive.sha256)throw Error('Archive differs from the tested archive');
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'package-manifest.json'),'utf8'));if(manifest.version!=='1.3.0')throw Error('Package version mismatch');
  for(const row of manifest.files.filter(row=>!['package.json','package-lock.json'].includes(row.path)))if(sha(await fs.readFile(path.join(ROOT,row.path)))!==row.sha256)throw Error('Local runtime differs from tested release: '+row.path);
  const preflight=await check(output),config=loadConfig();
  const exe=path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const started=await new Promise((resolve,reject)=>{const child=spawn(exe,['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(ROOT,'scripts/desktop/open-campus-print.ps1'),'-View','user','-SkipBrowser'],{cwd:ROOT,env:{...process.env,ADVERTISEMENTS_ENABLED:'false'},windowsHide:true});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('exit',code=>{child.stdout.destroy();child.stderr.destroy();resolve({code,output});});});
  await fs.writeFile(path.join(output,'local-start-command.json'),JSON.stringify(started,null,2));if(started.code!==0)throw Error('Formal launcher failed: '+started.output);
  const base='http://127.0.0.1:4328',publicConfig=(await(await fetch(base+'/api/public/config')).json()).data,print=(await(await fetch(base+'/api/print/config')).json()).data,ads=(await(await fetch(base+'/api/public/advertisements')).json()).data;
  if(publicConfig.product.version!=='1.3.0'||publicConfig.capabilities.advertisements!==false||publicConfig.studentAccountsEnabled!==false||print.pricingVersion!=='1.1.0'||ads.enabled!==false||ads.items.length)throw Error('Formal version/capabilities mismatch');
  const pages={};for(const route of ['/','/user/','/admin/'])pages[route]=(await fetch(base+route)).status;if(Object.values(pages).some(status=>status!==200))throw Error('Formal page entrypoint failed');
  const anonymousAdminStatus=(await fetch(base+'/api/admin/dashboard',{headers:{'X-CP-Surface':'admin'}})).status;if(anonymousAdminStatus!==401)throw Error('Anonymous administrator gate failed');
  const images=[];for(const item of print.payment.channels){if(!item.available||!item.imageUrl)throw Error('Existing payment channel unavailable');const response=await fetch(base+item.imageUrl);if(response.status!==200)throw Error('Formal payment image failed');images.push({channel:item.channel,status:response.status,sha256:sha(Buffer.from(await response.arrayBuffer()))});}
  const local=await audit(output,'after'),before=JSON.parse(await fs.readFile(path.join(output,'local-before.json'),'utf8'));
  const allowed=new Set(['schema_migrations','file_cleanup_runs','general_feedback','general_feedback_updates']);if(local.changedTables.some(name=>!allowed.has(name))||local.migrations.length!==9)throw Error('Original formal business data changed: '+local.changedTables.join(', '));
  if(JSON.stringify(before.assets)!==JSON.stringify(local.assets)||before.ledgerSha256!==local.ledgerSha256)throw Error('Formal images or retention ledger changed');
  const db=new DatabaseSync(config.dbPath,{readOnly:true});let oldAdStatuses;
  try{oldAdStatuses=await Promise.all(db.prepare('SELECT id FROM advertisements').all().map(async row=>(await fetch(base+'/api/public/advertisements/'+row.id+'/image')).status));}finally{db.close();}if(oldAdStatuses.some(status=>status!==403))throw Error('Historical advertisement URL readable while disabled');
  const instance=JSON.parse(await fs.readFile(path.join(ROOT,'var/desktop-control/instance.json'),'utf8'));process.kill(instance.pid,0);
  const report={at:new Date().toISOString(),passed:true,productVersion:'1.3.0',pricingVersion:'1.1.0',launcherExit:0,instance:{pid:instance.pid,startedAt:instance.startedAt,url:instance.url},entrypoints:pages,anonymousAdminStatus,studentAccountsEnabled:false,advertisementsEnabled:false,migrations:local.migrations,originalBusinessColumnsUnchanged:true,originalStudentFilesVerified:preflight.originalFilesVerified,originalImagesUnchanged:true,retentionLedgerUnchanged:true,business:{orders:local.orders,identities:local.identities,counts:local.counts,merchantExists:local.merchantExists},paymentImages:images,legacyAdvertisementStatuses:oldAdStatuses,realBusinessMutationsPerformed:false,studentGuestCreatedBySmoke:false};
  await fs.writeFile(path.join(output,'local-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,version:'1.3.0',migrations:9,pid:instance.pid,paymentImages:images.length,advertisementsVisible:0,originalBusinessColumnsUnchanged:true}));
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
