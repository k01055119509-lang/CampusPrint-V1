'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {safePath}=require('../../backend/files/safety'),{loadConfig}=require('../../backend/config');
const {audit}=require('./audit-workflow-local');
const ROOT=path.resolve(__dirname,'../..'),OLD='D:/CampusPrint-recovery/流程精简-20261015183304',SNAPSHOT='44133a1e-2cac-4906-92d8-2de896392ad8';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function check(output){
  const config=loadConfig(),expected={dataDir:'var',dbPath:'var/db/campus-print.sqlite',fileRoot:'var/student-files',paymentRoot:'var/payment-assets',advertisementRoot:'var/advertisement-assets',tempRoot:'var/processing',ledgerRoot:'var/file-ledger',backupRoot:'var/managed-backups'};
  for(const [key,relative]of Object.entries(expected))if(path.resolve(config[key])!==path.join(ROOT,relative))throw Error('Inspect changed formal storage path: '+key);
  if(config.host!=='127.0.0.1'||config.port!==4328||config.advertisementsEnabled||await fs.stat(path.join(ROOT,'.env')).then(()=>true,()=>false))throw Error('Inspect changed formal launch configuration');
  const local=await audit(output,'before');
  const source=JSON.parse(await fs.readFile(path.join(OLD,'source-manifest.json'),'utf8'));
  for(const row of source.rows)if(sha(await fs.readFile(path.join(OLD,'source',row.path)))!==row.sha256)throw Error('Recovery source mismatch: '+row.path);
  if(source.version!=='1.2.0')throw Error('Recovery tool version is not 1.2.0');
  const snapshotRoot=path.join(ROOT,'var/managed-backups',SNAPSHOT),snapshot=JSON.parse(await fs.readFile(path.join(snapshotRoot,'snapshot.json'),'utf8'));
  if(snapshot.snapshotId!==SNAPSHOT||sha(await fs.readFile(path.join(snapshotRoot,'database.sqlite')))!==snapshot.databaseSha256)throw Error('Recovery database checksum mismatch');
  const authority=JSON.parse(await fs.readFile(path.join(OLD,'authority/authority.json'),'utf8'));
  if(authority.manifestSha256!==sha(await fs.readFile(path.join(OLD,'authority/retention-manifest.json')))||authority.ledgerSha256!==sha(await fs.readFile(path.join(OLD,'authority/retention.jsonl')))||authority.ledgerSha256!==local.ledgerSha256)throw Error('Latest authority/ledger changed; coordinate with the saved 1.2.0 tools first');
  const manifest=JSON.parse(await fs.readFile(path.join(OLD,'authority/retention-manifest.json'),'utf8'));
  const now=Date.now(),due=manifest.files.filter(row=>row.authoritativeExpiresAt&&Date.parse(row.authoritativeExpiresAt)<=now&&!row.purgedAt&&!row.revoked);
  if(due.length)throw Error('Retention deadline reached. Run the saved 1.2.0 maintenance tool with explicit formal paths before proceeding.');
  let originalFilesVerified=0;const db=new DatabaseSync(config.dbPath,{readOnly:true});
  try{for(const row of db.prepare("SELECT id,sourceSha256 FROM files WHERE status='ready'").all()){const file=await safePath(config.fileRoot,row.id+'/original.bin');if(sha(await fs.readFile(file))!==row.sourceSha256)throw Error('Original file checksum mismatch');originalFilesVerified++;}}finally{db.close();}
  for(const doc of snapshot.documents){const expiry=Math.min(Date.parse(snapshot.createdAt)+7*86400000,doc.expiresAt?Date.parse(doc.expiresAt):Infinity);if(expiry<=now)throw Error('Snapshot document requires expired-content cleanup before release');const sourceFile=await safePath(path.join(snapshotRoot,'documents'),doc.fileId+'/original.bin');if(sha(await fs.readFile(sourceFile))!==doc.sourceSha256)throw Error('Snapshot document checksum mismatch');}
  for(const [name,rows]of Object.entries(local.assets))for(const row of rows)if(sha(await fs.readFile(path.join(snapshotRoot,name,row.file)))!==row.sha256)throw Error('Recovery merchant image differs from formal image');
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:4328});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
  if(listening)throw Error('Formal port is listening; inspect ownership');
  for(const file of ['var/db/campus-print.runtime.lock','var/desktop-control/instance.json'])if(await fs.stat(path.join(ROOT,file)).then(()=>true,()=>false))throw Error('Formal lock or instance exists');
  if((await fs.readdir(config.tempRoot)).length)throw Error('Formal processing directory is not empty');
  const report={at:new Date().toISOString(),ready:true,targetProductVersion:'1.3.0',pricingVersion:'1.1.0',portStopped:true,originalMigrations:8,sourceFilesVerified:source.rows.length,oldSource:source.source,oldSnapshotId:SNAPSHOT,oldSnapshotDatabaseSha256:snapshot.databaseSha256,oldAuthority:authority,originalFilesVerified,snapshotDocumentsVerified:snapshot.documents.length,paymentImages:local.assets['payment-assets'].length,advertisementImages:local.assets['advertisement-assets'].length,earliestAuthorityExpiry:manifest.files.map(row=>row.authoritativeExpiresAt).filter(Boolean).sort()[0],snapshotDocumentUpperBound:new Date(Date.parse(snapshot.createdAt)+7*86400000).toISOString(),noAdditionalStudentFileCopiesCreated:true};
  await fs.writeFile(path.join(output,'preupgrade-backup-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ready:true,oldSourceFiles:source.rows.length,formalMigrations:8,originalFilesVerified,snapshotDocuments:snapshot.documents.length}));return report;
}
if(require.main===module)check(path.resolve(process.argv[2])).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={check};
