'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),A='docs/verification/cancellation-notice-v1.4.0/A/A-20261016-0944',B='docs/verification/cancellation-notice-v1.4.0/B/B-20261016-student';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ownedA=name=>/^(backend\/|config\/|contracts\/|scripts\/backend\/|tests\/(base|files|business|retention|helpers)\/)/.test(name)||['tests/user/api.test.js','tests/e2e/production.test.js','tests/e2e/deployment.test.js','tests/e2e/merchant-backup.test.js'].includes(name)||/^scripts\/admin\/(build-print-contract|check-contract|merchant-contract|check-merchant-contract|workflow-contract|check-workflow-contract|cancellation-contract|check-cancellation-contract)\.js$/.test(name);
async function verify(rows){return Promise.all(rows.map(async row=>({path:row.path,sha256:row.sha256,matches:sha(await fs.readFile(path.join(ROOT,row.path)))===row.sha256})));}
async function check(output,{joint=false}={}){
  await fs.mkdir(output,{recursive:true});
  const a=JSON.parse(await fs.readFile(path.join(ROOT,A,'source-final.json'),'utf8')),aChecks=await verify(a.rows.filter(row=>ownedA(row.path))),shared=await verify(JSON.parse(await fs.readFile(path.join(ROOT,B,'shared-frozen.json'),'utf8')));
  assert(aChecks.every(row=>row.matches),'A frozen source changed');assert(shared.every(row=>row.matches),'B shared freeze changed');
  let final=null;
  if(joint){
    assert(await fs.stat(path.join(ROOT,'docs/handoffs/公告与取消补偿改版/B-完成交接.md')),'B complete handoff is required');
    const b=JSON.parse(await fs.readFile(path.join(ROOT,B,'audit-frozen/B-owned-final.json'),'utf8'));
    const checks=await verify(Array.isArray(b)?b:b.rows);assert(checks.every(row=>row.matches),'B final frozen files changed');final={files:checks};
  }
  const report={at:new Date().toISOString(),frozen:true,joint,A:aChecks,shared,B:final};await fs.writeFile(path.join(output,'AB-freeze.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({frozen:true,joint,A:aChecks.length,shared:shared.length,B:final?.files.length||0}));return report;
}
if(require.main===module)check(path.resolve(process.argv[2]),{joint:process.argv.includes('--joint')}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={check,ownedA,verify};
