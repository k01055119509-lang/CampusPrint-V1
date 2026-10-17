'use strict';
// Formal storage inspection is read-only and never imports application startup/migrations.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const A='docs/verification/cancellation-notice-v1.4.0/A/A-20261016-0944';
async function tree(root,prefix=''){
  const rows=[];
  for(const entry of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    assert(!entry.isSymbolicLink(),'Storage links are not permitted');
    const name=prefix+entry.name,full=path.join(root,entry.name);
    if(entry.isDirectory())rows.push(...await tree(full,name+'/'));
    else if(entry.isFile()){const bytes=await fs.readFile(full);rows.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  }
  return rows;
}
async function audit(output,phase='takeover'){
  await fs.mkdir(output,{recursive:true});
  const a=JSON.parse(await fs.readFile(path.join(ROOT,A,'real-final.json'),'utf8'));
  const db=new DatabaseSync(path.join(ROOT,'var/db/campus-print.sqlite'),{readOnly:true});let report;
  try{
    db.exec('BEGIN');const tables={};
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const columns=db.prepare(`PRAGMA table_info("${name}")`).all().map(r=>r.name);
      const rows=db.prepare(`SELECT * FROM "${name}"`).all().map(r=>JSON.stringify(r)).sort();
      const oldColumns=a.tables[name]?.columns;
      const prior=oldColumns?db.prepare(`SELECT ${oldColumns.map(c=>'"'+c+'"').join(',')} FROM "${name}"`).all().map(r=>JSON.stringify(r)).sort():null;
      tables[name]={columns,count:rows.length,sha256:sha(JSON.stringify(rows)),oldSha256:prior?sha(JSON.stringify(prior)):null};
    }
    report={at:new Date().toISOString(),phase,readOnly:true,tables,migrations:db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(),integrity:db.prepare('PRAGMA integrity_check').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),orders:db.prepare('SELECT totalAmountFen,lifecycle,paymentStatus,completedAt,filesExpireAt FROM print_orders ORDER BY createdAt,id').all(),identities:db.prepare('SELECT role,identityKind,count(*) count FROM users GROUP BY role,identityKind').all()};
    report.changedSinceA=Object.entries(tables).filter(([name,row])=>a.tables[name]&&row.oldSha256!==a.tables[name].sha256).map(([name])=>name);
    db.exec('COMMIT');
  }finally{db.close();}
  report.assets={};for(const name of ['student-files','payment-assets','advertisement-assets'])report.assets[name]=await tree(path.join(ROOT,'var',name));
  report.assetsMatchA=Object.keys(report.assets).every(name=>JSON.stringify(report.assets[name])===JSON.stringify(a.assets[name]));
  report.ledgerSha256=sha(await fs.readFile(path.join(ROOT,'var/file-ledger/retention.jsonl')));
  report.processing=(await fs.readdir(path.join(ROOT,'var/processing'))).length;
  await fs.writeFile(path.join(output,'local-'+phase+'.json'),JSON.stringify(report,null,2));
  assert(report.integrity.every(row=>row.integrity_check==='ok'));assert.equal(report.foreignKeys.length,0);
  console.log(JSON.stringify({phase,at:report.at,migrations:report.migrations.length,orders:tablesCount(report,'print_orders'),receipts:tablesCount(report,'payment_receipts'),changedSinceA:report.changedSinceA,assetsMatchA:report.assetsMatchA,processing:report.processing}));
  return report;
}
function tablesCount(report,name){return report.tables[name]?.count;}
if(require.main===module)audit(path.resolve(process.argv[2]),process.argv[3]||'takeover').catch(e=>{console.error(e);process.exitCode=1;});
module.exports={audit,tree,sha,ROOT,A};
