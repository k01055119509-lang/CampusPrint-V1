'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  const output=path.resolve(process.argv[2]),bRoot=path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/B/B-20261015-student');await fs.mkdir(output,{recursive:true});
  const b=JSON.parse(await fs.readFile(path.join(bRoot,'B-owned-accepted.json'),'utf8')),checks=await Promise.all(b.rows.map(async row=>({path:row.path,matches:sha(await fs.readFile(path.join(ROOT,row.path)))===row.sha256})));
  const bReport=JSON.parse(await fs.readFile(path.join(bRoot,'final-tests.json'),'utf8')),bTap=await fs.readFile(path.join(bRoot,'student-verified/tests.tap'),'utf8'),bCode=Number((await fs.readFile(path.join(bRoot,'student-verified/exit-code.txt'),'utf8')).trim());
  if(checks.some(row=>!row.matches)||!bReport.complete||bCode!==0||!/# tests 52\b/.test(bTap)||!/# pass 52\b/.test(bTap)||!/# fail 0\b/.test(bTap))throw Error('B frozen source/evidence did not match');
  const c=JSON.parse(await fs.readFile(path.join(ROOT,'docs/verification/workflow-simplification-v1.3.0/C/C-20261015-admin/management-source-final.json'),'utf8'));
  const management=await Promise.all(c.rows.filter(row=>row.path.startsWith('frontend/admin/')).map(async row=>({path:row.path,matches:sha(await fs.readFile(path.join(ROOT,row.path)))===row.sha256})));
  if(management.some(row=>!row.matches))throw Error('Management product changed after passing stage');
  await fs.writeFile(path.join(output,'AB-handoff-and-freeze.json'),JSON.stringify({at:new Date().toISOString(),B:{files:checks,tests:52,exitCode:0,sharedFrozen:true,blockingBackendRepairs:false,repairs:'B-owned UI and test corrections documented in B handoff; no open backend blocker'},management:{files:management,stageNodeCount:38},frozen:true},null,2));
  console.log(JSON.stringify({frozen:true,BFiles:checks.length,BPassed:52,managementFiles:management.length}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
