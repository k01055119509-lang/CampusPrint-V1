'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{chromium}=require('playwright-core');
const {isolated,Client,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers'),m=require('../business/merchant-helpers'),c=require('../business/coupon-helpers');

async function setup(t,name,overrides={}) {
  const runtime=await isolated({rateLimits:{guestIp:500,csrfIp:5000,writeUser:5000,writeIp:10000,previewUser:5000,uploadUser:300,authIp:500,authAccount:300,recoverIp:300,recoverSession:300},...overrides});
  const admin=new Client(runtime);await admin.admin();
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage();
  context.setDefaultTimeout(20000);
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'tmp/B-workflow'),name);await fs.mkdir(output,{recursive:true});
  const errors=[],requests=[],screenshots=[];
  function observe(tab){tab.on('pageerror',error=>errors.push(error.message));tab.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:request.method(),surface:request.headers()['x-cp-surface']});});}
  observe(page);
  async function shot(name,tab=page){await tab.screenshot({path:path.join(output,name+'.png'),fullPage:true,mask:[tab.locator('[data-private-code],[name=queryCode],[name=couponCode],[name=contactValue]')],maskColor:'#dce5de'});screenshots.push(name+'.png');assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+name);}
  t.after(async()=>{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'B-student-real-API-browser',browser:browser.version(),screenshots,requests,pageErrors:errors,realFunds:false,realPhone:false,realPaper:false},null,2));await context.close();await browser.close();await runtime.destroy();});
  async function step(name,work){let failure;await t.test(name,async()=>{try{await work();}catch(error){failure=error;await shot('failure').catch(()=>{});throw error;}});if(failure)throw failure;}
  const ready=tab=>(tab||page).waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  const go=async(url,tab=page)=>{await tab.goto(runtime.url+url);await ready(tab);};
  async function json(route,tab=page){const response=await tab.request.get(runtime.url+'/api'+route,{headers:{'X-CP-Surface':'student'}});assert.equal(response.status(),200);return(await response.json()).data;}
  async function owner(tab=page){const client=new Client(runtime);client.cookie=(await tab.context().cookies()).filter(cookie=>cookie.name==='cp_student_session').map(cookie=>cookie.name+'='+cookie.value).join('; ');await client.csrfToken();client.user=h.data(await client.request('GET','/api/auth/me'));return client;}
  async function quote(fen){await page.waitForFunction(expected=>document.querySelector('#quote-summary [data-total-fen]')?.getAttribute('data-total-fen')===String(expected),fen,{timeout:90000});}
  async function inspect(){for(const button of await page.locator('[data-action=quote-preview]').all()){await button.click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('[data-action=close-preview]').click();}await page.locator('[name=confirmedPreview]').check();}
  return{runtime,admin,browser,context,page,output,errors,requests,shot,step,ready,go,json,owner,quote,inspect,observe};
}

