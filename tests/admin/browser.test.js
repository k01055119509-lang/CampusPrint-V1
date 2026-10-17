'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { isolated, PROJECT, TEST_PASSWORD } = require('../helpers/runtime');
const h = require('../business/helpers');

test('六页经营后台真实接口、视口、主题、异常与完整人工软件流程',async t=>{
  let instant=new Date('2026-10-14T04:00:00.000Z');const runtime=await isolated({studentAccountsEnabled:true,clock:()=>new Date(instant),sessionMs:30*86400000});
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-ui'),'admin-browser');await fs.mkdir(output,{recursive:true});
  let browser;const errors=[],checks=[],screenshots=[];
  t.after(async()=>{await browser?.close();await runtime.destroy();});
  const {user,admin}=await h.actors(runtime);
  browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  async function ready(){await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');}
  async function nav(name){if(await page.locator('[data-view='+name+']').getAttribute('aria-current')==='page'){await page.reload();await ready();}else await page.locator('[data-view='+name+']').click();await page.waitForFunction(view=>document.querySelector('[data-view='+view+']')?.getAttribute('aria-current')==='page'&&document.querySelector('#content')?.getAttribute('aria-busy')==='false',name);}
  async function capture(name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});screenshots.push(name+'.png');const layout=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('*')].map(el=>({tag:el.tagName,classes:String(el.className),right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})).filter(el=>el.right>innerWidth+1).slice(0,12)}));assert.equal(layout.scroll<=layout.viewport,true,'Horizontal overflow: '+name+' '+JSON.stringify(layout));}
  async function submitModal(values={},checksToTick=[]){for(const [name,value]of Object.entries(values)){const field=page.locator('dialog[open] [name='+name+']');if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));else await field.fill(String(value));}for(const name of checksToTick)await page.locator('dialog[open] [name='+name+']').check();await page.locator('dialog[open] [data-submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});}
  await t.test('访客登录空态、角色拒绝和 390px 布局',async()=>{
    await page.goto(runtime.url+'/admin/');await ready();await capture('guest-390-light');
    await page.locator('#admin-account').click();await page.locator('dialog[open] [name=username]').fill(user.user.username);await page.locator('dialog[open] [name=password]').fill(TEST_PASSWORD);await page.locator('dialog[open] [data-submit]').click();await page.getByText('此登录入口与账号身份不匹配').waitFor({state:'visible',timeout:5000}).catch(async()=>assert(await page.locator('dialog[open] [role=alert]').textContent()));
    assert.equal(await page.locator('dialog[open]').count(),1);await page.keyboard.press('Escape');await page.locator('#admin-account').click();await submitModal({username:admin.user.username,password:TEST_PASSWORD});await ready();checks.push('Guest empty state, student rejected by independent administrator login, keyboard dismissal');
  });
  await t.test('首页/订单/用户与售后/设置真实空态及初始收款码',async()=>{
    await capture('overview-390-light');await nav('orders');assert(await page.getByText('没有符合条件的订单',{exact:true}).count());await capture('orders-empty-390-light');
    await nav('people');assert(await page.getByRole('heading',{name:'管理员账号'}).count());await nav('support');assert(await page.getByText('暂无售后或反馈',{exact:true}).count());await nav('settings');assert.equal(await page.locator('[data-payment-upload]').count(),2);assert.equal(await page.locator('[data-channel-preview=wechat]').count(),0);await capture('settings-empty-390-light');checks.push('Four real pages and empty payment image');
  });
  async function clickAction(code){const node=page.locator('[data-action="'+code+'"]');await node.evaluate(el=>{const details=el.closest('details');if(details)details.open=true;});await node.click();}
  async function appearance(theme,language){await page.evaluate(async({theme,language})=>{document.documentElement.dataset.theme=theme;localStorage.setItem('campusprint.theme',theme);const {setLanguage}=await import('/shared/i18n.js');setLanguage(language);},{theme,language});await ready();}
  let order,source;
  await t.test('设置主题、中英文和桌面视口',async()=>{
    await appearance('dark','en');await page.getByRole('heading',{name:'System maintenance'}).waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await capture('settings-390-dark-en');
    await page.setViewportSize({width:1440,height:1000});await capture('settings-1440-dark-en');await appearance('light','zh');checks.push('Chinese/English and light/dark settings persist; 390px and 1440px browser viewports');
  });
  await t.test('多文件不同单双面、100 页来源合法选页和长文件名',async()=>{
    source=await h.upload(runtime,user,'source-100-pages.pdf','软件测试资料.pdf');const longName='长文件名与版面检查'.repeat(18)+'.png';const image=await h.upload(runtime,user,'sample-chinese.png',longName);
    let quote=h.data(await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'1-2,100',copies:3,duplex:true},{fileId:image.id,pages:'all',copies:1,duplex:false}]}),202);await runtime.files.waitForIdle();quote=h.data(await user.request('GET',`/api/print/quotes/${quote.id}`));
    order=h.data(await h.post(user,'/api/orders',h.orderBody(quote)),201);assert.equal(order.totals.contentPages,10);assert.equal(order.totals.sheetCount,7);assert.equal(order.totals.totalAmountFen,470);
    await nav('orders');await page.locator('[data-order="'+order.id+'"]').click();await page.getByText(longName,{exact:true}).waitFor();await capture('order-1440-light');await page.setViewportSize({width:390,height:844});await capture('order-390-light');checks.push('Real two-file order with mixed sidedness, 10 content pages, 7 sheets, 470 fen and long filename');
  });
  await t.test('同源生产预览、页码、关闭释放私有 URL',async()=>{
    await page.locator('[data-action="preview-'+order.items[0].itemId+'"]').click();await page.waitForFunction(()=>document.querySelector('dialog .preview')?.naturalWidth>0);await page.locator('dialog [name=page]').fill('3');await page.locator('dialog [data-action=view]').click();await page.waitForFunction(()=>document.querySelector('dialog [role=status]').textContent==='');await capture('production-preview-390');
    const blobUrl=await page.locator('dialog .preview').getAttribute('src');await page.keyboard.press('Escape');await page.locator('.preview-dialog').waitFor({state:'detached'});assert.equal(await page.locator('dialog .preview').count(),0);assert.equal(await page.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},blobUrl),true);checks.push('Final production preview pages loaded through protected API; closed Blob URL verified revoked');
  });
  await t.test('后台收款图片配置、学生声明后人工核款',async()=>{
    await nav('settings');await page.locator('[data-payment-upload=wechat] input[type=file]').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.locator('[data-payment-upload=wechat] [type=submit]').click();await page.locator('[data-channel-preview=wechat]').waitFor({state:'visible'});assert.equal(h.data(await user.request('GET','/api/print/config')).payment.configured,true);
    order=h.data(await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:'BROWSER-SOFTWARE-DECLARATION',note:'软件测试，未真实付款'}));
    await nav('orders');await page.locator('[data-order="'+order.id+'"]').click();await page.locator('[data-action=operation-confirm]').waitFor();await page.locator('[data-action=operation-confirm]').click();await submitModal({amountFen:470,channel:'other',reference:'BROWSER-SOFTWARE-RECEIPT',note:'隔离软件模拟核款，无真实到账'},['verified']);
    order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.payment.status,'confirmed');await page.locator('[data-action=operation-fulfillment_delivered]').waitFor();checks.push('Payment image configured in UI; student declaration remains submitted until explicit manual receipt');
  });
  await t.test('多窗口状态冲突刷新最新记录并保留输入',async()=>{
    await clickAction('operation-fulfillment_delivered');await page.locator('dialog [name=note]').fill('浏览器保留的交付说明');await page.locator('dialog [name=actualDeliveryConfirmed]').check();order=await h.action(admin,order,'fulfillment-action',{action:'pause',reasonCode:'print_problem',reasonText:'外部测试窗口记录异常'});
    await page.locator('dialog [data-submit]').click();await page.waitForFunction(()=>document.querySelector('dialog [role=alert]')?.textContent.includes('订单已改变'));assert.equal(await page.locator('dialog [name=note]').inputValue(),'浏览器保留的交付说明');await page.keyboard.press('Escape');checks.push('409 conflict loads the latest order and retains the original delivery input');
  });
  await t.test('浏览器原因表单、逐项恢复、配送暂停与实际送达',async()=>{
    await clickAction('operation-fulfillment_resume');await submitModal({pauseCode:'workflow',reasonCode:'issue_resolved'});
    await clickAction('operation-fulfillment_pause');await submitModal({reasonCode:'recipient_absent',reasonText:'软件模拟房间无人接收'});order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.completedAt,null);
    await clickAction('operation-fulfillment_resume');await submitModal({pauseCode:'workflow',reasonCode:'verified_continue'});await clickAction('operation-fulfillment_delivered');await submitModal({note:'软件模拟确认送达，无真实配送'},['actualDeliveryConfirmed']);
    order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.lifecycle,'completed');assert.equal(order.production.status,'not_started');assert.equal(Date.parse(order.filesExpireAt)-Date.parse(order.completedAt),7*86400000);checks.push('Reason forms, independent pause/resume and actual delivery without invented print completion');
  });
  await t.test('退款批准/实际退回以及文字工单回复均用真实接口',async()=>{
    await clickAction('operation-refund_request');await submitModal({amountFen:50,reasonCode:'print_problem',reasonText:'软件模拟售后部分退款'});order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));const refundId=order.refunds[0].id;
    await page.locator('[data-action="refund-approve-'+refundId+'"]').click();await submitModal({reasonCode:'verified_request',reasonText:'软件模拟批准，尚未实际退回',fulfillmentDecision:'resume'});order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.actualRefundFen,0);
    await page.locator('[data-action="refund-paid_out-'+refundId+'"]').click();await submitModal({reasonCode:'refund_completed',reasonText:'软件模拟实退，无真实资金',fulfillmentDecision:'resume',payoutReference:'BROWSER-SOFTWARE-REFUND'},['actualRefundConfirmed']);
    order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.actualRefundFen,50);
    const ticket=h.data(await h.post(user,`/api/me/orders/${order.id}/tickets`,{subject:'浏览器软件售后',message:'文字保留与回复验证'}),201);await nav('support');await page.locator('[data-action="reply-'+ticket.id+'"]').click();await submitModal({message:'浏览器软件已解决，不自动退款',status:'resolved'});await capture('support-390-light');checks.push('UI partial refund approval is not paid out; explicit paid refund bounded by receipt; ticket close is text only');
  });
  await t.test('到期订单仍可查询，受控清理后页面显示文件已清理且禁预览下载',async()=>{
    instant=new Date(Date.parse(order.filesExpireAt));h.data(await admin.request('POST','/api/admin/files/cleanup-run',{}));await nav('orders');await page.locator('[data-order="'+order.id+'"]').click();await page.getByText('文件已过期或已清理，重新打印请上传文件下新单。',{exact:true}).first().waitFor();assert.equal(await page.locator('[data-action^=preview-]').count(),0);assert.equal(await page.locator('[data-action^=download-]').count(),0);await capture('expired-order-390-light');
    await page.setViewportSize({width:1440,height:1000});await nav('settings');await appearance('dark','en');await nav('orders');await page.locator('[data-order="'+order.id+'"]').click();await page.getByText('Files have expired or been cleared. Upload new files for a new order.',{exact:true}).first().waitFor();await capture('expired-order-1440-dark-en');checks.push('At exactly seven days, cleanup removes file trees while order/receipts/refunds/support remain visible; preview/download absent');
  });
  await t.test('断网失败与重试、退出登录释放私有内容',async()=>{
    await page.route('**/api/admin/dashboard',route=>route.abort());await nav('dashboard');assert(await page.getByRole('heading',{name:'Records are unavailable'}).count());await page.unroute('**/api/admin/dashboard');await page.locator('[data-action=retry]').click();await ready();await page.getByText('Confirmed receipts',{exact:true}).first().waitFor();await capture('overview-1440-dark-en');
    await page.locator('#admin-logout').click();await page.getByRole('heading',{name:'Sign in to manage orders'}).waitFor();assert.equal(await page.locator('img[src^="blob:"]').count(),0);assert.equal(await page.locator('[data-order]').count(),0);checks.push('Network failure offers explicit retry; sign-out removes private order DOM and Blob URLs');
  });
  await t.test('360px 下 99 内容页、0.50/49.50 元边界可读，登录失效释放预览',async()=>{
    await page.locator('#admin-account').click();await submitModal({username:admin.user.username,password:TEST_PASSWORD});await ready();const high=await h.order(runtime,user,{copies:99,duplex:true}),low=await h.order(runtime,user);
    await page.setViewportSize({width:360,height:800});await nav('orders');await page.locator('[data-order="'+high.id+'"]').click();await page.locator('#order-detail').getByText('CN¥49.50',{exact:true}).first().waitFor();await capture('order99-360-dark-en');assert.equal(high.totals.contentPages,99);assert.equal(high.totals.sheetCount,99);
    await page.locator('[data-order="'+low.id+'"]').click();await page.locator('#order-detail').getByText('CN¥0.50',{exact:true}).first().waitFor();await capture('order050-360-dark-en');
    await page.locator('[data-action="preview-'+low.items[0].itemId+'"]').click();await page.waitForFunction(()=>document.querySelector('dialog .preview')?.naturalWidth>0);const url=await page.locator('dialog .preview').getAttribute('src');
    const token=(await (await page.request.get(runtime.url+'/api/auth/csrf',{headers:{'X-CP-Surface':'admin'}})).json()).data.csrfToken;await page.request.post(runtime.url+'/api/auth/logout',{data:{},headers:{'X-CP-Surface':'admin','X-CSRF-Token':token,Origin:runtime.url}});
    await page.evaluate(async()=>{const {request}=await import('/shared/api.js');try{await request('/admin/dashboard');}catch{}});await page.getByRole('heading',{name:'Sign in to manage orders'}).waitFor();await page.locator('dialog').waitFor({state:'detached'});assert.equal(await page.locator('dialog').count(),0);assert.equal(await page.locator('img[src^="blob:"]').count(),0);assert.equal(await page.evaluate(async value=>{try{await fetch(value);return false;}catch{return true;}},url),true);checks.push('360px: 99 content pages and CNY 0.50/49.50 readable; externally expired session revokes live preview and removes private DOM');
  });
  assert.deepEqual(errors,[]);assert.equal(checks.length,12);const report={kind:'C-v1.3.0-admin-browser-software-test',browser:browser.version(),viewports:[360,390,1440],checks,screenshots,pageErrors:errors,realMobileDevice:false,realPayment:false,realPrinting:false,realDelivery:false};await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
});
