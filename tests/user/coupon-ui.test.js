'use strict';
// Student quote/coupon UI fixtures are separate from real B acceptance.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const {chromium}=require('playwright-core');
const {isolated,Client,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers');
test('C 学生优惠报价交互夹具（模拟 B 金额，非联合验收）',async t=>{
  const runtime=await isolated(),student=new Client(runtime);await student.guest();
  const file=await h.upload(runtime,student),base=await h.quote(runtime,student,file);
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage();
  await context.addCookies([...student.browser.cookies].map(([name,value])=>({name,value,url:runtime.url,httpOnly:true,sameSite:'Lax'})));
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/guest-pricing-coupons-v1.1.0/C/local-ui'),'student-coupon-ui-fixtures');await fs.mkdir(output,{recursive:true});
  const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ',code=[...randomBytes(25)].map(value=>alphabet[value%32]).join('');
  let quote=structuredClone(base),failQuote=true,key=null,orderRequests=0;const errors=[],quoteRequests=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/print/quotes',async route=>{
    const req=route.request();if(req.method()!=='POST')return route.continue();assert.equal(req.headers()['x-cp-surface'],'student');const body=req.postDataJSON();quoteRequests.push({hasCoupon:!!body.couponCode});
    if(failQuote){key=req.headers()['idempotency-key'];return route.abort();}if(key){assert.equal(req.headers()['idempotency-key'],key);key=null;}
    if(body.couponCode)assert(body.couponCode===code,'Normalized coupon mismatch');
    quote={...base,valid:true,discountAmountFen:body.couponCode?10:0,totalAmountFen:body.couponCode?40:50,coupon:body.couponCode?{id:'ui-fixture',type:'discount',maskedCode:'*****-*****-*****-*****-ABC23',minPrintAmountFen:0,payRatePercent:80,maxDiscountFen:null,reductionFen:null,expiresAt:new Date(Date.now()+86400000).toISOString()}:null};
    return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({success:true,data:quote})});
  });
  await page.route('**/api/print/quotes/'+base.id,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data:quote})}));
  await page.route('**/api/orders',async route=>{if(route.request().method()!=='POST')return route.continue();orderRequests++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'COUPON_UNAVAILABLE',message:'优惠券已不可用'}})});});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  const inspect=async()=>{await page.locator('[data-action=quote-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('[data-action=close-preview]').click();await page.locator('[name=confirmedPreview]').check();await page.locator('[name=receiptMethod][value=handover]').check();};
  await page.goto(runtime.url+'/#print');await ready();await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.getByText('文件已就绪',{exact:true}).waitFor({timeout:90000});
  await t.test('分组小写码归一化，网络重试同键，原价优惠和应付分别展示',async()=>{
    await page.locator('[name=couponCode]').fill(code.toLowerCase().match(/.{1,5}/g).join(' - '));await page.getByText('网络请求失败，请检查连接后按原请求重试。',{exact:true}).first().waitFor();failQuote=false;await page.locator('[data-action=prepare]').click();await page.locator('#quote-summary [data-total-fen="40"]').waitFor();await inspect();
    assert.equal(await page.locator('#global-message').isVisible(),false);await page.screenshot({path:path.join(output,'discount-quote-390.png'),fullPage:true,mask:[page.locator('[name=couponCode]')],maskColor:'#dce5de'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  });
  await t.test('券争抢失败保留兑换码，不自动移除或重建订单',async()=>{
    await page.locator('#confirm-order [name=room]').fill('C-界面夹具');await page.locator('#create-order').click();await page.getByText('优惠券已占用、到期或停用，请移除或换码后重新报价。',{exact:true}).waitFor();assert.equal(orderRequests,1);assert((await page.locator('[name=couponCode]').inputValue()).replace(/[\s-]/g,'').toUpperCase()===code,'Coupon was silently removed');assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);assert.equal(await page.locator('[name=acceptedRules]').count(),0);
  });
  await t.test('主动移除并重新报价，再改参数撤销旧预览和金额确认',async()=>{
    await page.locator('[data-action=remove-coupon]').click();assert.equal(await page.locator('[name=couponCode]').inputValue(),'');await page.locator('#quote-summary [data-total-fen="50"]').waitFor();assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);await inspect();await page.locator('.file-card [name=copies]').fill('2');assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);assert.equal(await page.locator('[name=acceptedRules]').count(),0);assert.equal(orderRequests,1);
  });
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'student-coupon-UI-fixtures',mockedAmounts:true,jointAcceptance:false,passed:true,checks:['code normalization and retry','server amount display','coupon conflict retains code','explicit removal and confirmation invalidation'],quoteRequests,orderRequests,pageErrors:errors},null,2));
});