test('B 自动下单、付款直接提交、统一进度和恢复单真实接口',{timeout:300000},async t=>{
  const x=await setup(t,'workflow');const{runtime,admin,page,step,go,ready,quote,inspect,shot,json}=x;
  await m.image(admin,'/api/admin/payment-qr/wechat');await m.image(admin,'/api/admin/payment-qr/alipay');
  let client,order,queryCode,issued,creationAttempts=[],paymentAttempts=[];
  await step('首页无近期订单专用请求，无广告请求或占位；390与桌面首页',async()=>{
    await go('/');assert.equal(await page.locator('[data-order],[data-advertisement-slot],.advertisement').count(),0);
    assert.equal(x.requests.filter(r=>r.path==='/api/me/orders'||r.path.includes('advertisements')).length,0);
    await shot('home-390');await page.setViewportSize({width:1440,height:1000});await shot('home-1440');await page.setViewportSize({width:390,height:844});
    client=await x.owner();issued=await c.issued(admin,{payRatePercent:80});
    h.data(await client.request('PATCH','/api/me/print-defaults',{buildingId:'local-dorm',room:'B-常用房间',contact:'',notes:'原有说明不自动转换',copies:1,duplex:false}));
  });
  await step('PDF与图片自动上传/准备，改份数单双面选页及券；唯一确认与四种接收方式',async()=>{
    await go('/#print');await page.locator('#student-files').setInputFiles([path.join(PROJECT,'tests/fixtures/source-100-pages.pdf'),path.join(PROJECT,'tests/fixtures/sample-chinese.png')]);
    await page.locator('.file-card').nth(0).locator('[name=pages]').fill('1-3');await page.locator('.file-card').nth(0).locator('[name=duplex]').selectOption('true');await page.locator('.file-card').nth(0).locator('[name=copies]').fill('2');
    await quote(330);assert.equal(await page.locator('[data-action=upload],[data-action=prepare]').count(),0);
    await page.locator('[name=couponCode]').fill(issued.code.toLowerCase().match(/.{1,5}/g).join(' - '));await quote(264);
    assert.equal(c.row(runtime,issued.coupon).state,'available');assert.equal(await page.locator('#confirm-order input[type=checkbox]').count(),1);
    assert.equal(await page.locator('[name=saveDefaults],[name=acceptedRules]').count(),0);assert.equal(await page.locator('[name=receiptMethod]:checked').count(),0);
    await inspect();const form=page.locator('#confirm-order');await form.locator('[name=room]').fill('B-自动下单房间');
    assert.equal(await form.evaluate(form=>form.checkValidity()),false);
    await form.locator('[name=receiptMethod][value=handover]').check();assert.equal(await form.evaluate(form=>form.checkValidity()),true);
    await form.locator('[name=receiptMethod][value=contact_first]').check();assert.equal(await form.evaluate(form=>form.checkValidity()),false);await form.locator('[name=contact]').fill('B-隔离联系');assert.equal(await form.evaluate(form=>form.checkValidity()),true);
    await form.locator('[name=receiptMethod][value=other]').check();assert.equal(await form.evaluate(form=>form.checkValidity()),false);await form.locator('[name=receiptNote]').fill('在楼内约定地点当面接收');assert.equal(await form.evaluate(form=>form.checkValidity()),true);
    await form.locator('[name=receiptMethod][value=doorstep]').check();assert.equal(await form.evaluate(form=>form.checkValidity()),true);
    await shot('auto-quote-receipt-390');
  });
  await step('下单响应丢失后锁定原体和幂等键，重复点击只有一单一次占券',async()=>{
    let dropped=false;await page.route('**/api/orders',async route=>{if(route.request().method()!=='POST')return route.continue();creationAttempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(!dropped){dropped=true;const result=await route.fetch();assert.equal(result.status(),201);return route.abort();}return route.continue();});
    await page.locator('#create-order').click();await page.waitForFunction(()=>document.querySelector('#create-order')?.textContent.includes('重试原下单'));
    assert.equal(await page.locator('.file-card [name=copies]').first().isDisabled(),true);assert.equal(await page.locator('[name=couponCode]').isDisabled(),true);
    await page.locator('#create-order').click();await page.locator('.order-detail').waitFor();await ready();await page.unroute('**/api/orders');
    assert.equal(creationAttempts.length,2);assert.deepEqual(creationAttempts[0],creationAttempts[1]);assert.equal(Object.hasOwn(creationAttempts[0].body,'acceptedRules'),false);assert.equal(creationAttempts[0].body.deliveryAddress.receiptMethod,'doorstep');
    const orders=h.data(await client.request('GET','/api/me/orders'));assert.equal(orders.total,1);order=orders.items[0];assert.equal(c.row(runtime,issued.coupon).state,'reserved');assert.equal(order.totals.totalAmountFen,264);
    assert.equal(await page.locator('[data-order-module]').count(),5);assert.equal(await page.locator('.order-detail>.page-heading .status-badge').count(),0);
    await page.locator('[data-view=print]').click();await ready();assert.equal(await page.locator('[name=receiptMethod]:checked').count(),0,'A new order requires a fresh receiving choice');await go('/#orders/'+order.id);
  });
  await step('付款页双渠道完整码与选填参考；失败及丢响应复用原声明，成功只显示待核款',async()=>{
    await page.waitForFunction(()=>document.querySelector('#payment-image')?.naturalWidth>0);await page.locator('[name=paymentChannel]').selectOption('alipay');
    await page.locator('[data-payment-zoom]').click();await page.locator('.payment-image-dialog img').waitFor();await page.locator('.payment-image-dialog button').click();
    const pattern='**/api/me/orders/'+order.id+'/payment-submissions';let attempt=0;
    await page.route(pattern,async route=>{attempt++;paymentAttempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(attempt===1)return route.abort();if(attempt===2){const result=await route.fetch();assert.equal(result.status(),200);return route.abort();}return route.continue();});
    await page.locator('[data-action=payment]').click();await page.waitForFunction(()=>document.querySelector('[data-action=payment]')?.textContent.includes('重试原付款'));
    assert.equal(await page.locator('dialog[open]').count(),0);assert(await page.locator('[data-payment-area]').count());assert.equal((await json('/me/orders/'+order.id)).payment.status,'unpaid');
    await page.locator('[data-action=payment]').click();await page.waitForFunction(()=>document.querySelector('[data-action=payment]')?.textContent.includes('重试原付款')&&!document.querySelector('[data-action=payment]')?.disabled);
    await page.locator('[data-action=payment]').dblclick();await page.locator('[data-payment-area]').waitFor({state:'detached'});await page.unroute(pattern);
    assert.equal(paymentAttempts.length,3);assert.deepEqual(paymentAttempts[0],paymentAttempts[1]);assert.deepEqual(paymentAttempts[1],paymentAttempts[2]);assert.equal(paymentAttempts[0].body.reference,'');
    order=await json('/me/orders/'+order.id);assert.equal(order.payment.status,'submitted');assert.equal(order.payment.confirmedAt,null);assert.equal(order.fulfillment.stage,'pending_acceptance');assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_submissions WHERE orderId=?',order.id).n,1);
    assert.equal(await page.locator('[data-order-module]').count(),5);assert.equal(await page.getByRole('heading',{name:'订单进度',exact:true}).count(),1);assert.equal(await page.locator('[data-order-module=progress]').getByText('待人工核对',{exact:true}).count(),1);assert.equal(await page.locator('#global-message').isVisible(),false);
    await shot('declared-five-modules-390');await page.reload();await ready();assert.equal(await page.locator('[data-order-module]').count(),5);
  });
  await step('核款与独立暂停只显示统一摘要，确认实际送达不伪造打印记录',async()=>{
    order=await h.confirm(admin,order,{channel:'alipay'});await page.reload();await ready();await page.locator('[data-fulfillment-stage=in_progress]').waitFor();
    assert.equal(order.production.status,'not_started');assert.equal(order.delivery.status,'pending');assert.equal(order.filesExpireAt,null);
    order=await h.action(admin,order,'fulfillment-action',{action:'pause',reasonCode:'unreachable'});await page.reload();await ready();assert.equal(await page.locator('[data-fulfillment-stage=paused]').count(),1);await shot('paused-progress-390');
    order=await h.action(admin,order,'fulfillment-action',{action:'resume',pauseCode:'workflow',reasonCode:'issue_resolved'});
    order=await h.action(admin,order,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});await page.reload();await ready();await page.locator('[data-fulfillment-stage=completed]').waitFor();assert.equal(Date.parse(order.filesExpireAt)-Date.parse(order.completedAt),7*86400000);assert.equal(order.production.status,'not_started');await shot('completed-five-modules-390');
    await page.locator('[data-code-kind=query]').waitFor();queryCode=(await page.locator('[data-code-kind=query]').inputValue()).replace(/-/g,'');assert.equal(await page.locator('.private-code-dialog').count(),0);
  });
  await step('新访客查询码恢复、深链接/刷新/列表回入均五模块，无文件和完整码读取请求',async()=>{
    const recoveredContext=await x.browser.newContext({viewport:{width:360,height:800}}),recovered=await recoveredContext.newPage();x.observe(recovered);const restricted=[];
    recovered.on('request',request=>{if(/\/api\/me\/orders\/[^/]+\/(?:items|query-code)/.test(request.url()))restricted.push(new URL(request.url()).pathname);});
    await go('/#orders',recovered);await recovered.locator('[name=queryCode]').fill(queryCode);await recovered.locator('#recover-form [type=submit]').click();await recovered.locator('.recovered-order').waitFor();await ready(recovered);
    assert.equal(await recovered.locator('[data-order-module]').count(),5);assert.equal(await recovered.locator('[data-action=order-preview],[data-action=download],[data-action=load-query-code],[data-private-code],[data-action=cancel-order]').count(),0);await recovered.reload();await ready(recovered);assert.equal(await recovered.locator('[data-order-module]').count(),5);
    await recovered.goto(runtime.url+'/#orders');await ready(recovered);await recovered.locator('[data-order]').click();await recovered.locator('.recovered-order').waitFor();assert.deepEqual(restricted,[]);await shot('recovered-five-modules-360',recovered);
    await recoveredContext.close();
  });
  assert.deepEqual(x.errors,[]);assert.equal(x.requests.filter(request=>request.path.includes('advertisements')).length,0);
});

