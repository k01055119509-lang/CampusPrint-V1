'use strict';
const fs=require('node:fs/promises');
const {createWriteStream}=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {ROOT}=require('../../backend/config');
const output=process.env.CP_VERIFICATION_DIR ? path.resolve(process.env.CP_VERIFICATION_DIR) : path.join(ROOT,'docs/verification/cancellation-notice-v1.4.0/C', 'local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const pkg=require('../../package.json');
const phases=[
  {name:'api',args:['--test','--test-reporter=tap','--test-concurrency=1','tests/base/*.test.js','tests/files/*.test.js','tests/business/*.test.js','tests/user/api.test.js','tests/retention/*.test.js','tests/e2e/deployment.test.js','tests/e2e/production.test.js','tests/e2e/merchant-backup.test.js']},
  {name:'ui',args:['--test-reporter=tap',...pkg.scripts['test:ui'].slice('node '.length).split(' ')]},
  {name:'contract',args:['scripts/admin/check-contract.js']}
];
async function main(){
  await fs.mkdir(output,{recursive:true});const results=[];
  for(const phase of phases){await fs.mkdir(path.join(output,phase.name),{recursive:true});console.log('CampusPrint final verification: '+phase.name);const result=await new Promise((resolve,reject)=>{
    const live=createWriteStream(path.join(output,phase.name+'-live.txt'));
    const child=spawn(process.execPath,phase.args,{cwd:ROOT,env:{...process.env,CP_VERIFICATION_DIR:path.join(output,phase.name)},windowsHide:true});let log='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;live.write(chunk);});child.on('error',error=>{live.end();reject(error);});child.on('close',code=>live.end(()=>resolve({code,log})));
  });await fs.writeFile(path.join(output,phase.name+'-tests.txt'),result.log);
    const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(name=>[name,Number(new RegExp('(?:# |ℹ )'+name+' (\\d+)').exec(result.log)?.[1]||0)]));
    if(phase.name!=='contract'&&counts.tests<1)throw new Error('No test count found for '+phase.name);
    results.push({phase:phase.name,exitCode:result.code,...counts});console.log(JSON.stringify(results.at(-1)));
    if(result.code!==0){console.error(result.log.slice(-7000));break;}
  }
  const report={kind:'C-v1.4.0-integrated-verification',at:new Date().toISOString(),node:process.version,productVersion:pkg.version,results,passed:results.length===phases.length&&results.every(row=>row.exitCode===0),
    realMobileDevice:false,realPayment:false,realPrinting:false,publicDeployment:false};
  await fs.writeFile(path.join(output,'final-tests.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
