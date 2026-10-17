'use strict';
// UI fixtures exercise independent holds and explicit administrator choices, not B business logic.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright-core');
const {isolated,Client,TEST_PASSWORD,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers');

test('C 券异常页面交互夹具（非 B 联合验收）',async t=>{
  const runtime=await isolated(),student=new Client(runtime),admin=new Client(runtime);await student.guest();await admin.admin();
  const made=await h.order(runtime,student),base=h.data(await admin.request('GET','/api/admin/orders/'+made.id)),snapshot={id:'ui-only-coupon',type:'discount',maskedCode:'*****-*****-*****-*****-ABC23',minPrintAmountFen:0,payRatePercent:80,maxDiscountFen:null,reductionFen:null,expiresAt:new Date().toISOString()};
  let order={...base,coupon:snapshot,couponException:{hold:true,reasons:['disabled'],detectedAt:new Date().toISOString(),resolution:null,resolvedAt:null},couponExceptionHistory:[{id:'ui-history',type:'detected',reasons:['disabled'],note:'C-页面夹具异常记录',actorId:admin.user.id,createdAt:new Date().toISOString()}],allowedActions:['view_query_code','review_payment','resolve_coupon_exception']};
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage();
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-ui'),'coupon-order-ui-fixtures');await fs.mkdir(output,{recursive:true});
  async function clickAction(code){const node=page.locator('[data-action="'+code+'"]');await node.evaluate(el=>{const details=el.closest('details');if(details)details.open=true;});await node.click();}
  const writes=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/admin/orders/**',async route=>{
    const request=route.request(),url=new URL(request.url()),target='/api/admin/orders/'+base.id;
    if(url.pathname===target&&request.method()==='GET'){const finance=order.payment.financialHold;order.fulfillment={stage:order.lifecycle==='cancelled'?'cancelled':'paused',acceptedAt:null,completedAt:null,pauseReasons:order.couponException?.hold?[{code:'coupon',label:'优惠券异常待处理'}]:finance?[{code:'financial',label:'财务异常待核实'}]:[{code:'cancellation',label:'取消申请待处理'}],allowedActions:order.allowedActions.includes('review_payment')?['review_payment']:[]};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data:order})});}
    if(!url.pathname.startsWith(target+'/')||request.method()!=='POST')return route.continue();
    const body=request.postDataJSON();assert.equal(request.headers()['x-cp-surface'],'admin');assert.equal(body.expectedVersion,order.version);writes.push({path:url.pathname,body});order.version++;
    if(url.pathname.endsWith('/payment-review')){order.payment={...order.payment,status:'confirmed',confirmedAt:new Date().toISOString(),receipt:{amountFen:order.totals.totalAmountFen,confirmedAt:new Date().toISOString(),channel:'other',reference:'C-UI-fixture',confirmedBy:admin.user.id}};order.allowedActions=['view_query_code','resolve_coupon_exception'];order.cancellation={...order.cancellation,receiptRecorded:true,merchantActions:[]};}
    else if(url.pathname.endsWith('/coupon-resolution')){
      order.couponException.resolution=body.action;order.couponException.resolvedAt=new Date().toISOString();
      if(body.action==='continue'){order.couponException.hold=false;order.payment.financialHold=true;order.payment.exceptions=[{id:'ui-finance',reason:'C-独立财务异常',amountFen:0,createdAt:new Date().toISOString(),resolvedAt:null}];order.allowedActions=['view_query_code','resolve_financial_exception'];}
      else{order.lifecycle='cancelled';order.displayStatus='cancelled';order.allowedActions=['view_query_code'];order.cancellation={...order.cancellation,merchantActions:[],origin:'merchant'};}
    }else if(url.pathname.endsWith('/cancel-resolution')){assert(!Object.hasOwn(body,'noReceiptConfirmed'));order.lifecycle='cancelled';order.displayStatus='cancelled';order.allowedActions=['view_query_code'];}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data:order})});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  const open=async()=>{const url=runtime.url+'/admin/#orders&orderId='+base.id;if(page.url()===url)await page.reload();else await page.goto(url);await ready();await page.locator('[data-action=operation-coupon_continue]').waitFor({state:'attached'});};
  await page.goto(runtime.url+'/admin/');await ready();await page.locator('#admin-account').click();let dialog=page.locator('dialog[open]');await dialog.locator('[name=username]').fill(admin.user.username);await dialog.locator('[name=password]').fill(TEST_PASSWORD);await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await open();
  await t.test('券异常与原因历史独立展示，收款后暂停仍保留',async()=>{
    await page.getByText('C-页面夹具异常记录',{exact:true}).waitFor();assert.equal(await page.locator('[data-action=operation-start]').count(),0);
    await clickAction('operation-confirm');dialog=page.locator('dialog[open]');await dialog.locator('[name=reference]').fill('C-界面模拟-无真实资金');await dialog.locator('[name=note]').fill('C-界面夹具记款');await dialog.locator('[name=verified]').check();await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await page.locator('.coupon-exception .notice.error').waitFor();assert.equal(await page.locator('[data-action=operation-start]').count(),0);
  });
  await t.test('继续后依据返回动作更新，独立财务异常不被前端清除',async()=>{
    await clickAction('operation-coupon_continue');dialog=page.locator('dialog[open]');await dialog.locator('[name=reasonCode]').selectOption('honor_discount');await dialog.locator('[name=reasonText]').fill('C-认可原优惠界面测试');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});assert.equal(writes.at(-1).body.action,'continue');await page.getByText('C-独立财务异常',{exact:false}).waitFor();assert.equal(await page.locator('[data-action=operation-start]').count(),0);assert.equal(await page.locator('[data-action=operation-coupon_continue]').count(),0);
    await page.screenshot({path:path.join(output,'independent-holds-390.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  });
  await t.test('未收款券异常单次取消，没有旧二次批准或核查复选框',async()=>{
    order=structuredClone({...base,coupon:snapshot,couponException:{hold:true,reasons:['expired'],detectedAt:new Date().toISOString(),resolution:null,resolvedAt:null},allowedActions:['view_query_code','resolve_coupon_exception']});await open();
    await clickAction('operation-coupon_cancel');dialog=page.locator('dialog[open]');await dialog.locator('[name=reasonCode]').selectOption('cancel_order');await dialog.locator('[name=reasonText]').fill('C-隔离券异常取消说明');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});assert.equal(writes.at(-1).body.action,'cancel');assert.equal(order.lifecycle,'cancelled');assert.equal(await page.locator('[data-action=operation-cancel_approve]').count(),0);
  });
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'coupon-order-UI-fixtures',mockedEndpoints:true,jointAcceptance:false,passed:true,checks:['receipt keeps coupon hold','continue respects remaining financial hold','single cancellation follows server summary without a second approval'],pageErrors:errors,requests:writes.map(write=>({path:write.path,action:write.body.action,noReceiptConfirmed:write.body.noReceiptConfirmed}))},null,2));
});
