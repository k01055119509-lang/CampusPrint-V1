'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {safePath}=require('../../backend/files/safety');
const {audit}=require('./audit-local');
const ROOT=path.resolve(__dirname,'../..'),OLD='D:/CampusPrint-recovery/A-20261015-090848';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  const output=path.resolve(process.argv[2]),local=await audit(output,'preupgrade');
  if(local.aFinalComparison.some(r=>!r.matches)||local.migrations.length!==7||local.newTables.length)throw new Error('Real baseline changed; use old-version backup and re-evaluate before upgrade.');
  const source=JSON.parse(await fs.readFile(path.join(OLD,'source-manifest.json'),'utf8'));
  for(const row of source)if(sha(await fs.readFile(path.join(OLD,'source',row.path)))!==row.sha256)throw new Error('Old recovery source mismatch: '+row.path);
  const snapshotRoot=path.join(ROOT,'var/managed-backups/d8d0d657-68e6-4a86-b25d-4735ffa22644'),snapshot=JSON.parse(await fs.readFile(path.join(snapshotRoot,'snapshot.json'),'utf8'));
  if(sha(await fs.readFile(path.join(snapshotRoot,'database.sqlite')))!==snapshot.databaseSha256)throw new Error('Old database backup checksum mismatch');
  const authority=JSON.parse(await fs.readFile(path.join(OLD,'authority/authority.json'),'utf8'));
  if(authority.manifestSha256!==sha(await fs.readFile(path.join(OLD,'authority/retention-manifest.json')))||authority.ledgerSha256!==sha(await fs.readFile(path.join(OLD,'authority/retention.jsonl'))))throw new Error('Authority proof mismatch');
  if(authority.ledgerSha256!==sha(await fs.readFile(path.join(ROOT,'var/file-ledger/retention.jsonl'))))throw new Error('Live retention ledger changed; export latest authority with the old tool before upgrade');
  const db=new DatabaseSync(path.join(ROOT,'var/db/campus-print.sqlite'),{readOnly:true});let originalFilesVerified=0;
  try{for(const row of db.prepare("SELECT id,sourceSha256 FROM files WHERE status='ready'").all()){const file=await safePath(path.join(ROOT,'var/student-files'),row.id+'/original.bin');if(sha(await fs.readFile(file))!==row.sourceSha256)throw new Error('Original student file checksum mismatch');originalFilesVerified++;}}finally{db.close();}
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:4328});socket.setTimeout(1500);socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));socket.on('timeout',()=>{socket.destroy();resolve(true);});});
  if(listening)throw new Error('Formal port is already listening; inspect ownership before upgrade');
  for(const relative of ['var/db/campus-print.runtime.lock','var/desktop-control/instance.json'])if(await fs.stat(path.join(ROOT,relative)).then(()=>true,()=>false))throw new Error('Formal runtime or desktop lock exists');
  if((await fs.readdir(path.join(ROOT,'var/processing'))).length)throw new Error('Formal processing directory is not empty');
  const materials={};for(const relative of ['assets-inbox/payment-qr','assets-inbox/advertisements'])materials[relative]=(await fs.readdir(path.join(ROOT,relative))).filter(name=>/\.(png|jpe?g)$/i.test(name));
  const report={at:new Date().toISOString(),ready:true,portStopped:true,locksAbsent:true,processingEmpty:true,sourceFilesVerified:source.length,oldSnapshotId:snapshot.snapshotId,oldSnapshotDatabaseSha256:snapshot.databaseSha256,oldAuthority:authority,liveLedgerMatchesAuthority:true,originalFilesVerified,realBusinessMatchesAFinal:true,originalMigrations:7,materials,realImagesImported:false,merchantAccountInitialized:false,pricingVersion:'1.1.0',targetProductVersion:'1.2.0',noAdditionalStudentFileCopiesCreated:true};
  await fs.writeFile(path.join(output,'preupgrade-backup-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ready:true,oldSourceFiles:source.length,oldSnapshot:snapshot.snapshotId,materials}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
