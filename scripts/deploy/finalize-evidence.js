'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
async function inventory(relative=''){
  const rows=[];
  for(const entry of await fs.readdir(path.join(ROOT,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name),normalized=name.replaceAll('\\','/');
    if(entry.isDirectory()){
      if(['node_modules','var','tmp','dist','.git','assets-inbox','docs/verification','tests/user/evidence'].includes(normalized))continue;
      rows.push(...await inventory(name));
    }else if(entry.isFile()&&entry.name!=='.env'){
      const bytes=await fs.readFile(path.join(ROOT,name));rows.push({path:normalized,bytes:bytes.length,sha256:sha(bytes)});
    }
  }
  return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function main(){
  const output=path.resolve(process.argv[2]),initial=JSON.parse(await fs.readFile(path.join(output,'full-initial/final-tests.json'),'utf8'));
  const parse=text=>Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(key=>{const match=new RegExp('# '+key+' (\\d+)').exec(text);if(!match)throw Error('Missing TAP count '+key);return [key,Number(match[1])];}));
  const api=parse(await fs.readFile(path.join(output,'full-initial/api-tests.txt'),'utf8')),ui=parse(await fs.readFile(path.join(output,'ui-final/tests.tap'),'utf8'));
  const uiCode=Number((await fs.readFile(path.join(output,'ui-final/exit-code.txt'),'utf8')).trim()),contractCode=Number((await fs.readFile(path.join(output,'contract-final/exit-code.txt'),'utf8')).trim()),contract=JSON.parse(await fs.readFile(path.join(output,'contract-final/contract-report.json'),'utf8'));
  if(api.tests!==api.pass||api.fail||api.skipped||api.cancelled||initial.results[0].exitCode!==0||uiCode!==0||ui.tests!==ui.pass||ui.fail||ui.skipped||ui.cancelled||contractCode!==0||contract.matchedOperations!==73||contract.version!=='1.2.0')throw Error('Verification gates did not pass');
  await fs.copyFile(path.join(output,'full-initial/advertisement-backup-restore.json'),path.join(output,'advertisement-backup-restore.json'));
  await fs.copyFile(path.join(output,'contract-final/contract-report.json'),path.join(output,'contract-report.json'));
  const report={kind:'B-v1.2.0-equivalent-complete-regression',at:new Date().toISOString(),productVersion:'1.2.0',pricingVersion:'1.1.0',passed:true,results:[{phase:'api',exitCode:0,...api,log:'full-initial/api-tests.txt'},{phase:'ui',exitCode:uiCode,...ui,log:'ui-final/tests.tap'},{phase:'contract',exitCode:contractCode,matchedOperations:contract.matchedOperations,log:'contract-final/contract.log'}],nodeTestCountIncludingContainers:api.tests+ui.tests,duplicateSpotChecksExcluded:true,initialWholeCommand:{log:'full-initial/final-tests.json',passed:false,reason:'Initial contract advertisement upload returned EBUSY/500 once. Same unmodified contract re-run succeeded; failure retained.'},realPhone:false,realMoney:false,realPrinting:false,realDelivery:false,publicDeployment:false};
  await fs.writeFile(path.join(output,'final-tests.json'),JSON.stringify(report,null,2));
  const rows=await inventory(),before=JSON.parse(await fs.readFile(path.join(output,'source-before.json'),'utf8')),byName=new Map(before.rows.map(row=>[row.path,row]));
  const protectedCheck=before.protectedRows.map(row=>({path:row.path,matches:rows.find(r=>r.path===row.path)?.sha256===row.sha256}));if(protectedCheck.some(row=>!row.matches))throw Error('A protected source changed');
  const oldLock=JSON.parse(await fs.readFile('D:/CampusPrint-recovery/A-20261015-090848/source/package-lock.json','utf8')),currentLock=JSON.parse(await fs.readFile(path.join(ROOT,'package-lock.json'),'utf8'));for(const lock of [oldLock,currentLock]){delete lock.version;delete lock.packages[''].version;}if(JSON.stringify(oldLock)!==JSON.stringify(currentLock))throw Error('Dependencies or lock entries changed unexpectedly');
  await fs.writeFile(path.join(output,'source-final.json'),JSON.stringify({at:new Date().toISOString(),count:rows.length,rows},null,2));
  await fs.writeFile(path.join(output,'protected-source-check.json'),JSON.stringify({passed:true,count:protectedCheck.length,dependencyLockOnlyProductVersionChanged:true,rows:protectedCheck},null,2));
  const controllerDocument='docs/handoffs/经营支付售后与广告改版/总控-A交接复核-2026-10-15.md';
  await fs.writeFile(path.join(output,'changes.json'),JSON.stringify(rows.filter(row=>row.path!==controllerDocument&&(!byName.has(row.path)||byName.get(row.path).sha256!==row.sha256)).map(row=>({...row,change:byName.has(row.path)?'modified':'added'})),null,2));
  await fs.writeFile(path.join(output,'preexisting-controller-document.json'),JSON.stringify({note:'The controller review existed and was read before B implementation. It is outside the older A source manifest and is not a B addition.',...rows.find(row=>row.path===controllerDocument)},null,2));
  console.log(JSON.stringify({passed:true,api:api.pass,ui:ui.pass,operations:contract.matchedOperations,sourceFiles:rows.length,protectedFiles:protectedCheck.length}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={inventory};
