'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),net=require('node:net');
const project=path.resolve(__dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const output=path.resolve(process.env.CP_VERIFICATION_DIR||path.join(project,'tmp/B-boundaries'));
const parse=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
async function inventory(root,relative=''){
  const rows=[];for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const rel=path.join(relative,entry.name),file=path.join(root,rel);if(entry.isDirectory())rows.push(...await inventory(root,rel));else if(entry.isFile()){const bytes=await fs.readFile(file);rows.push({path:rel.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}
  }return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const reference=await parse(path.join(project,'docs/verification/workflow-simplification-v1.3.0/A/A-20261015-backend/source-final.json'));
  const paths=new Set(reference.rows.map(row=>row.path));
  for(const root of ['frontend/user','frontend/shared','tests/user','scripts/user'])for(const row of await inventory(path.join(project,root)))if(!row.path.startsWith('evidence/')&&!row.path.startsWith('.runtime/'))paths.add(root+'/'+row.path);
  const rows=[];for(const rel of [...paths].sort()){const bytes=await fs.readFile(path.join(project,rel));rows.push({path:rel,bytes:bytes.length,sha256:sha(bytes)});}
  const current=new Map(rows.map(row=>[row.path,row])),old=new Map(reference.rows.map(row=>[row.path,row]));
  const changed=rows.filter(row=>old.has(row.path)&&old.get(row.path).sha256!==row.sha256).map(row=>row.path),added=rows.filter(row=>!old.has(row.path)).map(row=>row.path);
  const protectedPath=rel=>/^(backend|contracts|config|scripts\/backend|tests\/(helpers|business|files|base|retention))\//.test(rel)||rel==='tests/user/api.test.js'||rel==='scripts/user/check-contract.js'||/scripts\/admin\/.*contract/.test(rel)||rel==='.env.example';
  const protectedChanged=changed.filter(protectedPath);assert.deepEqual(protectedChanged,[]);
  const shared=await parse(path.join(project,'docs/verification/workflow-simplification-v1.3.0/B/B-20261015-student/shared-frozen.json'));
  const sharedMismatches=[];for(const entry of shared)if(sha(await fs.readFile(entry.Path))!==entry.Hash.toLowerCase())sharedMismatches.push(path.relative(project,entry.Path));assert.deepEqual(sharedMismatches,[]);
  const database=new DatabaseSync(path.join(project,'var/db/campus-print.sqlite'),{readOnly:true});let real;
  try{
    const base=await parse(path.join(project,'docs/verification/workflow-simplification-v1.3.0/A/A-20261015-backend/real-stopped.json')),tables={};
    for(const {name} of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const values=database.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort();tables[name]={count:values.length,sha256:sha(JSON.stringify(values))};
    }
    const changedTables=Object.keys(tables).filter(name=>base.tables[name]?.sha256!==tables[name].sha256);
    const migrations=database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    const assets={payment:await inventory(path.join(project,'var/payment-assets')),advertisements:await inventory(path.join(project,'var/advertisement-assets'))};
    real={at:new Date().toISOString(),readOnly:true,tables,changedTables,migrations,assetsUnchanged:JSON.stringify(assets)===JSON.stringify(base.assets),integrity:database.prepare('PRAGMA integrity_check').all(),foreignKeys:database.prepare('PRAGMA foreign_key_check').all()};
    assert.deepEqual(changedTables,[]);assert.equal(migrations.length,8);assert(real.assetsUnchanged);assert.deepEqual(real.foreignKeys,[]);
  }finally{database.close();}
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:4328});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
  const processing=await fs.readdir(path.join(project,'var/processing'));assert.equal(listening,false);assert.deepEqual(processing,[]);
  const boundaries={at:new Date().toISOString(),reference:'A/source-final.json',protectedFileCount:reference.rows.filter(row=>protectedPath(row.path)).length,protectedChanged,sharedMismatches,changed,added,formalPort4328Listening:listening,formalProcessingEntries:processing};
  await fs.writeFile(path.join(output,'source-final.json'),JSON.stringify({at:new Date().toISOString(),rows},null,2));await fs.writeFile(path.join(output,'boundaries.json'),JSON.stringify(boundaries,null,2));await fs.writeFile(path.join(output,'real-readonly.json'),JSON.stringify(real,null,2));
  console.log(JSON.stringify({passed:true,protectedFiles:boundaries.protectedFileCount,protectedChanged,sharedMismatches,realTables:Object.keys(real.tables).length,realChangedTables:real.changedTables,realMigrations:real.migrations.length,formalPort4328Listening:listening}));
})().catch(error=>{console.error(error);process.exitCode=1;});