test('B 自动准备修订归属、真实故障、超限和离开页面',{timeout:240000},async t=>{
  const x=await setup(t,'async-preparation');const{runtime,admin,page,go,ready,step,quote,inspect,shot}=x;
  let client,issued;
  await step('100页源文件不截断，主动选页后自动报价，预览页码对应源第100页',async()=>{
    await go('/#print');client=await x.owner();await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/source-100-pages.pdf'));
    await page.waitForFunction(()=>document.querySelector('.file-card .file-status')?.textContent.includes('文件已就绪'),{},{timeout:90000});
    assert.match(await page.locator('.file-meta').first().innerText(),/100/);assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);assert.equal(await page.locator('#create-order').isDisabled(),true);
    await page.locator('.file-card [name=pages]').fill('1-2,100');await page.locator('.file-card [name=duplex]').selectOption('true');await quote(140);await inspect();
    await page.locator('[data-action=quote-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('#preview-form [name=page]').fill('3');await page.locator('#preview-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.getByText('生产第 3 / 3 页 · 对应原文件第 100 页',{exact:true}).waitFor();await shot('page100-preview-390');await page.locator('[data-action=close-preview]').click();
  });
  await step('连续修改与真实响应乱序：旧金额和已看确认不得回填',async()=>{
    let heldResolve,releaseResolve,doneResolve;const held=new Promise(resolve=>heldResolve=resolve),release=new Promise(resolve=>releaseResolve=resolve),done=new Promise(resolve=>doneResolve=resolve);
    await page.route('**/api/print/quotes',async route=>{if(route.request().method()!=='POST'||route.request().postDataJSON().items[0].copies!==2)return route.continue();try{const response=await route.fetch();assert.equal(response.status(),202);heldResolve();await release;await route.fulfill({response});}finally{doneResolve();}});
    await page.locator('.file-card [name=copies]').fill('2');await held;assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);assert.equal(await page.locator('#student-files').isDisabled(),false);
    await page.locator('.file-card [name=copies]').fill('3');await quote(420);releaseResolve();await done;await page.unroute('**/api/print/quotes');await page.waitForTimeout(200);assert.equal(await page.locator('#quote-summary [data-total-fen]').getAttribute('data-total-fen'),'420');assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);
    const count=x.requests.filter(r=>r.path==='/api/print/quotes'&&r.method==='POST').length;await page.waitForTimeout(800);assert.equal(x.requests.filter(r=>r.path==='/api/print/quotes'&&r.method==='POST').length,count);
  });
  await step('券格式与真实拒绝保留输入，换有效券自动重算且不占用',async()=>{
    await page.locator('[name=couponCode]').fill('bad');await page.locator('[data-action=prepare]').waitFor();assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);
    await page.locator('[name=couponCode]').fill('A'.repeat(25));await page.getByText('兑换码无效，请移除或换码后重新报价。',{exact:true}).first().waitFor();assert.equal(await page.locator('[name=couponCode]').inputValue(),'A'.repeat(25));
    issued=await c.issued(admin);await page.locator('[name=couponCode]').fill(issued.code);await quote(336);assert.equal(c.row(runtime,issued.coupon).state,'available');await inspect();await page.locator('[data-action=remove-coupon]').click();await quote(420);assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);assert.equal(c.row(runtime,issued.coupon).state,'available');
  });
  await step('一个上传失败即使其他文件就绪也不能建少文件订单；重试后包含全部文件',async()=>{
    let failed=false;await page.route('**/api/files',route=>{if(!failed&&route.request().method()==='POST'){failed=true;return route.abort();}return route.continue();});
    await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/orientation-6.jpg'));await page.locator('[data-action=retry-upload]').waitFor();assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);assert.equal(await page.locator('#create-order').isDisabled(),true);await page.unroute('**/api/files');await page.locator('[data-action=retry-upload]').click();await quote(470);assert.equal(await page.locator('[data-action=quote-preview]').count(),2);
    assert.equal(h.data(await client.request('GET','/api/me/orders')).total,0);
  });
  await step('真实解析失败提供移除入口，恢复后自动重新报价；选页重复/份数100不提交',async()=>{
    await page.locator('#student-files').setInputFiles([{name:'损坏.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\ncorrupt test')},{name:'加密.pdf',mimeType:'application/pdf',buffer:await h.fixture('encrypted.pdf')}]);await page.getByText('文件损坏或无法读取，请重新导出后上传。',{exact:true}).waitFor({timeout:60000});await page.getByText('不支持加密或受密码保护的 PDF，请解除保护后上传。',{exact:true}).waitFor({timeout:60000});assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);
    await shot('parse-failures-390');await page.locator('.file-card').nth(3).locator('[data-action=remove-file]').click();await page.locator('.file-card').nth(2).locator('[data-action=remove-file]').click();await quote(470);
    await page.locator('.file-card').first().locator('[name=pages]').fill('1,1');assert.equal(await page.locator('#create-order').isDisabled(),true);await page.locator('.file-card').first().locator('[name=pages]').fill('1-2,100');await page.locator('.file-card').first().locator('[name=copies]').fill('100');assert.equal(await page.locator('#quote-summary [data-total-fen]').count(),0);await page.locator('.file-card').first().locator('[name=copies]').fill('3');await quote(470);
  });
  await step('报价网络失败后只按明确重试复用键，无自动请求风暴',async()=>{
    const attempts=[];let first=true;await page.route('**/api/print/quotes',route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(first){first=false;return route.abort();}return route.continue();});
    await page.locator('.file-card').first().locator('[name=copies]').fill('2');await page.locator('[data-action=prepare]').waitFor();assert.equal(attempts.length,1);await page.waitForTimeout(600);assert.equal(attempts.length,1);await page.locator('[data-action=prepare]').click();await quote(330);assert.deepEqual(attempts[0],attempts[1]);await page.unroute('**/api/print/quotes');
  });
  await step('上传响应未回时主动移除该文件，迟到成功不回填并清除临时文件',async()=>{
    let heldResolve,releaseResolve,doneResolve,uploadedId;const held=new Promise(resolve=>heldResolve=resolve),release=new Promise(resolve=>releaseResolve=resolve),done=new Promise(resolve=>doneResolve=resolve);
    await page.route('**/api/files',async route=>{if(route.request().method()!=='POST')return route.continue();try{const response=await route.fetch();assert.equal(response.status(),202);uploadedId=(await response.json()).data.id;heldResolve();await release;await route.fulfill({response});}finally{doneResolve();}});
    await page.locator('#student-files').setInputFiles({name:'主动移除的临时图片.png',mimeType:'image/png',buffer:await h.fixture('sample-chinese.png')});await held;await page.locator('.file-card').nth(2).locator('[data-action=remove-file]').click();await quote(330);releaseResolve();await done;await page.unroute('**/api/files');await page.waitForFunction(()=>document.querySelectorAll('.file-card').length===2);assert.equal(await page.locator('[data-action=quote-preview]').count(),2);
    const row=()=>runtime.db.get('SELECT status FROM files WHERE id=?',uploadedId);await new Promise(resolve=>setTimeout(resolve,200));assert.notEqual(row()?.status,'ready');
  });
  await step('离开下单页停止轮询且迟到响应不覆盖新路由；返回后按当前输入重算',async()=>{
    let heldResolve,releaseResolve,doneResolve;const held=new Promise(resolve=>heldResolve=resolve),release=new Promise(resolve=>releaseResolve=resolve),done=new Promise(resolve=>doneResolve=resolve);
    await page.route('**/api/print/quotes',async route=>{try{const response=await route.fetch();heldResolve();await release;await route.fulfill({response});}finally{doneResolve();}});
    await page.locator('.file-card').first().locator('[name=copies]').fill('1');await held;await page.locator('[data-view=home]').click();await ready();releaseResolve();await done;await page.unroute('**/api/print/quotes');const count=x.requests.filter(r=>r.path.includes('/print/quotes')).length;await page.waitForTimeout(1200);assert.equal(x.requests.filter(r=>r.path.includes('/print/quotes')).length,count);assert.equal(await page.locator('[data-total-fen]').count(),0);await page.locator('[data-view=print]').click();await ready();await quote(190);assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);
  });
  await step('休息真实阻止新上传/报价，保留问题文件可恢复；既有反馈仍可进入',async()=>{
    const settings=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false}));await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.locator('[data-action=retry-upload]').waitFor();assert.equal(await page.locator('#create-order').isDisabled(),true);assert.equal(await page.locator('[name=confirmedPreview]').isChecked(),false);await shot('paused-draft-390');
    const next=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:next.version,acceptingOrders:true}));await page.locator('[data-view=home]').click();await ready();await page.locator('[data-view=print]').click();await ready();await page.locator('[data-action=retry-upload]').click();await quote(240);
    await page.setViewportSize({width:360,height:800});await page.locator('[data-view=me]').click();await ready();await page.locator('#theme-control').selectOption('dark');await page.locator('#language-control').selectOption('en');await page.locator('[data-view=print]').click();await ready();await quote(240);await shot('auto-print-360-dark-en');await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement!==document.body));
  });
  assert.deepEqual(x.errors,[]);assert.equal(x.requests.filter(r=>r.path.includes('advertisements')).length,0);
});

