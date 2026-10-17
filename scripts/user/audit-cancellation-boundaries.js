'use strict';
// Read-only formal audit: never imports or starts the application.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),net=require('node:net');
const project=path.resolve(__dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
const root=path.join(project,'docs/verification/cancellation-notice-v1.4.0/B/B-20261016-student');
const output=path.resolve(process.env.CP_VERIFICATION_DIR||path.join(root,'audit-final'));
const observeCurrent=process.argv.includes('--observe-current');
const parse=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
async function inventory(base,relative=''){
  const rows=[];
  for(const entry of await fs.readdir(path.join(base,relative),{withFileTypes:true})){
    if(['evidence','.runtime'].includes(entry.name))continue;
    const rel=path.join(relative,entry.name),file=path.join(base,rel);
    if(entry.isDirectory())rows.push(...await inventory(base,rel));
    else if(entry.isFile()){const bytes=await fs.readFile(file);rows.push({path:rel.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}
  }return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const reference=await parse(path.join(project,'docs/verification/cancellation-notice-v1.4.0/A/A-20261016-0944/source-final.json'));
  const protectedPath=rel=>/^(backend|contracts|config|scripts\/backend|tests\/(helpers|business|files|base|retention))\//.test(rel)||rel==='tests/user/api.test.js'||/^scripts\/admin\/.*contract/.test(rel)||rel==='scripts/admin/build-print-contract.js';
  const protectedRows=reference.rows.filter(row=>protectedPath(row.path)),protectedChanged=[];
  for(const row of protectedRows)if(sha(await fs.readFile(path.join(project,row.path)))!==row.sha256)protectedChanged.push(row.path);
  assert.deepEqual(protectedChanged,[]);
  const shared=await parse(path.join(root,'shared-frozen.json')),sharedMismatches=[];
  for(const row of shared)if(sha(await fs.readFile(path.join(project,row.path)))!==row.sha256)sharedMismatches.push(row.path);assert.deepEqual(sharedMismatches,[]);
  const rows=[];for(const dir of ['frontend/user','frontend/shared','tests/user','scripts/user'])for(const row of await inventory(path.join(project,dir)))rows.push({...row,path:dir+'/'+row.path});
  const baseline=await parse(path.join(root,'B-baseline.json')),old=new Map(baseline.map(row=>[row.path,row]));
  const changed=rows.filter(row=>old.has(row.path)&&old.get(row.path).sha256!==row.sha256).map(row=>row.path),added=rows.filter(row=>!old.has(row.path)).map(row=>row.path),deleted=baseline.filter(row=>!rows.some(value=>value.path===row.path)).map(row=>row.path);
  const base=await parse(path.join(project,'docs/verification/cancellation-notice-v1.4.0/A/A-20261016-0944/real-final.json'));
  const database=new DatabaseSync(path.join(project,'var/db/campus-print.sqlite'),{readOnly:true});let real;
  try{
    const tables={};for(const {name} of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const columns=database.prepare('PRAGMA table_info("'+name+'")').all().map(row=>row.name);
      const values=database.prepare('SELECT '+columns.map(column=>'"'+column+'"').join(',')+' FROM "'+name+'"').all().map(row=>JSON.stringify(row)).sort();tables[name]={columns,count:values.length,sha256:sha(JSON.stringify(values))};
    }
    const changedTables=Object.keys(tables).filter(name=>base.tables[name]?.sha256!==tables[name].sha256),migrations=database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    const oldColumnMismatches=[];
    for(const [name,value] of Object.entries(base.tables)){
      const values=database.prepare('SELECT '+value.columns.map(column=>'"'+column+'"').join(',')+' FROM "'+name+'"').all().map(row=>JSON.stringify(row)).sort();
      if(sha(JSON.stringify(values))!==value.sha256)oldColumnMismatches.push(name);
    }
    real={at:new Date().toISOString(),readOnly:true,mode:observeCurrent?'observe-current':'require-A-baseline',tables,changedTables,oldColumnMismatches,newTables:Object.keys(tables).filter(name=>!base.tables[name]),migrations,integrity:database.prepare('PRAGMA integrity_check').all(),foreignKeys:database.prepare('PRAGMA foreign_key_check').all()};
    if(!observeCurrent){assert.deepEqual(changedTables,[]);assert.equal(migrations.length,9);}
    assert.deepEqual(real.foreignKeys,[]);assert(real.integrity.every(row=>row.integrity_check==='ok'));
  }finally{database.close();}
  const assets={};for(const name of ['payment-assets','advertisement-assets','student-files'])assets[name]=await inventory(path.join(project,'var',name));
  // A asset entries use file rather than path; compare the same evidence without exposing content.
  real.assetMismatches=[];
  for(const name of Object.keys(assets)){
    const expected=base.assets[name],current=assets[name];
    const normalize=entries=>entries.map(row=>({file:row.file||row.path,sha256:row.sha256})).sort((a,b)=>a.file.localeCompare(b.file));
    if(JSON.stringify(normalize(expected))!==JSON.stringify(normalize(current)))real.assetMismatches.push(name);
  }
  real.ledgerSha256=sha(await fs.readFile(path.join(project,'var/file-ledger/retention.jsonl')));real.ledgerMatchesA=real.ledgerSha256===base.ledgerSha256;
  if(!observeCurrent){assert(real.ledgerMatchesA);assert.deepEqual(real.assetMismatches,[]);}
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:4328});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
  const processing=await fs.readdir(path.join(project,'var/processing'));if(!observeCurrent){assert.equal(listening,false);assert.deepEqual(processing,[]);}
  const boundaries={at:new Date().toISOString(),protectedCount:protectedRows.length,protectedChanged,sharedMismatches,changed,added,deleted,formalPort4328Listening:listening,formalProcessingEntries:processing,formalMatchesA:real.changedTables.length===0,formalMode:real.mode};
  await fs.writeFile(path.join(output,'B-owned-final.json'),JSON.stringify({at:new Date().toISOString(),rows:rows.filter(row=>changed.includes(row.path)||added.includes(row.path))},null,2));
  await fs.writeFile(path.join(output,'boundaries.json'),JSON.stringify(boundaries,null,2));await fs.writeFile(path.join(output,'real-readonly.json'),JSON.stringify(real,null,2));
  console.log(JSON.stringify({passed:true,protectedCount:protectedRows.length,sharedCount:shared.length,realTables:Object.keys(real.tables).length,realMigrations:real.migrations.length,formalListening:listening,formalMode:real.mode,formalMatchesA:boundaries.formalMatchesA,oldColumnMismatches:real.oldColumnMismatches,assetMismatches:real.assetMismatches,ledgerMatchesA:real.ledgerMatchesA,changed,added,deleted}));
})().catch(error=>{console.error(error);process.exitCode=1;});
