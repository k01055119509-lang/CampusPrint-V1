'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const project=path.resolve(__dirname,'../..'),output=path.join(project,'tests/user/evidence');
const read=name=>JSON.parse(fs.readFileSync(path.join(output,name),'utf8').replace(/^\uFEFF/,''));
function testResult(name){const value=fs.readFileSync(path.join(output,name),'utf8');const count=key=>Number(new RegExp('(?:#|ℹ) '+key+' (\\d+)').exec(value)?.[1]??NaN);const result={tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};if(!Number.isInteger(result.tests)||result.passed!==result.tests||result.failed||result.skipped)throw new Error('Verification is incomplete: '+name);return result;}
const api=testResult('api-tests.txt'),browser=testResult('browser-tests.txt'),boundaries=read('boundaries-after.json'),distribution=read('distribution-check.json'),contract=read('contract-check.json'),ui=read('browser/report.json');
const preview=read('preview-layout.json'),screenshots=[...ui.screenshots,...preview.checks.map(item=>item.screenshot)];
if(boundaries.changed.length||boundaries.added.length||!distribution.hashUnchanged||distribution.paymentConfigured||ui.pageErrors.length)throw new Error('Boundary/distribution/browser checks failed');
if(preview.errors.length||!preview.randomKeyFallback.quoteAndOrderCreated)throw new Error('Preview/compatibility checks failed');
function walk(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(directory,item.name)):item.isFile()?[path.join(directory,item.name)]:[]);}
const sources=[path.join(project,'frontend/index.html'),...walk(path.join(project,'frontend/user')),...walk(path.join(project,'scripts/user')),...fs.readdirSync(path.join(project,'tests/user')).filter(name=>name.endsWith('.js')).map(name=>path.join(project,'tests/user',name)),path.join(project,'docs/handoffs/C-学生端交接.md')];
const manifest=sources.map(file=>({path:path.relative(project,file).replaceAll('\\','/'),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
const report={at:new Date().toISOString(),platform:process.platform,node:process.version,browser:ui.browser,contracts:contract.results,api,browserTests:browser,totalPassed:api.passed+browser.passed,previewLayout:preview.checks,randomKeyFallback:preview.randomKeyFallback,protectedFilesUnchanged:boundaries.count,newProtectedFiles:boundaries.added,defaultDistribution:distribution,viewports:ui.viewports,screenshotCount:screenshots.length,screenshots,sourceFileCount:manifest.length,realMobileDevice:false,realPrinting:false,realPayment:false,realDelivery:false};
fs.writeFileSync(path.join(output,'verification-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
