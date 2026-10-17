'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url'),{chromium}=require('playwright-core');
const ROOT=path.resolve(__dirname,'../..');
async function main(){
  const output=path.resolve(process.argv[2]);await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true}),page=await browser.newPage();const screenshots=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{for(const width of [390,1440]){await page.setViewportSize({width,height:900});await page.goto(pathToFileURL(path.join(ROOT,'docs/V1.4.0-简明使用说明.html')).href);assert((await page.title()).includes('1.4.0'));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert((await page.locator('body').innerText()).includes('已经记录收款不能取消'));const file='guide-'+width+'.png';await page.screenshot({path:path.join(output,file),fullPage:true});screenshots.push(file);}}finally{await browser.close();}
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,staticGuide:true,viewports:[390,1440],screenshots,pageErrors:errors},null,2));console.log(JSON.stringify({passed:true,viewports:[390,1440]}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
