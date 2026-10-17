'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,tree}=require('./audit-cancellation-local'),{check}=require('../deploy/check-cancellation-freeze');
async function main(){
  const output=path.resolve(process.argv[2]),log=await fs.readFile(path.join(output,'management-visual-fix.log'),'utf8'),code=Number((await fs.readFile(path.join(output,'management-visual-fix-exit.txt'),'utf8')).trim()),counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(name=>[name,Number(new RegExp('^# '+name+' (\\d+)','m').exec(log)?.[1])])) ;assert.equal(code,0);assert.equal(counts.tests,40);assert.equal(counts.pass,40);assert.equal(counts.fail+counts.skipped+counts.cancelled,0);
  const freeze=await check(path.join(output,'management-stage-freeze'));
  const files=(await tree(path.join(ROOT,'frontend/admin'))).map(row=>({...row,path:'frontend/admin/'+row.path}));
  const report={at:new Date().toISOString(),productVersion:'1.4.0',passed:true,phase:'management-only',jointAcceptance:false,exitCode:code,counts,files,AFiles:freeze.A.length,sharedFiles:freeze.shared.length,realMoney:false,realPrinting:false,realPhone:false};await fs.writeFile(path.join(output,'management-stage.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,phase:report.phase,...counts,productFiles:files.length}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
