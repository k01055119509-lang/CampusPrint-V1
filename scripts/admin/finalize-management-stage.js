'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function walk(relative){
  const rows=[];for(const entry of await fs.readdir(path.join(ROOT,relative),{withFileTypes:true})){
    const name=path.posix.join(relative,entry.name);if(entry.isDirectory())rows.push(...await walk(name));else if(entry.isFile()){const bytes=await fs.readFile(path.join(ROOT,name));rows.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  }return rows;
}
async function main(){
  const output=path.resolve(process.argv[2]);
  const base=JSON.parse(await fs.readFile(path.join(output,'source-before.json'),'utf8')),before=new Map(base.files.map(row=>[row.path,row]));
  const all=(await Promise.all(['frontend/admin','tests/admin','scripts/admin','scripts/deploy','scripts/desktop'].map(walk))).flat();
  const contractScripts=new Set(['scripts/admin/build-print-contract.js','scripts/admin/check-contract.js','scripts/admin/check-merchant-contract.js','scripts/admin/merchant-contract.js','scripts/admin/workflow-contract.js','scripts/admin/check-workflow-contract.js']);
  const rows=all.filter(row=>!contractScripts.has(row.path));
  const tap=await fs.readFile(path.join(output,'management-final/tests.tap'),'utf8'),exitCode=Number((await fs.readFile(path.join(output,'management-final/exit-code.txt'),'utf8')).trim());
  const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(name=>[name,Number(new RegExp('# '+name+' (\\d+)').exec(tap)?.[1])]));
  if(exitCode!==0||!counts.tests||counts.tests!==counts.pass||counts.fail||counts.skipped||counts.cancelled)throw new Error('Management tests have not passed');
  const audit=JSON.parse(await fs.readFile(path.join(output,'management-stage-audit.json'),'utf8'));if(!audit.passed)throw new Error('Source/real-data audit did not pass');
  const changes=rows.filter(row=>before.get(row.path)?.sha256!==row.sha256).map(row=>({...row,change:before.has(row.path)?'modified':'added'}));
  const packageBytes=await fs.readFile(path.join(ROOT,'package.json'));changes.push({path:'package.json',bytes:packageBytes.length,sha256:sha(packageBytes),change:'modified',detail:'Registers new browser suites; dependencies unchanged.'});
  await fs.writeFile(path.join(output,'management-source-final.json'),JSON.stringify({at:new Date().toISOString(),scope:'C-management-and-owned-verification-only',rows},null,2));
  await fs.writeFile(path.join(output,'management-changes.json'),JSON.stringify(changes,null,2));
  const result={at:new Date().toISOString(),kind:'C-management-stage-only',passed:true,productVersion:'1.3.0',pricingVersion:'1.1.0',exitCode,...counts,nodeCountIncludesContainers:true,log:'management-final/tests.tap',protectedA:audit.protected.length,protectedAMatched:true,sharedFrozenFiles:audit.shared.length,sharedMatched:true,realTablesUnchanged:audit.tables.length,formalMigrations:audit.migrations.length,formalServiceStopped:audit.service.stopped,jointAcceptance:false,releaseCreated:false,formalMigrationExecuted:false,localUpgradeExecuted:false,changes:changes.length};
  await fs.writeFile(path.join(output,'management-stage-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
