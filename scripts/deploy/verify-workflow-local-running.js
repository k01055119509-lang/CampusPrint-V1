'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {audit}=require('./audit-workflow-local');
const ROOT=path.resolve(__dirname,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  const output=path.resolve(process.argv[2]),local=await audit(output,'final-running'),before=JSON.parse(await fs.readFile(path.join(output,'local-before.json'),'utf8'));
  const allowed=new Set(['schema_migrations','file_cleanup_runs','general_feedback','general_feedback_updates']);if(local.changedTables.some(name=>!allowed.has(name))||local.migrations.length!==9)throw Error('Original formal columns changed');
  if(JSON.stringify(before.assets)!==JSON.stringify(local.assets)||before.ledgerSha256!==local.ledgerSha256)throw Error('Original assets/ledger changed');
  const instance=JSON.parse(await fs.readFile(path.join(ROOT,'var/desktop-control/instance.json'),'utf8'));process.kill(instance.pid,0);
  const base=instance.url,data=(await(await fetch(base+'/api/public/config')).json()).data;
  if(data.product.version!=='1.3.0'||data.capabilities.advertisements!==false)throw Error('Formal runtime configuration changed');
  const unauthorized=(await fetch(base+'/api/admin/reason-catalog',{headers:{'X-CP-Surface':'admin'}})).status;if(unauthorized!==401)throw Error('Administrator-only catalog is not protected');
  const proof={at:new Date().toISOString(),passed:true,productVersion:'1.3.0',migrations:9,servicePid:instance.pid,serviceStartedAt:instance.startedAt,serviceAddress:base,originalBusinessColumnsUnchanged:true,originalAccountsIncludingCredentialsUnchanged:local.tables.find(row=>row.table==='users').oldColumns.sha256===before.tables.find(row=>row.table==='users').sha256,originalImagesUnchanged:true,retentionLedgerUnchanged:true,anonymousAdminCatalogStatus:unauthorized,merchantExists:local.merchantExists,noTestGuestOrderReceiptOrTicketCreated:true,realPasswordLoginPerformed:false};
  await fs.writeFile(path.join(output,'local-running-final.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
