'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const project=path.resolve(__dirname,'../..'),target=path.join(project,'var/db/campus-print.sqlite');
const before=createHash('sha256').update(fs.readFileSync(target)).digest('hex');
if(fs.existsSync(target+'-wal')&&fs.statSync(target+'-wal').size)throw new Error('Use this distribution check only with a stopped, checkpointed database.');
const testRoot=path.join(project,'tests/user'),temporary=fs.mkdtempSync(path.join(testRoot,'.distribution-'));
if(path.relative(testRoot,temporary).startsWith('..')||!path.isAbsolute(temporary))throw new Error('Unexpected temporary inspection path');
const copy=path.join(temporary,'distribution.sqlite');fs.copyFileSync(target,copy);
const db=new DatabaseSync(copy,{readOnly:true});
let report;
try{const counts={};for(const table of ['users','files','print_orders','payment_receipts','order_refunds','order_tickets'])counts[table]=db.prepare('SELECT COUNT(*) AS total FROM '+table).get().total;const settings=db.prepare('SELECT paymentAssetJson FROM print_settings WHERE id=1').get();report={at:new Date().toISOString(),mode:'read-only inspection of private copy; no default runtime started',counts,paymentConfigured:!!settings.paymentAssetJson};}
finally{db.close();fs.rmSync(temporary,{recursive:true,force:true});}
report.hashUnchanged=before===createHash('sha256').update(fs.readFileSync(target)).digest('hex');
fs.mkdirSync(path.join(project,'tests/user/evidence'),{recursive:true});fs.writeFileSync(path.join(project,'tests/user/evidence/distribution-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
process.exitCode=report.hashUnchanged&&!report.paymentConfigured&&Object.values(report.counts).every(value=>value===0)?0:1;
