'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {isolated,PROJECT}=require('../../tests/helpers/runtime');
async function main(){
  const runtime=await isolated();let report;
  try{
    const response=await fetch(runtime.url+'/api/print/config'),payload=await response.json();assert.equal(response.status,200);assert.equal(payload.data.payment.configured,false);assert.equal(payload.data.payment.qrUrl,null);
    const counts={users:runtime.db.get('SELECT COUNT(*) AS n FROM users').n,files:runtime.db.get('SELECT COUNT(*) AS n FROM files').n,orders:runtime.db.get('SELECT COUNT(*) AS n FROM print_orders').n,receipts:runtime.db.get('SELECT COUNT(*) AS n FROM payment_receipts').n,refunds:runtime.db.get('SELECT COUNT(*) AS n FROM order_refunds').n};
    for(const count of Object.values(counts))assert.equal(count,0,'Default distribution must not contain software-test data');
    report={kind:'B-default-empty-start-stop',softwareTestDataInDefaultStorage:false,initialPayment:payload.data.payment,counts,migrations:runtime.db.all('SELECT version FROM schema_migrations').map(row=>row.version),capabilities:runtime.context.capabilities,start:true};
  }finally{await runtime.destroy();}
  const output=process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/workflow-simplification-v1.3.0/C/local-admin');await fs.mkdir(output,{recursive:true});report.stop=true;await fs.writeFile(path.join(output,'isolated-empty-runtime.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
