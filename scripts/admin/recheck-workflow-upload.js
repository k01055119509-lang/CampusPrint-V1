'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
async function main(){
  const output=path.resolve(process.argv[2]),count=Number(process.argv[3]||10);await fs.mkdir(output,{recursive:true});const attempts=[];
  for(let n=1;n<=count;n++){
    const iteration=path.join(output,String(n));await fs.mkdir(iteration,{recursive:true});
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--require','./scripts/admin/trace-isolated-storage.js','--test','--test-concurrency=1','--test-name-pattern=默认关闭后经营素材','--test-reporter=tap','tests/business/workflow-simplification.test.js'],{cwd:ROOT,env:{...process.env,CP_VERIFICATION_DIR:iteration,CP_STORAGE_TRACE:path.join(output,'storage-errors.jsonl')},windowsHide:true});let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code,log}));});
    await fs.writeFile(path.join(iteration,'tests.tap'),result.log);attempts.push({iteration:n,exitCode:result.code,EBUSY:result.log.includes('EBUSY')});console.log(JSON.stringify(attempts.at(-1)));
  }
  await fs.writeFile(path.join(output,'recheck-summary.json'),JSON.stringify({at:new Date().toISOString(),observedOnly:true,backendFilesModified:false,attempts,failures:attempts.filter(row=>row.exitCode!==0).length,rootCauseResolved:false},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
