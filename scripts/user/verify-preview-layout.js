'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {isolated,EVIDENCE,PROJECT,h}=require('../../tests/user/helpers');
(async()=>{
  const runtime=await isolated(),output=path.join(EVIDENCE,'browser');await fs.mkdir(output,{recursive:true});let browser;
  try{
    const {user}=await h.actors(runtime),name='长文件名与最终生产预览'.repeat(10)+'.pdf';
    const file=await h.upload(runtime,user,'source-100-pages.pdf',name),quote=await h.quote(runtime,user,file,{pages:'1-2,100',copies:1,duplex:true}),order=h.data(await h.post(user,'/api/orders',h.orderBody(quote)),201);
    browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addCookies([...user.browser.cookies].map(([name,value])=>({name,value,url:runtime.url,httpOnly:true,sameSite:'Lax'})));
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));const checks=[];
    for(const width of [360,390,1440]){
      await page.setViewportSize({width,height:width===1440?1000:844});await page.goto(runtime.url+'/#orders/'+order.id);await page.locator('.order-detail').waitFor();await page.locator('[data-action=order-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);
      const layout=await page.locator('.preview-heading [data-action=close-preview]').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,scroll:document.documentElement.scrollWidth,viewport:innerWidth}));assert(layout.width>=60);assert(layout.height>=44);assert(layout.scroll<=layout.viewport);
      const screenshot='preview-long-name-'+width+'.png';await page.locator('.preview-panel').screenshot({path:path.join(output,screenshot)});const url=await page.locator('#production-preview').getAttribute('src');await page.locator('[data-action=close-preview]').click();assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'order-preview');assert.equal(await page.evaluate(async value=>{try{await fetch(value);return false;}catch{return true;}},url),true);checks.push({width,layout,screenshot,closeFocusRestored:true,oldBlobRevoked:true});
    }
    // Simulate browsers where randomUUID is unavailable, while preserving real crypto and real HTTP endpoints.
    await context.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
    await page.goto(runtime.url+'/#print');await page.reload();await page.locator('#student-files').waitFor();assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
    const keys=[];page.on('request',value=>{if(value.method()==='POST'&&['/api/print/quotes','/api/orders'].includes(new URL(value.url()).pathname))keys.push(value.headers()['idempotency-key']);});
    await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.waitForFunction(()=>document.querySelector('.file-card .file-status')?.textContent==='文件已就绪');await page.waitForFunction(()=>document.querySelector('[data-total-fen]')?.dataset.totalFen==='50');await page.locator('[data-action=quote-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('[data-action=close-preview]').click();await page.locator('[name=confirmedPreview]').check();await page.locator('[name=receiptMethod][value=handover]').check();await page.locator('#confirm-order [name=room]').fill('C 兼容软件房间');await page.locator('#create-order').click();await page.waitForURL('**/#orders/*');await page.locator('.order-detail').waitFor();assert.equal(keys.length,2);assert(keys.every(key=>/^[a-f0-9]{32}$/.test(key)));assert.equal(await page.locator('[data-total-fen]').getAttribute('data-total-fen'),'50');
    const randomKeyFallback={randomUUIDDisabled:true,getRandomValuesPreserved:true,quoteAndOrderCreated:true,idempotencyKeyLengths:keys.map(key=>key.length)};
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(EVIDENCE,'preview-layout.json'),JSON.stringify({at:new Date().toISOString(),browser:browser.version(),checks,randomKeyFallback,errors,realMobileDevice:false},null,2));console.log(JSON.stringify({previewViewports:checks.map(item=>item.width),randomKeyFallback,passed:true,pageErrors:errors}));
  }finally{await browser?.close();await runtime.destroy();}
})().catch(error=>{console.error(error);process.exitCode=1;});

