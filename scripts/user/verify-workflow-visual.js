'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {isolated,Client,PROJECT}=require('../../tests/helpers/runtime');
const h=require('../../tests/business/helpers'),m=require('../../tests/business/merchant-helpers');
(async()=>{
  const runtime=await isolated(),user=new Client(runtime),admin=new Client(runtime);let browser;
  const output=path.resolve(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'tmp/B-visual'));
  await fs.mkdir(output,{recursive:true});
  try{
    await user.guest();await admin.admin();h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));
    h.data(await user.request('PATCH','/api/me/print-defaults',{room:'B-视觉默认房间',receiptMethod:'other',receiptNote:'请按约定接收方式联系交付，不自动改为放门口',copies:1,duplex:false}));
    h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:1,enabled:true,content:'本栋宿舍打印服务公告\n请确认打印预览后下单。长文本换行检查：'+ 'A'.repeat(480)}));
    const source=await h.upload(runtime,user,'source-100-pages.pdf','长文件名与生产预览'.repeat(12)+'.pdf'),quote=await h.quote(runtime,user,source,{pages:'1-2,100',duplex:true});
    let order=h.data(await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'local-dorm',room:'B-视觉验证',contact:'',receiptMethod:'doorstep',receiptNote:'按约定方式实际交付'}})),201);
    order=h.data(await h.post(user,'/api/me/orders/'+order.id+'/payment-submissions',{expectedVersion:order.version,channel:'wechat'}));
    browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844}});await context.addCookies([...user.browser.cookies].map(([name,value])=>({name,value,url:runtime.url,httpOnly:true,sameSite:'Lax'})));
    const page=await context.newPage(),errors=[],checks=[],responses=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('response',async response=>{if(response.url().includes('/api/')){const payload=await response.json().catch(()=>null);responses.push({path:new URL(response.url()).pathname,status:response.status(),code:payload?.error?.code,resourceStatus:payload?.data?.status});}});
    await page.addInitScript(()=>{window.__timers=[];const original=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{window.__timers.push({ms,source:String(fn).slice(0,140)});return original(fn,ms,...args);};});
    for(const[width,language,theme]of[[390,'zh','light'],[360,'en','dark'],[1440,'en','dark']]){
      await page.setViewportSize({width,height:width===1440?1000:844});await page.goto(runtime.url+'/#me');await page.locator('#theme-control').waitFor();await page.locator('#theme-control').selectOption(theme);await page.locator('#language-control').selectOption(language);await page.evaluate(()=>window.scrollTo(0,scrollY+document.querySelector('#defaults-form').getBoundingClientRect().top-16));await page.locator('#defaults-form').screenshot({path:path.join(output,'defaults-form-'+width+'-'+language+'-'+theme+'.png')});
      await page.goto(runtime.url+'/#home');await page.locator('.announcement-content').waitFor();await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));const announcementBottom=(await page.locator('.announcement-content').boundingBox()).y+(await page.locator('.announcement-content').boundingBox()).height,navTop=(await page.locator('.student-nav').boundingBox()).y;if(width<600)assert(announcementBottom<=navTop,'Announcement can scroll fully above the bottom navigation');await page.screenshot({path:path.join(output,'announcement-bottom-'+width+'-'+language+'-'+theme+'.png')});
      await page.goto(runtime.url+'/#orders/'+order.id);await page.locator('[data-order-module=progress]').waitFor();
      assert.equal(await page.locator('[data-order-module]').count(),5);await page.screenshot({path:path.join(output,'order-'+width+'-'+language+'-'+theme+'.png'),fullPage:true,mask:[page.locator('[data-private-code],[name=queryCode],[name=couponCode]')],maskColor:'#dce5de'});
      await page.locator('[data-order-module=progress]').screenshot({path:path.join(output,'progress-module-'+width+'.png')});
      await page.locator('[data-action=order-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);
      const close=await page.locator('[data-action=close-preview]').boundingBox();assert(close.width>=60&&close.height>=44);await page.locator('.preview-panel').screenshot({path:path.join(output,'preview-long-'+width+'.png')});await page.locator('[data-action=close-preview]').click();
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'order-preview');
      await page.goto(runtime.url+'/#print');await page.reload();await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));
      try{await page.waitForFunction(()=>document.querySelector('#quote-summary [data-total-fen]')?.dataset.totalFen==='50',{},{timeout:20000});}
      catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true,mask:[page.locator('[data-private-code],[name=queryCode],[name=couponCode]')],maskColor:'#dce5de'});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({page:(await page.locator('#content').innerText()).replace(/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){7}/g,'[REDACTED QUERY CODE]'),responses,errors},null,2));throw error;}
      await page.locator('#content').focus();await page.locator('.delivery-panel').screenshot({path:path.join(output,'receipt-form-'+width+'.png')});
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(layout.scroll<=layout.width);checks.push({width,language,theme,layout,previewClose:close,modules:5});
    }
    const timers=await page.evaluate(()=>window.__timers);assert.equal(timers.filter(timer=>/advert|carousel|show\(index/.test(timer.source)).length,0);
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'visual-check.json'),JSON.stringify({passed:true,browser:browser.version(),checks,pageErrors:errors,advertisementTimers:0,actualPhone:false,actualPaper:false},null,2));
    console.log(JSON.stringify({passed:true,viewports:checks.map(v=>v.width),pageErrors:errors}));
  }finally{await browser?.close();await runtime.destroy();}
})().catch(error=>{console.error(error);process.exitCode=1;});
