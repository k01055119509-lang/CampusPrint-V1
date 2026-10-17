'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const yaml=require('js-yaml');
const parser=require('@apidevtools/swagger-parser');
const project=path.resolve(__dirname,'../..');
(async()=>{
  const results=[];
  for(const filename of ['base.yaml','print.yaml','openapi.yaml']){
    const target=path.join(project,'contracts',filename),source=yaml.load(fs.readFileSync(target,'utf8'));
    await parser.validate(target);results.push({file:filename,version:source.info.version,validated:true});
  }
  const contract=yaml.load(fs.readFileSync(path.join(project,'contracts/print.yaml'),'utf8'));
  const text=fs.readFileSync(path.join(project,'frontend/user/text.js'),'utf8');
  const statuses=contract.components.schemas.OwnerOrder.properties.displayStatus.enum;
  for(const status of statuses)assert(text.includes('status_'+status+':['),'Student translation missing: '+status);
  const report={at:new Date().toISOString(),results,studentStatusCount:statuses.length,statuses,contractsModified:false};
  const output=path.join(process.env.CP_VERIFICATION_DIR?path.resolve(process.env.CP_VERIFICATION_DIR):path.join(project,'tmp/workflow-contract'),'student-contract-check.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
