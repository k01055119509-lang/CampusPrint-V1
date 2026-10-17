'use strict';
// B is not ready: these are isolated browser interaction checks with explicit route fixtures.
// They prove form conversions/rendering only and MUST NOT be counted as joint/API acceptance.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
const {chromium}=require('playwright-core');
const {isolated,Client,TEST_PASSWORD,PROJECT}=require('../helpers/runtime');

test('C 优惠券页面交互夹具检查（模拟 B 接口，非联合验收）',async t=>{
  const runtime=await isolated(),operator=new Client(runtime);await operator.admin();
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:360,height:800},locale:'zh-CN'}),page=await context.newPage();
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-ui'),'coupon-ui-fixtures');await fs.mkdir(output,{recursive:true});
  const errors=[],checks=[],created=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
  let coupons=[],revealCount=0,disableAttempts=0,failCreate=false,lastCreateKey=null;
  const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ',code=[...randomBytes(25)].map(value=>alphabet[value%32]).join('');
  const ok=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify({success:true,data})});
  await page.route('**/api/admin/coupon**',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push({path:url.pathname,method:request.method(),surface:request.headers()['x-cp-surface']});
    if(url.pathname==='/api/admin/coupons'&&request.method()==='GET')return ok(route,{items:coupons,page:1,pageSize:20,total:coupons.length});
    if(url.pathname==='/api/admin/coupon-batches'){
      const body=request.postDataJSON();created.push(body);const key=request.headers()['idempotency-key'];
      if(failCreate){if(lastCreateKey)assert.equal(key,lastCreateKey);lastCreateKey=key;return route.abort();}
      if(lastCreateKey)assert.equal(key,lastCreateKey);
      const id=randomUUID(),batchId=randomUUID();coupons=[{id,batchId,type:body.type,maskedCode:'*****-*****-*****-*****-ABC23',state:'available',version:1,createdAt:new Date().toISOString(),expiresAt:body.expiresAt||new Date(Date.now()+7*86400000).toISOString(),disabledAt:null,isExpired:false,reservedOrderId:null,redeemedAt:null,minPrintAmountFen:body.minPrintAmountFen,payRatePercent:body.payRatePercent??null,maxDiscountFen:body.maxDiscountFen??null,reductionFen:body.reductionFen??null}];return ok(route,{batchId,quantity:body.quantity,expiresAt:coupons[0].expiresAt,coupons},201);
    }
    if(url.pathname.endsWith('/reveal-codes')){revealCount++;return ok(route,{items:[{id:coupons[0].id,code}]});}
    if(url.pathname.endsWith('/disable')){
      disableAttempts++;const body=request.postDataJSON();assert.equal(body.reasonCode,'campaign_ended');assert.equal(body.reasonText,'C-界面夹具停用');
      if(disableAttempts===1){coupons[0].version=2;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'VERSION_CONFLICT',message:'记录已变化'}})});}
      assert.equal(body.expectedVersion,2);coupons[0].disabledAt=new Date().toISOString();return ok(route,coupons[0]);
    }
    return route.continue();
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  const shot=async name=>{assert.equal(await page.locator('[data-private-code]').count(),0);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,mask:[page.locator('[name=password]')],maskColor:'#dce5de'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));};
  await page.goto(runtime.url+'/admin/#coupons');await ready();await page.locator('#admin-account').click();let dialog=page.locator('dialog[open]');await dialog.locator('[name=username]').fill(operator.user.username);await dialog.locator('[name=password]').fill(TEST_PASSWORD);await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready();
  await t.test('折扣默认1张、默认七天、8.5折转换85，网络失败沿用原键',async()=>{
    await page.locator('[data-coupon-create]').click();dialog=page.locator('dialog[open]');assert.equal(await dialog.locator('[name=quantity]').inputValue(),'1');assert.equal(await dialog.locator('[name=expiryMode]').inputValue(),'default');await dialog.locator('[name=discountTenths]').fill('8.5');await dialog.locator('[name=minimum]').fill('1.23');await dialog.locator('[name=maxDiscount]').fill('2.50');await shot('discount-form-360');
    failCreate=true;await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'结果尚未确认'}).waitFor();assert(await dialog.locator('[name=quantity]').isDisabled());failCreate=false;await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready();assert.equal(created.at(-1).payRatePercent,85);assert.equal(created.at(-1).minPrintAmountFen,123);assert.equal(created.at(-1).maxDiscountFen,250);assert(!Object.hasOwn(created.at(-1),'expiresAt'));checks.push('discount form conversion and retry key');lastCreateKey=null;
  });
  await t.test('完整码仅专用接口返回，面板关闭清空，列表保持遮罩',async()=>{
    assert(!(await page.locator('body').innerText()).includes(code));await page.locator('[data-coupon-reveal]').click();const panel=page.locator('.private-code-dialog');await panel.waitFor();assert((await panel.locator('textarea').inputValue()).replace(/-/g,'')===code,'Coupon code mismatch');await panel.locator('[data-close]').click();await panel.waitFor({state:'detached'});assert.equal(revealCount,1);assert(!(await page.locator('body').innerText()).includes(code));await shot('coupon-list-360');checks.push('private reveal lifecycle');
  });
  await t.test('停用版本冲突刷新后人工重试，状态不自动恢复',async()=>{
    await page.locator('[data-coupon-disable]').click();dialog=page.locator('dialog[open]');await dialog.locator('[name=reasonCode]').selectOption('campaign_ended');await dialog.locator('[name=reasonText]').fill('C-界面夹具停用');await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'记录已变化'}).waitFor();await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready();assert.equal(await page.locator('[data-coupon-disable]').count(),0);assert.equal(await page.locator('[data-action=enable]').count(),0);checks.push('disable conflict interaction');
  });
  await t.test('满减门槛校验与上海自定义到期，390/1440中英主题',async()=>{
    await page.locator('[data-coupon-create]').click();dialog=page.locator('dialog[open]');await dialog.locator('[name=type]').selectOption('threshold');await dialog.locator('[name=minimum]').fill('10');await dialog.locator('[name=reduction]').fill('10');await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'减免额须为正数'}).waitFor();assert.equal(created.filter(body=>body.type==='threshold').length,0);
    await dialog.locator('[name=reduction]').fill('2');await dialog.locator('[name=expiryMode]').selectOption('custom');const future=new Date(Date.now()+2*86400000+8*3600000).toISOString().slice(0,16);await dialog.locator('[name=expiresAt]').fill(future);await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready();assert.equal(created.at(-1).minPrintAmountFen,1000);assert.equal(created.at(-1).reductionFen,200);assert.equal(created.at(-1).expiresAt,new Date(future+':00+08:00').toISOString());
    await page.setViewportSize({width:390,height:844});await shot('coupon-list-390');await page.setViewportSize({width:1440,height:1000});await page.evaluate(async()=>{const {setLanguage}=await import('/shared/i18n.js');document.documentElement.dataset.theme='dark';setLanguage('en');});await ready();await shot('coupon-list-1440-dark-en');checks.push('threshold validation, Shanghai conversion and responsive list');
  });
  assert.deepEqual(errors,[]);assert(requests.every(request=>request.surface==='admin'));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'UI fixtures for pending B interfaces',mockedEndpoints:true,jointAcceptance:false,passed:true,checks,pageErrors:errors,requests},null,2));
});
