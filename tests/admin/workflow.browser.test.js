'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright-core');
const {isolated,Client,PROJECT,TEST_PASSWORD}=require('../helpers/runtime');
const {createAdmin}=require('../../backend/auth');
const h=require('../business/helpers');

test('C 1.3.0 管理端真实接口：两步履约、独立暂停、管理员、反馈和精简设置',async t=>{
  let instant=new Date('2026-10-15T10:00:00.000Z');
  const runtime=await isolated({clock:()=>new Date(instant),sessionMs:30*86400000});
  const {user,other,admin}=await h.actors(runtime);
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-admin'),'admin-workflow-browser');
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage();
  page.setDefaultTimeout(10000);const errors=[],checks=[],requests=[],screenshots=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:request.method()});});
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  async function nav(route){await page.evaluate(()=>document.querySelectorAll('dialog').forEach(dialog=>dialog.close())).catch(()=>{});await page.goto(runtime.url+'/admin/#'+route);await page.waitForFunction(view=>document.querySelector('#content')?.getAttribute('aria-busy')==='false'&&(view==='advertisements'||document.querySelector('[data-view="'+view+'"]')?.getAttribute('aria-current')==='page'),route.split('&')[0]);}
  async function open(order){await nav('orders&orderId='+order.id);await page.locator('#order-detail [data-fulfillment-stage]').first().waitFor();}
  async function clickAction(code){const node=page.locator('[data-action="'+code+'"]');await node.evaluate(el=>{const details=el.closest('details');if(details)details.open=true;});await node.click();}
  async function submit(values={},checksToTick=[]){const dialog=page.locator('dialog[open]');for(const [name,value]of Object.entries(values)){const node=dialog.locator('[name='+name+']');if(await node.evaluate(el=>el.tagName)==='SELECT')await node.selectOption(String(value));else await node.fill(String(value));}for(const name of checksToTick)await dialog.locator('[name='+name+']').check();await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});}
  async function shot(name){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow: '+name);assert(await page.evaluate(()=>[...document.querySelectorAll('.admin-nav a span:last-child')].every(el=>el.scrollWidth<=el.clientWidth)),'Navigation text overflow: '+name);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,mask:[page.locator('[name=password]'),page.locator('[data-channel-preview]')],maskColor:'#dce5de'});screenshots.push(name+'.png');}
  const getOrder=id=>admin.request('GET','/api/admin/orders/'+id).then(h.data);
  let order,general,ticket;
  await t.test('独立管理员登录、六个导航，无广告请求与旧路由降级',async()=>{
    await nav('dashboard');await page.locator('#admin-account').click();await submit({username:admin.user.username,password:TEST_PASSWORD});await ready();
    assert.equal(await page.locator('[data-view]').count(),6);assert.equal(await page.locator('[data-view=advertisements]').count(),0);
    await shot('dashboard-1440');await nav('advertisements');await page.getByRole('heading',{name:'此功能暂不可用'}).waitFor();assert.equal(requests.filter(r=>r.path.includes('advertisements')).length,0);
    checks.push('independent login, six navigation items, disabled old advertisement route without API requests');
  });
  await t.test('管理员列表真实搜索、分页，页面没有学生或售后',async()=>{
    for(let n=0;n<21;n++)await createAdmin(runtime.db,runtime.config,{username:'pageadmin_'+n,password:TEST_PASSWORD,nickname:'分页管理员'+n});
    await nav('people');assert.equal(await page.locator('[data-admin-list] .user-row').count(),20);assert.equal(await page.locator('[data-support-list]').count(),0);assert(!(await page.locator('#content').innerText()).includes(user.user.nickname));
    await page.locator('[data-page=users][data-step="1"]').click();await ready();assert.equal(await page.locator('.user-row').count(),2);
    await page.locator('#user-search [name=q]').fill('pageadmin_20');await page.locator('#user-search [type=submit]').click();await ready();assert.equal(await page.locator('.user-row').count(),1);
    await page.locator('#user-search [name=q]').fill(user.user.nickname);await page.locator('#user-search [type=submit]').click();await ready();assert.equal(await page.locator('.user-row').count(),0);await shot('administrators-search');
    checks.push('server-backed administrator search and pagination; no student rows or tickets');
  });
  await t.test('独立售后显示一般反馈、完整联系方式与订单售后，筛选和冲突回复',async()=>{
    order=await h.order(runtime,user);
    general=h.data(await h.post(user,'/api/me/feedback',{message:'隔离一般反馈：希望完善说明',contactType:'wechat',contactValue:'software-feedback-contact'}),201);
    ticket=h.data(await h.post(user,'/api/me/orders/'+order.id+'/tickets',{subject:'隔离订单售后',feedbackType:'print_quality',message:'软件测试质量反馈'}),201);
    await nav('support');const generalCard=page.locator('[data-ticket-id="'+general.id+'"]');await generalCard.getByText('software-feedback-contact',{exact:false}).waitFor();assert.equal(await generalCard.locator('a[href^="#orders"]').count(),0);
    await page.locator('[name=category]').selectOption('general');await page.locator('#ticket-filter [type=submit]').click();await ready();assert.equal(await page.locator('[data-ticket-id]').count(),1);
    await clickAction('reply-'+general.id);
    h.data(await h.post(admin,'/api/admin/tickets/'+general.id+'/updates',{expectedVersion:general.version,message:'另一窗口软件回复',status:'in_progress'}));
    const dialog=page.locator('dialog[open]');await dialog.locator('[name=message]').fill('本窗口软件回复');await dialog.locator('[name=status]').selectOption('resolved');await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'已更新'}).waitFor();assert.equal(await dialog.locator('[name=message]').inputValue(),'本窗口软件回复');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready();
    await page.locator('[name=category]').selectOption('order');await page.locator('[name=feedbackType]').selectOption('print_quality');await page.locator('[name=status]').selectOption('open');await page.locator('#ticket-filter [type=submit]').click();await ready();assert.equal(await page.locator('[data-ticket-id]').count(),1);assert.equal(await page.locator('[data-ticket-id] a[href^="#orders"]').count(),1);
    assert.equal(h.data(await other.request('GET','/api/me/tickets')).total,0);assert.equal((await user.request('GET','/api/me/tickets/'+general.id)).body.data.status,'resolved');await shot('support-order');
    checks.push('separate support, general contact, valid order links, three filters and ticket-detail conflict reread');
  });
  await t.test('设置严格三个模块，双渠道图片上传、替换、清除与维护局部更新',async()=>{
    await nav('settings');assert.equal(await page.locator('[data-settings-module]').count(),3);assert.equal(await page.locator('[name=acceptingOrders],[name=buildingLabel],[name=theme],[name=language],[name=serviceNotice]').count(),0);
    for(const channel of ['wechat','alipay']){await page.locator('[data-payment-upload='+channel+'] [name=file]').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.locator('[data-payment-upload='+channel+'] [type=submit]').click();await page.locator('[data-channel-preview='+channel+']').waitFor({state:'visible'});}
    const settings=h.data(await admin.request('GET','/api/admin/settings'));assert(settings.payment.channels.every(item=>item.available));
    await page.locator('[data-payment-clear=alipay]').click();await page.locator('dialog [type=checkbox]').check();await page.locator('dialog [data-submit]').click();await page.locator('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('[data-channel-preview=alipay]').count(),0);
    await page.locator('[data-payment-upload=alipay] [name=file]').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.locator('[data-payment-upload=alipay] [type=submit]').click();await page.locator('[data-channel-preview=alipay]').waitFor({state:'visible'});
    await page.locator('#toggle-maintenance').click();await submit({message:'软件隔离维护提示'},['confirm']);await ready();const maintained=h.data(await admin.request('GET','/api/admin/settings'));assert.equal(maintained.maintenance.enabled,true);assert.equal(maintained.acceptingOrders,settings.acceptingOrders);assert.deepEqual(maintained.building,settings.building);assert.deepEqual(maintained.payment.instructions,settings.payment.instructions);assert(maintained.payment.channels.every(item=>item.available));
    await page.locator('#toggle-maintenance').click();await submit({message:''},['confirm']);await ready();await shot('settings-three-modules');
    checks.push('three settings modules, two payment images, clear/replace and maintenance preserves other settings');
  });
  await t.test('营业快速连点只发一次明确目标，无弹窗；既有订单与反馈继续',async()=>{
    await nav('dashboard');const before=requests.filter(r=>r.path==='/api/admin/settings'&&r.method==='PATCH').length;
    await page.locator('#toggle-operation').evaluate(node=>{node.click();node.click();});await page.locator('[data-operation-state]').filter({hasText:'休息中'}).waitFor();await ready();
    assert.equal(requests.filter(r=>r.path==='/api/admin/settings'&&r.method==='PATCH').length-before,1);assert.equal(await page.locator('dialog').count(),0);
    assert.equal((await user.upload(await h.fixture('sample-chinese.png'),'paused.png','image/png')).body.error.code,'ORDERS_PAUSED');assert.equal((await user.request('GET','/api/me/orders/'+order.id)).status,200);
    h.data(await h.post(user,'/api/me/feedback',{message:'休息期间一般反馈仍可提交'}),201);
    await page.locator('#toggle-operation').click();await page.locator('[data-operation-state]').filter({hasText:'营业中'}).waitFor();checks.push('one explicit opening PATCH, rapid-click guard, no dialog and existing work remains available');
  });
  await t.test('营业响应丢失、版本冲突和重读失败均不反转重发',async()=>{
    await nav('dashboard');let patches=[];
    await page.route('**/api/admin/settings',async route=>{if(route.request().method()==='PATCH'){patches.push(route.request().postDataJSON());await route.fetch();return route.abort();}return route.continue();});
    await page.locator('#toggle-operation').click();await page.locator('[data-operation-state]').filter({hasText:'休息中'}).waitFor();await page.locator('#global-status').filter({hasText:'已重读'}).waitFor();assert.equal(patches.length,1);assert.equal(patches[0].acceptingOrders,false);assert.deepEqual(Object.keys(patches[0]).sort(),['acceptingOrders','expectedVersion']);await page.unroute('**/api/admin/settings');
    let current=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:current.version,acceptingOrders:true}));
    const before=requests.filter(r=>r.path==='/api/admin/settings'&&r.method==='PATCH').length;await page.locator('#toggle-operation').click();await page.locator('#global-status').filter({hasText:'已重读'}).waitFor();await page.locator('[data-operation-state]').filter({hasText:'营业中'}).waitFor();assert.equal(requests.filter(r=>r.path==='/api/admin/settings'&&r.method==='PATCH').length-before,1);
    await page.route('**/api/admin/settings',route=>route.abort());await page.locator('#toggle-operation').click();await page.locator('#global-status').filter({hasText:'尚无法确认'}).waitFor();assert(await page.locator('#toggle-operation').isDisabled());await page.unroute('**/api/admin/settings');await page.locator('#refresh').click();await ready();assert.equal(h.data(await admin.request('GET','/api/admin/settings')).acceptingOrders,true);
    checks.push('lost reply, stale settings version and unreadable result do not send a second toggle');
  });
  await t.test('核款表单不复制学生参考，正常原因免填，真实凭据仍必填',async()=>{
    order=h.data(await h.post(user,'/api/me/orders/'+order.id+'/payment-submissions',{expectedVersion:order.version,channel:'alipay',reference:'STUDENT-UNVERIFIED-REFERENCE'}));await open(order);
    assert.equal(await page.locator('[data-normal-actions] button').count(),1);await clickAction('operation-confirm');const dialog=page.locator('dialog[open]');assert.equal(await dialog.locator('[name=channel]').inputValue(),'alipay');assert.equal(await dialog.locator('[name=reference]').inputValue(),'');assert.equal(await dialog.locator('[name=reasonCode]').count(),0);assert.equal(await dialog.locator('form').evaluate(form=>form.checkValidity()),false);
    await submit({reference:'C-TEST-RECEIPT-'+randomUUID()},['verified']);order=await getOrder(order.id);assert.equal(order.fulfillment.stage,'in_progress');assert(order.fulfillment.acceptedAt);assert.equal(order.production.status,'not_started');assert.equal(order.completedAt,null);assert.equal(await page.locator('[data-normal-actions] button').count(),1);assert.equal(await page.locator('[data-action=operation-start],[data-action=operation-delivery_start],[data-action=operation-complete]').count(),0);await shot('accepted-two-step');
    checks.push('verified receipt required, declaration channel prefill only, one atomic acceptance without invented printing');
  });
  await t.test('门口交付与实际送达保护，丢响应沿原幂等键且期限不重复',async()=>{
    const file=await h.upload(runtime,user),quote=await h.quote(runtime,user,file);
    let door=h.data(await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'local-dorm',room:'门口软件测试房间',receiptMethod:'doorstep',receiptNote:'软件隔离测试主动选择'}})),201);door=await h.confirm(admin,door);await open(door);await page.getByText('用户已主动选择放在房间门口；实际按此方式交付后才可确认送达。',{exact:true}).waitFor();await clickAction('operation-fulfillment_delivered');const dialog=page.locator('dialog[open]');assert.equal(await dialog.locator('[name=actualDeliveryConfirmed]').isChecked(),false);assert.equal(await dialog.locator('form').evaluate(form=>form.checkValidity()),false);
    const keys=[],bodies=[];let lose=true;
    await page.route('**/api/admin/orders/'+door.id+'/fulfillment-action',async route=>{keys.push(route.request().headers()['idempotency-key']);bodies.push(route.request().postDataJSON());if(lose){lose=false;await route.fetch();return route.abort();}return route.continue();});
    await dialog.locator('[name=actualDeliveryConfirmed]').check();await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'结果尚未确认'}).waitFor();const first=await getOrder(door.id);assert.equal(first.fulfillment.stage,'completed');instant=new Date(+instant+60000);await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await page.unroute('**/api/admin/orders/'+door.id+'/fulfillment-action');const second=await getOrder(door.id);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.deepEqual(bodies[0],bodies[1]);assert.equal(first.completedAt,second.completedAt);assert.equal(first.filesExpireAt,second.filesExpireAt);assert.equal(Date.parse(second.filesExpireAt)-Date.parse(second.completedAt),7*86400000);assert.equal(second.production.status,'not_started');
    checks.push('explicit doorstep choice, actual delivery confirmation, identical idempotent retry and immutable expiry');
  });
  await t.test('异常原因其他必填，双暂停逐项处理不提前放行',async()=>{
    order=await h.order(runtime,user);order=h.legacyFinancial(runtime,order);order=await h.confirm(admin,order);
    await open(order);await clickAction('operation-fulfillment_pause');const dialog=page.locator('dialog[open]');await dialog.locator('[name=reasonCode]').selectOption('other');assert.equal(await dialog.locator('[name=reasonText]').getAttribute('required'),'');await dialog.locator('[name=reasonText]').fill('  ');assert.equal(await dialog.locator('form').evaluate(form=>form.checkValidity()),false);await submit({reasonText:'隔离制作配送异常'});
    order=await getOrder(order.id);assert.equal(await page.locator('[data-pause-code]').count(),2);assert.equal(await page.locator('[data-action=operation-fulfillment_delivered]').count(),0);
    await clickAction('operation-fulfillment_resume');await submit({pauseCode:'workflow',reasonCode:'issue_resolved'});order=await getOrder(order.id);assert.equal(order.fulfillment.stage,'paused');assert.deepEqual(order.fulfillment.pauseReasons.map(r=>r.code),['financial']);assert.equal(await page.locator('[data-action=operation-fulfillment_delivered]').count(),0);await page.locator('#global-status').filter({hasText:'订单仍暂停'}).waitFor();
    await clickAction('operation-resolve_exception');await submit({reasonCode:'exact_receipt',resolutionOutcome:'exact_receipt'});order=await getOrder(order.id);assert.equal(order.fulfillment.stage,'in_progress');await shot('independent-pauses-resolved');
    checks.push('other requires nonblank details; one resume removes one pause; financial resolution remains independent');
  });
  await t.test('准确收款遇券暂停，金额不符与重复真实凭据均不伪装接单成功',async()=>{
    const batch=h.data(await h.post(admin,'/api/admin/coupon-batches',{type:'discount',quantity:1,payRatePercent:80,minPrintAmountFen:0}),201);
    const coupon=batch.coupons[0],revealed=h.data(await h.post(admin,'/api/admin/coupons/reveal-codes',{couponIds:[coupon.id]})).items[0].code;
    const file=await h.upload(runtime,user),q0=h.data(await h.post(user,'/api/print/quotes',{items:[{fileId:file.id,pages:'all',copies:1,duplex:false}],couponCode:revealed}),202);await runtime.files.waitForIdle();const quote=h.data(await user.request('GET','/api/print/quotes/'+q0.id));let held=h.data(await h.post(user,'/api/orders',h.orderBody(quote)),201);
    const currentCoupon=h.data(await admin.request('GET','/api/admin/coupons?batchId='+batch.batchId)).items[0];h.data(await h.post(admin,'/api/admin/coupons/'+coupon.id+'/disable',{expectedVersion:currentCoupon.version,reasonCode:'campaign_ended'}));await open(held);await clickAction('operation-confirm');await submit({reference:'C-HELD-RECEIPT',channel:'other'},['verified']);held=await getOrder(held.id);assert.equal(held.payment.status,'confirmed');assert.equal(held.fulfillment.stage,'paused');assert.equal(held.fulfillment.acceptedAt,null);await page.locator('#global-status').filter({hasText:'订单仍暂停'}).waitFor();
    await clickAction('operation-coupon_continue');await submit({reasonCode:'honor_discount'});assert.equal((await getOrder(held.id)).fulfillment.stage,'in_progress');
    let mismatch=await h.order(runtime,user);await open(mismatch);await clickAction('operation-confirm');const dialog=page.locator('dialog[open]');await dialog.locator('[name=amountFen]').fill(String(mismatch.totals.totalAmountFen-1));assert.equal(await dialog.locator('[name=reasonCode]').count(),0);await dialog.locator('[name=reference]').fill('C-MISMATCH-RECEIPT');await dialog.locator('[name=verified]').check();const beforeExceptions=runtime.db.get('SELECT count(*) n FROM financial_exceptions').n;await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'金额'}).waitFor();mismatch=await getOrder(mismatch.id);assert.equal(mismatch.payment.receipt,null);assert.equal(runtime.db.get('SELECT count(*) n FROM financial_exceptions').n,beforeExceptions);await page.keyboard.press('Escape');
    await clickAction('operation-confirm');await submitAttemptDuplicate();
    async function submitAttemptDuplicate(){const dialog=page.locator('dialog[open]');await dialog.locator('[name=reference]').fill('C-HELD-RECEIPT');await dialog.locator('[name=verified]').check();await dialog.locator('[data-submit]').click();await dialog.locator('[role=alert]').filter({hasText:'已入账'}).waitFor();assert.equal((await getOrder(mismatch.id)).payment.receipt,null);await page.keyboard.press('Escape');}
    checks.push('coupon hold remains after accurate receipt, amount mismatch is rejected without a new exception, duplicate reference is rejected');
  });
  await t.test('退款停止与制作配送暂停并存，后续恢复决定不抹去既有停止',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user));value=await h.action(admin,value,'fulfillment-action',{action:'pause',reasonCode:'unreachable'});await open(value);
    await clickAction('operation-refund_request');await submit({amountFen:10,reasonCode:'delivery_problem'});value=await getOrder(value.id);const refund=value.refunds[0];await clickAction('refund-approve-'+refund.id);await submit({reasonCode:'verified_request',fulfillmentDecision:'stop'});await clickAction('refund-paid_out-'+refund.id);await submit({reasonCode:'refund_completed',fulfillmentDecision:'resume',payoutReference:'C-REFUND-SOFTWARE'},['actualRefundConfirmed']);value=await getOrder(value.id);assert.equal(value.actualRefundFen,10);assert(value.fulfillment.pauseReasons.some(r=>r.code==='refund_stopped'));assert(value.fulfillment.pauseReasons.some(r=>r.code==='workflow'));await clickAction('operation-fulfillment_resume');await submit({pauseCode:'refund_stopped',reasonCode:'verified_continue'});value=await getOrder(value.id);assert(value.fulfillment.pauseReasons.some(r=>r.code==='workflow'));assert.equal(value.fulfillment.stage,'paused');assert.equal(await page.locator('[data-action=operation-fulfillment_delivered]').count(),0);
    checks.push('refund decisions keep independent workflow and prior refund-stop pauses until explicitly resolved');
  });
  await t.test('兼容打印失败先核对副本恢复，自由文字说明保持可读',async()=>{
    const file=await h.upload(runtime,user),quote=await h.quote(runtime,user,file);let legacy=h.data(await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'local-dorm',room:'兼容测试房间',receiptMethod:'handover',notes:'旧自由接收说明'}})),201);legacy=await h.confirm(admin,legacy);legacy=await h.action(admin,legacy,'production-action',{action:'start'});legacy=await h.action(admin,legacy,'production-action',{action:'fail',completedContentPages:0,note:'旧自由文字打印异常'});
    await open(legacy);await page.getByText('旧自由接收说明',{exact:false}).waitFor();await page.getByText('旧自由文字打印异常',{exact:true}).waitFor();await clickAction('operation-fulfillment_resume');const dialog=page.locator('dialog[open]');await dialog.locator('[name=pauseCode]').selectOption('production_failed');await dialog.locator('[name=reasonCode]').selectOption('verified_continue');assert.equal(await dialog.locator('[name=independentCopiesConfirmed]').isChecked(),false);assert.equal(await dialog.locator('form').evaluate(form=>form.checkValidity()),false);await submit({},['independentCopiesConfirmed']);legacy=await getOrder(legacy.id);assert.equal(legacy.fulfillment.stage,'in_progress');
    checks.push('legacy API failure and free-text fields remain readable; resuming printing requires copy review');
  });
  await t.test('取消原因、无收款核查与售后重印保留，重印不延长期限',async()=>{
    let cancelled=await h.order(runtime,user);await open(cancelled);await clickAction('operation-cancel_cancel');await submit({reasonCode:'cannot_print'});cancelled=await getOrder(cancelled.id);assert.equal(cancelled.lifecycle,'cancelled');assert.equal(cancelled.payment.receipt,null);assert.equal(cancelled.compensation,null);
    let reprint=await h.confirm(admin,await h.order(runtime,user));reprint=await h.action(admin,reprint,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});const expiry=reprint.filesExpireAt;await open(reprint);await clickAction('operation-reprint');await submit({reasonCode:'content_quantity',reasonText:'软件隔离重印测试'});await clickAction('operation-reprint_fail');await submit({completedContentPages:0,reasonCode:'print_problem'});await clickAction('operation-reprint_retry');await submit({reasonCode:'issue_resolved'},['independentCopiesConfirmed']);await clickAction('operation-reprint_complete');await submit({},['actualCompletionConfirmed']);reprint=await getOrder(reprint.id);assert.equal(reprint.production.reprintActive,false);assert.equal(reprint.filesExpireAt,expiry);assert.equal(reprint.fulfillment.stage,'completed');
    checks.push('cancellation remains explicit; reprint reason/failure/retry/completion retain original expiry');
  });
  await t.test('390/360 窄屏、键盘、中英文深色主题，退出释放私有视图',async()=>{
    await page.setViewportSize({width:390,height:844});await open(order);await shot('order-390');await nav('support');await shot('support-390');await nav('settings');await shot('settings-390');
    await page.evaluate(async()=>{document.documentElement.dataset.theme='dark';localStorage.setItem('campusprint.theme','dark');const {setLanguage}=await import('/shared/i18n.js');setLanguage('en');});await ready();await page.getByRole('heading',{name:'System maintenance'}).waitFor();await page.setViewportSize({width:360,height:800});await shot('settings-360-dark-en');await nav('orders&orderId='+order.id);await page.locator('#order-detail [data-fulfillment-stage]').first().waitFor();await shot('order-360-dark-en');
    await clickAction('operation-fulfillment_delivered');await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);await page.locator('#admin-logout').click();await page.getByRole('heading',{name:'Sign in to manage orders'}).waitFor();assert.equal(await page.locator('[data-order],img[src^="blob:"]').count(),0);
    checks.push('390/360 responsive layouts, English dark theme, Escape and signout private-view cleanup');
  });
  assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.path.includes('advertisements')).length,0);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'C-management-stage-real-isolated-API',passed:true,checks,screenshots,pageErrors:errors,realMobileDevice:false,realPayment:false,realPrinting:false,realDelivery:false,jointAcceptance:false,requests},null,2));
});
