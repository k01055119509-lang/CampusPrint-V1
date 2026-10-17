'use strict';
// Read-only checks for C's management stage. Does not load the application.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
async function audit(output){
  const prior=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/A/A-20261015-backend/real-final.json'),'utf8'));
  const db=new DatabaseSync(path.join(ROOT,'var/db/campus-print.sqlite'),{readOnly:true});
  let report;
  try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const rows=tables.map(table=>{const values=db.prepare(`SELECT * FROM "${table}"`).all().map(row=>JSON.stringify(row)).sort();const sha256=digest(JSON.stringify(values));return {table,count:values.length,sha256,matchesA:sha256===prior.tables[table]?.sha256};});
    report={at:new Date().toISOString(),readOnly:true,integrity:db.prepare('PRAGMA integrity_check').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),migrations:db.prepare('SELECT * FROM schema_migrations').all(),tables:rows,changedTables:rows.filter(row=>!row.matchesA).map(row=>row.table)};
  }finally{db.close();}
  const shared=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/B/B-20261015-student/shared-frozen.json'),'utf8'));
  report.shared=await Promise.all(shared.map(async row=>({path:path.relative(ROOT,row.Path).replaceAll('\\','/'),matches:digest(await fs.readFile(row.Path))===row.Hash.toLowerCase()})));
  const source=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/A/A-20261015-backend/source-final.json'),'utf8'));
  const contractScripts=new Set(['scripts/admin/build-print-contract.js','scripts/admin/check-contract.js','scripts/admin/check-merchant-contract.js','scripts/admin/merchant-contract.js','scripts/admin/workflow-contract.js','scripts/admin/check-workflow-contract.js','scripts/user/check-contract.js']);
  const aFiles=source.rows.filter(row=>/^(backend|contracts|config|scripts\/backend|tests\/(base|files|business|helpers|retention))\//.test(row.path)||contractScripts.has(row.path)||row.path==='.env.example'||row.path==='tests/user/api.test.js'||/^tests\/e2e\/(deployment|production|merchant-backup)\.test\.js$/.test(row.path));
  report.protected=await Promise.all(aFiles.map(async row=>({path:row.path,matches:digest(await fs.readFile(path.join(ROOT,row.path)))===row.sha256})));
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:4328});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
  const exists=relative=>fs.stat(path.join(ROOT,relative)).then(()=>true,()=>false);
  report.service={at:new Date().toISOString(),formalPort:4328,listening,instanceFilePresent:await exists('var/desktop-control/instance.json'),runtimeLockPresent:await exists('var/db/campus-print.runtime.lock'),processingEntries:(await fs.readdir(path.join(ROOT,'var/processing'))).length};
  report.service.stopped=!listening&&!report.service.instanceFilePresent&&!report.service.runtimeLockPresent&&!report.service.processingEntries;
  report.passed=report.service.stopped&&report.migrations.length===8&&!report.changedTables.length&&!report.foreignKeys.length&&report.integrity[0].integrity_check==='ok'&&report.shared.every(row=>row.matches)&&report.protected.every(row=>row.matches);
  await fs.writeFile(path.join(output,'management-stage-audit.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,realMigrations:report.migrations.length,changedTables:report.changedTables,sharedFiles:report.shared.length,sharedMatches:report.shared.every(row=>row.matches),protectedFiles:report.protected.length,protectedMatches:report.protected.every(row=>row.matches)}));
  if(!report.passed)process.exitCode=1;
}
if(require.main===module)audit(path.resolve(process.argv[2])).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={audit};
