'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {PROJECT}=require('../../tests/helpers/runtime');
const root=path.join(PROJECT,'docs/verification/B');
const readJson=async name=>JSON.parse((await fs.readFile(path.join(root,name),'utf8')).replace(/^\uFEFF/,''));
async function counts(name){const text=await fs.readFile(path.join(root,name),'utf8'),count=key=>{const match=text.match(new RegExp('(?:ℹ|#) '+key+' (\\d+)'));assert(match,name+': '+key);return Number(match[1]);};const result={tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};assert.equal(result.tests,result.passed);assert.equal(result.failed,0);assert.equal(result.skipped,0);return result;}
async function filesAt(relative){const target=path.join(PROJECT,relative),stat=await fs.stat(target);if(stat.isFile())return [relative];const result=[];for(const entry of await fs.readdir(target,{withFileTypes:true}))if(!entry.isSymbolicLink())result.push(...await filesAt(path.join(relative,entry.name)));return result;}
async function main(){
  const [api,ui,contract,browser,initial,boundaries]=await Promise.all([counts('all-api-tests.txt'),counts('admin-ui-tests.txt'),readJson('contract-report.json'),readJson('browser/report.json'),readJson('default-runtime.json'),readJson('boundaries-after.json')]);
  assert.equal(api.tests,79);assert.equal(ui.tests,13);assert.equal(contract.matchedOperations,48);assert.equal(browser.checks.length,12);assert.equal(browser.pageErrors.length,0);assert(boundaries.every(row=>row.unchanged));assert.equal(initial.initialPayment.configured,false);
  const manifest=[];
  for(const relative of ['backend/orders','backend/migrations/100-orders.sql','contracts/print.yaml','contracts/openapi.yaml','frontend/admin','tests/business','tests/admin','scripts/admin','tests/base/auth.test.js','docs/handoffs/B-接口就绪.md','docs/handoffs/B-订单与后台交接.md'])for(const file of await filesAt(relative)){const data=await fs.readFile(path.join(PROJECT,file));manifest.push({path:file.replaceAll('\\','/'),sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});}
  await fs.writeFile(path.join(root,'source-manifest.json'),JSON.stringify(manifest,null,2));
  const report={kind:'B-order-and-admin-completion',generatedAt:new Date().toISOString(),project:PROJECT,contractVersion:'1.0.0-b.1',foundationVersion:'1.0.0-a.1',businessInterfacesReady:true,adminPagesComplete:['dashboard','orders','users_and_support','settings_and_maintenance'],
    apiTests:{...api,foundationTests:24,businessTests:55,command:'node --test --test-concurrency=1 tests/base/*.test.js tests/files/*.test.js tests/business/*.test.js',evidence:'all-api-tests.txt'},
    adminTests:{...ui,command:'node scripts/admin/verify-ui.js',viewports:browser.viewports,browser:browser.browser,pageErrors:browser.pageErrors,evidence:'admin-ui-tests.txt',screenshots:browser.screenshots,checks:browser.checks,visualInspection:['order-390-light.png','expired-order-1440-dark-en.png','settings-empty-390-light.png','order99-360-dark-en.png']},
    openapi:{validated:contract.validated,matchedOperations:contract.matchedOperations,foundationOperations:contract.foundationOperations,businessOperations:contract.businessOperations,evidence:'contract-report.json'},
    defaultDistribution:initial,boundaries:{trackedFiles:boundaries.length,allUnchanged:true,evidence:'boundaries-after.json',minimalIntegrationTestChange:'tests/base/auth.test.js: update A-only orders=false/config=404 assertions'},
    retentionEvidence:['workflow-evidence.json','restart-evidence.json','retention-tests.txt'],realWorldVerification:{realPayment:false,realRefund:false,realPaperPrinting:false,realDelivery:false,realMobileDevice:false,publicDeployment:false},
    handoffs:['docs/handoffs/B-接口就绪.md','docs/handoffs/B-订单与后台交接.md'],sourceManifest:'source-manifest.json'};
  await fs.writeFile(path.join(root,'verification-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({api,ui,matchedOperations:contract.matchedOperations,boundaryFiles:boundaries.length,manifestFiles:manifest.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
