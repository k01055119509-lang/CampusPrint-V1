'use strict';
// Read-only evidence collection. Never opens an application or runs migrations.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'../..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function audit(output,phase='before'){
  const a=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/merchant-service-v1.2.0/A/A-20261015-090848/source-final.json'),'utf8'));
  const protectedRows=a.rows.filter(r=>/^(backend|contracts|scripts\/(backend|admin)|tests\/(base|files|business|helpers))\//.test(r.path));
  const mismatches=[];
  for(const r of protectedRows)if(digest(await fs.readFile(path.join(ROOT,r.path)))!==r.sha256)mismatches.push(r.path);
  if(mismatches.length)throw new Error('A protected source changed: '+mismatches.join(', '));
  await fs.mkdir(output,{recursive:true});
  if(phase==='before'){
    const rows=[];for(const r of a.rows)rows.push({...r,sha256:digest(await fs.readFile(path.join(ROOT,r.path)))});
    await fs.writeFile(path.join(output,'source-before.json'),JSON.stringify({at:new Date().toISOString(),rows,protectedRows},null,2),{flag:'wx'});
  }
  const db=new DatabaseSync(path.join(ROOT,'var/db/campus-print.sqlite'),{readOnly:true});
  const backup=new DatabaseSync(path.join(ROOT,'var/managed-backups/d8d0d657-68e6-4a86-b25d-4735ffa22644/database.sqlite'),{readOnly:true});
  const aFinal=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/merchant-service-v1.2.0/A/A-20261015-090848/real-final.json'),'utf8'));
  let report;
  try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const tableHash=(d,t,columns='*')=>{const rows=d.prepare(`SELECT ${columns} FROM "${t}"`).all().map(r=>JSON.stringify(r)).sort();return {count:rows.length,sha256:digest(JSON.stringify(rows))};};
    const baseline=backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const entries=baseline.map(table=>{const columns=backup.prepare(`PRAGMA table_info("${table}")`).all().map(c=>'"'+c.name+'"').join(',');return {table,current:tableHash(db,table,columns),backup:tableHash(backup,table,columns)};});
    const changed=entries.filter(r=>r.current.sha256!==r.backup.sha256);
    const aFinalComparison=baseline.map(table=>({table,matches:digest(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()))===aFinal.tables[table]?.sha256}));
    report={at:new Date().toISOString(),protectedFiles:protectedRows.length,protectedSourceMatches:true,tables:entries,newTables:tables.filter(t=>!baseline.includes(t)),changedTables:changed.map(r=>r.table),aFinalComparison,integrity:db.prepare('PRAGMA integrity_check').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),migrations:db.prepare('SELECT * FROM schema_migrations').all(),dbSha256:digest(await fs.readFile(path.join(ROOT,'var/db/campus-print.sqlite')))};
  }finally{db.close();backup.close();}
  await fs.writeFile(path.join(output,'local-'+phase+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({phase,protectedFiles:report.protectedFiles,changedTables:report.changedTables,aFinalMismatches:report.aFinalComparison.filter(r=>!r.matches).map(r=>r.table),newTables:report.newTables,migrations:report.migrations.length,integrity:report.integrity,foreignKeys:report.foreignKeys.length}));
  if(phase==='before'&&report.changedTables.length)throw new Error('Real data changed since A backup; create an old-version consistent backup before upgrade.');
  return report;
}
if(require.main===module)audit(path.resolve(process.argv[2]),process.argv[3]||'before').catch(error=>{console.error(error);process.exitCode=1;});
module.exports={audit};