test('B 无订单反馈与订单售后、回复、归属和凭证到期',{timeout:150000},async t=>{
  let now=new Date();const x=await setup(t,'feedback',{clock:()=>new Date(now)});const{page,runtime,admin,step,go,ready,shot}=x;let client,general,order,orderTicket;
  await step('没有订单也只有一个主要发起入口，一般反馈真实提交且联系选填成对',async()=>{
    await go('/#support');client=await x.owner();assert.equal(await page.locator('[data-action=feedback]').count(),1);await page.locator('[data-action=feedback]').click();let dialog=page.locator('dialog[open]');assert.equal(await dialog.locator('[name=category]').inputValue(),'general');assert.equal(await dialog.locator('[name=orderId],[name=feedbackType],[name=subject]').count(),0);
    await dialog.locator('[name=message]').fill('B-无订单一般反馈');await dialog.locator('[name=contactType]').selectOption('wechat');assert.equal(await dialog.locator('form').evaluate(form=>form.checkValidity()),false);await dialog.locator('[name=contactValue]').fill('B-仅商户可见联系');
    const attempts=[];let dropped=false;await page.route('**/api/me/feedback',async route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),201);return route.abort();}return route.continue();});
    await dialog.locator('[data-submit]').click();await dialog.locator('[name=message]:disabled').waitFor();await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await page.unroute('**/api/me/feedback');assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);assert.equal(Object.hasOwn(attempts[0].body,'orderId'),false);
    const list=h.data(await client.request('GET','/api/me/tickets'));assert.equal(list.total,1);general=list.items[0];assert.equal(general.category,'general');assert.equal(general.orderId,null);assert.equal(Object.hasOwn(general,'contactValue'),false);await page.getByText('B-无订单一般反馈',{exact:true}).first().waitFor();assert.equal((await page.locator('body').innerText()).includes('B-仅商户可见联系'),false);await shot('general-feedback-390');
    const detail=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/me/tickets/'+general.id);await page.locator('[data-action=ticket-detail]').click();assert.equal((await detail).status(),200);await page.locator('dialog[open] .ticket-card').waitFor();assert.equal(await page.locator('dialog[open]').locator('[data-action=feedback],[data-action=ticket-detail]').count(),0);await page.locator('dialog[open] [data-submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});
  });
  await step('一般反馈后台真实回复、刷新可见；跨访客404，不产生订单或优惠占用',async()=>{
    const ticket=h.data(await admin.request('GET','/api/admin/tickets/'+general.id));assert.equal(ticket.contactValue,'B-仅商户可见联系');h.data(await h.post(admin,'/api/admin/tickets/'+ticket.id+'/updates',{expectedVersion:ticket.version,status:'in_progress',message:'B-一般反馈经营者回复'}));await page.reload();await ready();await page.getByText('B-一般反馈经营者回复',{exact:true}).waitFor();
    const other=new Client(runtime);await other.guest();assert.equal((await other.request('GET','/api/me/tickets/'+general.id)).status,404);assert.equal(h.data(await client.request('GET','/api/me/orders')).total,0);
  });
  await step('从订单进入预选订单，保留五类及主题；商户回复与受限投影',async()=>{
    order=await h.order(runtime,client);await go('/#support/'+order.id);await page.locator('[data-action=feedback]').click();const dialog=page.locator('dialog[open]');assert.equal(await dialog.locator('[name=category]').inputValue(),'order');assert.equal(await dialog.locator('[name=orderId]').inputValue(),order.id);assert.equal(await dialog.locator('[name=feedbackType] option[value]:not([value=""])').count(),5);
    await dialog.locator('[name=feedbackType]').selectOption('print_quality');await dialog.locator('[name=subject]').fill('B-订单打印质量问题');await dialog.locator('[name=message]').fill('B-保留原有详细说明');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await page.getByRole('heading',{name:'B-订单打印质量问题',exact:true}).waitFor();
    orderTicket=h.data(await client.request('GET','/api/me/orders/'+order.id+'/tickets')).items[0];h.data(await h.post(admin,'/api/admin/tickets/'+orderTicket.id+'/updates',{expectedVersion:orderTicket.version,status:'resolved',message:'B-订单售后经营者回复'}));await page.reload();await ready();await page.getByText('B-订单售后经营者回复',{exact:true}).waitFor();
    await go('/#orders/'+order.id);assert.equal(await page.locator('[data-order-module=support] a[href="#support/'+order.id+'"]').count(),1);await page.getByText('B-订单售后经营者回复',{exact:true}).waitFor();await shot('order-support-summary-390');
  });
  await step('无声明直接取消无原因表单并回列表；休息不阻止一般反馈',async()=>{
    await page.locator('[data-action=cancel-order]').click();await page.waitForURL('**/#orders');await ready();assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(h.data(await client.request('GET','/api/me/orders/'+order.id)).lifecycle,'cancelled');
    const settings=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false}));await go('/#support');await page.locator('[data-action=feedback]').click();const feedback=page.locator('dialog[open]');await feedback.locator('[name=message]').fill('B-休息期间一般反馈');await feedback.locator('[data-submit]').click();await feedback.waitFor({state:'hidden'});await page.getByRole('heading',{name:'B-休息期间一般反馈',exact:true}).waitFor();
  });
  await step('凭证固定七天，到期新身份和订单查询码均不能找回原一般反馈',async()=>{
    const code=h.data(await client.request('GET','/api/me/orders/'+order.id+'/query-code')).queryCode;now=new Date(+now+7*86400000+1000);await page.reload();await ready();const fresh=await x.owner();assert.notEqual(fresh.user.id,client.user.id);assert.equal((await fresh.request('GET','/api/me/tickets/'+general.id)).status,404);h.data(await fresh.request('POST','/api/orders/recover',{queryCode:code}));assert.equal((await fresh.request('GET','/api/me/tickets/'+general.id)).status,404);assert.equal((await fresh.request('GET','/api/me/tickets/'+orderTicket.id)).status,200);await page.reload();await ready();await shot('feedback-expired-390');
  });
  assert.deepEqual(x.errors,[]);assert.equal(x.requests.filter(r=>r.path.includes('reason-catalog')).length,0);
});
