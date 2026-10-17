'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright-core');
const {isolated,Client,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers'),m=require('../business/merchant-helpers'),c=require('../business/coupon-helpers');

async function setup(t,name,overrides={}) {
  const runtime=await isolated({rateLimits:{guestIp:1000,csrfIp:5000,writeUser:5000,writeIp:10000,previewUser:5000,uploadUser:500,authIp:500,authAccount:300,recoverIp:500,recoverSession:500},...overrides});
  const admin=new Client(runtime);await admin.admin();
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage();context.setDefaultTimeout(18000);
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'tmp/B-cancellation'),name);await fs.mkdir(output,{recursive:true});
  const requests=[],errors=[],screenshots=[],releases=[];
  function observe(tab){tab.on('pageerror',error=>errors.push(error.message));tab.on('request',req=>{const url=new URL(req.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method(),surface:req.headers()['x-cp-surface']});});}observe(page);
  async function ready(tab=page){await tab.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');}
  async function go(hash='',tab=page){const url=runtime.url+'/'+hash;if(tab.url()===url)await tab.reload();else await tab.goto(url);await ready(tab);}
  async function owner(tab=page){const client=new Client(runtime);client.cookie=(await tab.context().cookies()).filter(cookie=>cookie.name==='cp_student_session').map(cookie=>cookie.name+'='+cookie.value).join('; ');await client.csrfToken();client.user=h.data(await client.request('GET','/api/auth/me'));return client;}
  async function cookies(client,target=context){await target.addCookies([...client.browser.cookies].map(([name,value])=>({name,value,url:runtime.url,httpOnly:true,sameSite:'Lax'})));}
  async function shot(name,tab=page){await tab.screenshot({path:path.join(output,name+'.png'),fullPage:true,mask:[tab.locator('[data-private-code],[name=queryCode],[name=couponCode],[name=contact],[name=contactValue]')],maskColor:'#dce5de'});screenshots.push(name+'.png');assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow in '+name);}
  async function step(name,work){let problem;await t.test(name,async()=>{try{await work();}catch(error){problem=error;await shot('failure').catch(()=>{});throw error;}});if(problem)throw problem;}
  await fs.writeFile(path.join(output,'runtime.json'),JSON.stringify({root:runtime.root,url:runtime.url,realData:false},null,2));
  t.after(async()=>{for(const release of releases)release();await fs.writeFile(path.join(output,'report.json'),JSON.stringify({kind:'B-1.4.0-real-API-browser',browser:browser.version(),screenshots,requests,pageErrors:errors,isolatedStorage:true,port:runtime.config.port,realFunds:false,realPhone:false,realPaper:false},null,2));await browser.close();await runtime.destroy();});
  return {runtime,admin,browser,context,page,requests,errors,ready,go,owner,cookies,shot,step,observe,releases};
}
const detail=async(client,id)=>h.data(await client.request('GET','/api/me/orders/'+id));
const waitCode=page=>page.locator('[data-code-kind=query]').waitFor();
const codeValue=async(page,kind='query')=>(await page.locator('[data-code-kind='+kind+']').inputValue()).replace(/-/g,'');

test('B1.4 首页公告独立加载、纯文本与多视口',{timeout:150000},async t=>{
  const x=await setup(t,'announcement'),{page,admin,go,step,shot}=x;
  await step('未发布没有空框；公告失败可局部重试且不阻塞首页配置和下单入口',async()=>{
    await go();assert.equal(await page.locator('[data-announcement]').count(),0);
    await page.route('**/api/public/announcement',route=>route.abort());await page.reload();await x.ready();await page.locator('[data-action=reload-announcement]').waitFor();assert(await page.locator('.hero a[href="#print"]').isVisible());assert.equal(await page.locator('#service-state').innerText(),'营业中');
    await page.unroute('**/api/public/announcement');await page.locator('[data-action=reload-announcement]').click();await page.locator('[data-announcement]').waitFor({state:'detached'});
  });
  const content='<img src=x onerror="window.__announcementXss=true">\n<script>window.__announcementXss=true</script>\n'+'公告文字'.repeat(200);
  await step('发布1000字符以内纯文本，换行及长词换行，360/390/1440不遮底栏',async()=>{
    const previous=h.data(await admin.request('GET','/api/admin/announcement'));h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:previous.version,enabled:true,content}));
    await go();await page.locator('.announcement-content').waitFor();assert.equal(await page.locator('.announcement-content').textContent(),content);assert.equal(await page.locator('[data-announcement] img,[data-announcement] script,[data-announcement] a').count(),0);assert.equal(await page.evaluate(()=>window.__announcementXss),undefined);
    assert.equal(await page.locator('.announcement-content').evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
    for(const width of [360,390,1440]){await page.setViewportSize({width,height:width===1440?1000:844});await shot('announcement-'+width);assert(await page.locator('[data-announcement]').evaluate(node=>node.compareDocumentPosition(document.querySelector('.info-grid'))&Node.DOCUMENT_POSITION_PRECEDING));}
    assert.equal(x.requests.filter(r=>r.path.includes('advertisements')||r.path==='/api/me/orders').length,0);
  });
  await step('只在首页出现，英文暗色兼容，停用后移除公告',async()=>{
    for(const route of ['#print','#orders','#me','#support']){await go(route);assert.equal(await page.locator('[data-announcement]').count(),0);}
    await page.locator('[data-view=me]').click();await x.ready();await page.locator('#theme-control').selectOption('dark');await page.locator('#language-control').selectOption('en');await go();await page.locator('.announcement-content').waitFor();await page.setViewportSize({width:360,height:800});await shot('announcement-360-dark-en');
    const previous=h.data(await admin.request('GET','/api/admin/announcement'));h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:previous.version,enabled:false}));await go();await page.locator('[data-announcement]').waitFor({state:'detached'});
  });assert.deepEqual(x.errors,[]);
});

for(const accounts of [false,true])test('B1.4 默认接收方式 '+(accounts?'原账号':'访客')+' 保存重载带入',{timeout:180000},async t=>{
  const x=await setup(t,accounts?'account-defaults':'guest-defaults',{studentAccountsEnabled:accounts}),{page,runtime,go,step}=x;
  let client,order;
  if(accounts){client=new Client(runtime);await client.register();await x.cookies(client);}
  await go('#me');client=await x.owner();h.data(await client.request('PATCH','/api/me/print-defaults',{room:'B-默认房间',notes:'旧原文保留，不猜测放门口',copies:2,duplex:true}));await page.reload();await x.ready();
  await step('未设置不预选门口；旧notes只读，房间/份数/单双面保持',async()=>{
    assert.equal(await page.locator('#defaults-form [name=receiptMethod]').inputValue(),'');assert.equal(await page.locator('#defaults-form [name=notes]').count(),0);await page.getByText('旧原文保留，不猜测放门口',{exact:true}).waitFor();assert.equal(await page.locator('#defaults-form [name=copies]').inputValue(),'2');assert.equal(await page.locator('#defaults-form [name=duplex]').inputValue(),'true');
    await go('#print');assert.equal(await page.locator('#confirm-order [name=receiptMethod]:checked').count(),0);await go('#me');
  });
  for(const method of ['handover','contact_first','doorstep','other'])await step('保存 '+method+' →刷新→新单带入，条件字段准确',async()=>{
    await page.locator('#defaults-form [name=receiptMethod]').selectOption(method);await page.locator('#defaults-form [name=contact]').fill('');
    if(method==='contact_first'){assert.equal(await page.locator('#defaults-form').evaluate(form=>form.checkValidity()),false);await page.locator('#defaults-form [name=contact]').fill('B-isolated-contact');}
    if(method==='other'){assert.equal(await page.locator('#defaults-form').evaluate(form=>form.checkValidity()),false);await page.locator('#defaults-form [name=receiptNote]').fill('B-其他交付说明');}
    const saved=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/me/print-defaults'&&res.request().method()==='PATCH');await page.locator('#defaults-form [type=submit]').click();assert.equal((await saved).status(),200);await page.getByText('已保存',{exact:true}).waitFor();await page.reload();await x.ready();assert.equal(await page.locator('#defaults-form [name=receiptMethod]').inputValue(),method);
    const pref=h.data(await client.request('GET','/api/me/print-defaults'));assert.equal(pref.notes,'旧原文保留，不猜测放门口');assert.equal(pref.copies,2);assert.equal(pref.duplex,true);
    await go('#print');assert.equal(await page.locator('#confirm-order [name=receiptMethod]:checked').inputValue(),method);assert.equal(await page.locator('#confirm-order [name=room]').inputValue(),'B-默认房间');assert.equal(await page.locator('#confirm-order .hint').filter({hasText:'旧原文保留'}).count(),0);await go('#me');
  });
  await step('真实上传预览报价下单带入结构化默认，更新默认不改旧单',async()=>{
    await go('#print');await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.waitForFunction(()=>document.querySelector('#quote-summary [data-total-fen]')?.dataset.totalFen==='100',null,{timeout:90000});
    await page.locator('[data-action=quote-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('[data-action=close-preview]').click();await page.locator('[name=confirmedPreview]').check();await page.locator('#create-order').click();await page.locator('.order-detail').waitFor();order=await detail(client,new URL(page.url()).hash.split('/')[1]);assert.equal(order.deliveryAddress.receiptMethod,'other');assert.equal(order.deliveryAddress.receiptNote,'B-其他交付说明');assert.equal(order.deliveryAddress.notes,'');assert.equal(order.totals.totalAmountFen,100);assert.equal(order.items[0].copies,2);assert.equal(order.items[0].duplex,true);await waitCode(page);await x.shot('defaults-order-390');
    await go('#me');await page.locator('#defaults-form [name=receiptMethod]').selectOption('doorstep');await page.locator('#defaults-form [type=submit]').click();await page.getByText('已保存',{exact:true}).waitFor();assert.equal((await detail(client,order.id)).deliveryAddress.receiptMethod,'other');await page.locator('#defaults-form [name=receiptMethod]').selectOption('');await page.locator('#defaults-form [type=submit]').click();await page.getByText('已保存',{exact:true}).waitFor();await go('#print');assert.equal(await page.locator('[name=receiptMethod]:checked').count(),0);
  });assert.deepEqual(x.errors,[]);
});

test('B1.4 查询码自动显示、复制回退、路由与身份隔离',{timeout:180000},async t=>{
  const x=await setup(t,'query-code'),{page,runtime,go,step}=x;await go();const client=await x.owner(),first=await h.order(runtime,client),second=await h.order(runtime,client);
  const firstCode=h.data(await client.request('GET','/api/me/orders/'+first.id+'/query-code')).queryCode,secondCode=h.data(await client.request('GET','/api/me/orders/'+second.id+'/query-code')).queryCode;
  await step('自动读取并直接复制，无查看弹窗和两个旧复制按钮，不写持久缓存',async()=>{
    await go('#orders/'+first.id);await waitCode(page);assert((await codeValue(page))===firstCode,'Auto-loaded code belongs to first order');assert.equal(await page.locator('[data-action=query-code],[data-action=copy-no],[data-action=copy-amount],.private-code-dialog').count(),0);
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copied=value;}}}));assert.equal(await page.evaluate(()=>window.__copied),undefined);await page.locator('[data-action=copy-query-code]').click();assert(await page.evaluate(code=>window.__copied.replace(/-/g,'')===code,firstCode),'Copied the visible code');
    assert(await page.evaluate(code=>!JSON.stringify({...localStorage,...sessionStorage}).includes(code),firstCode),'No persisted code');await x.shot('automatic-code-390');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard unavailable');}}}));await page.locator('[data-action=copy-query-code]').click();await page.getByText('复制未成功，已选中凭证，请长按或使用 Ctrl+C 手动复制。',{exact:true}).waitFor();assert(await page.locator('[data-code-kind=query]').evaluate(node=>document.activeElement===node&&node.selectionEnd-node.selectionStart===node.value.length));assert.equal(await page.locator('dialog[open]').count(),0);
  });
  await step('单区网络失败和重试不影响付款或重复提交',async()=>{
    await page.route('**/api/me/orders/'+first.id+'/query-code',route=>route.abort());await page.reload();await x.ready();await page.locator('[data-action=load-query-code]').waitFor();assert.equal(await page.locator('[data-code-kind=query]').count(),0);assert.equal(await page.locator('.order-detail').count(),1);await page.unroute('**/api/me/orders/'+first.id+'/query-code');await page.locator('[data-action=load-query-code]').click();await waitCode(page);assert((await codeValue(page))===firstCode,'Retry returns same order code');assert.equal(x.requests.filter(r=>r.path.includes('payment-submissions')).length,0);
  });
  await step('快速换单，旧请求迟到不能覆盖新单；离开详情清除码',async()=>{
    let held,release,finished;const onHeld=new Promise(r=>held=r),waitRelease=new Promise(r=>release=r),onFinished=new Promise(r=>finished=r);
    x.releases.push(release);await page.route('**/api/me/orders/'+first.id+'/query-code',async route=>{try{const response=await route.fetch();held();await waitRelease;await route.fulfill({response});}finally{finished();}});
    await go('#orders/'+first.id);await Promise.race([onHeld,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Held query request not observed')),10000))]);await page.evaluate(id=>location.hash='orders/'+id,second.id);await waitCode(page);assert((await codeValue(page))===secondCode,'Second order code shown');release();await onFinished;await page.waitForTimeout(100);assert((await codeValue(page))===secondCode,'Late first order code discarded');await page.unroute('**/api/me/orders/'+first.id+'/query-code');await page.locator('[data-view=me]').click();await x.ready();assert.equal(await page.locator('[data-private-code]').count(),0);
  });
  await step('查询码恢复者不取完整码，不开放取消或文件；他人拒绝',async()=>{
    const context=await x.browser.newContext({viewport:{width:360,height:800}}),tab=await context.newPage();x.observe(tab);await go('#orders',tab);const other=await x.owner(tab);assert.equal((await other.request('GET','/api/me/orders/'+first.id+'/query-code')).status,404);h.data(await other.request('POST','/api/orders/recover',{queryCode:firstCode}));const before=x.requests.filter(r=>r.path.endsWith('/query-code')&&r.method==='GET').length;await go('#orders/'+first.id,tab);assert.equal(await tab.locator('.recovered-order').count(),1);assert.equal(await tab.locator('[data-private-code],[data-action=load-query-code],[data-action=cancel-order],[data-action=download],[data-action=order-preview]').count(),0);assert.equal(x.requests.filter(r=>r.path.endsWith('/query-code')&&r.method==='GET').length,before);await x.shot('recovered-code-360',tab);await context.close();
  });
  await step('身份改变丢弃旧码和迟到响应',async()=>{
    let held,release,finished;const onHeld=new Promise(r=>held=r),waitRelease=new Promise(r=>release=r),onFinished=new Promise(r=>finished=r);
    x.releases.push(release);await page.route('**/api/me/orders/'+first.id+'/query-code',async route=>{try{const response=await route.fetch();held();await waitRelease;await route.fulfill({response});}finally{finished();}});await go('#orders/'+first.id);await Promise.race([onHeld,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Held query request not observed')),10000))]);
    await x.context.clearCookies();const fresh=new Client(runtime);await fresh.guest();await x.cookies(fresh);await page.evaluate(()=>{const channel=new BroadcastChannel('campusprint.student.identity');channel.postMessage({type:'identity'});channel.close();});await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.order-detail'));release();await onFinished;await page.waitForTimeout(100);assert.equal(await page.locator('[data-private-code]').count(),0);await page.unroute('**/api/me/orders/'+first.id+'/query-code');
  });assert.deepEqual(x.errors,[]);
});

test('B1.4 两种取消、原券返回、退回付款与真实收款禁取消',{timeout:240000},async t=>{
  const x=await setup(t,'cancellation'),{page,runtime,admin,go,step}=x;await m.image(admin,'/api/admin/payment-qr/wechat');await go();const client=await x.owner();
  const issued=await c.issued(admin),originalExpiry=issued.coupon.expiresAt;let order=await c.order(runtime,client,issued.code),review;
  await step('无声明直接取消，错误不误跳，双击防重，丢响应原键重试同事务退券',async()=>{
    await go('#orders/'+order.id);await waitCode(page);assert.equal(await page.locator('[data-action=cancel-order]').innerText(),'取消订单');let attempts=[];
    await page.route('**/api/me/orders/'+order.id+'/cancel-requests',async route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(attempts.length===1)return route.abort();if(attempts.length===2){const response=await route.fetch();assert.equal(response.status(),200);return route.abort();}return route.continue();});
    await page.locator('[data-action=cancel-order]').evaluate(node=>{node.click();node.click();});await page.getByText('未收到确定结果。再次提交将复用原请求；请先重试确认结果。',{exact:true}).waitFor();assert.equal(attempts.length,1);assert(new URL(page.url()).hash.endsWith(order.id));assert.equal(c.row(runtime,issued.coupon).state,'reserved');assert.equal(await page.locator('dialog[open]').count(),0);
    await page.locator('[data-action=cancel-order]').click();await page.waitForFunction(()=>document.querySelector('[data-action=cancel-order]')?.disabled===false);assert.equal(c.row(runtime,issued.coupon).state,'available');assert(new URL(page.url()).hash.endsWith(order.id));await page.locator('[data-action=cancel-order]').click();await page.waitForURL('**/#orders');await x.ready();assert.equal(attempts.length,3);assert.deepEqual(attempts[0],attempts[1]);assert.deepEqual(attempts[1],attempts[2]);assert.deepEqual(Object.keys(attempts[0].body),['expectedVersion']);await page.unroute('**/api/me/orders/'+order.id+'/cancel-requests');await page.locator('[data-cancel-result]').waitFor();assert.equal(await page.locator('[data-order="'+order.id+'"]').count(),1);assert.equal(h.data(await admin.request('GET','/api/admin/orders?q='+order.orderNo)).total,0);assert.equal(runtime.context.orders.coupons.row(issued.coupon.id).expiresAt,originalExpiry);await x.shot('direct-cancel-list-390');
  });
  await step('原券同码可再次占用；学生取消历史及原券结果保留',async()=>{
    const reused=await c.order(runtime,client,issued.code);assert.equal(c.row(runtime,issued.coupon).reservedOrderId,reused.id);await go('#orders/'+order.id);await page.locator('[data-original-coupon-returned]').waitFor();assert.equal(await page.locator('[data-action=cancel-order]').count(),0);await x.shot('direct-cancel-record-390');
  });
  const reviewCoupon=await c.issued(admin);review=await c.order(runtime,client,reviewCoupon.code);
  await step('真实声明→商户退回固定原因→学生可重提，历史声明仍需审核',async()=>{
    await go('#orders/'+review.id);await page.locator('[data-action=payment]').click();await page.locator('[data-payment-area]').waitFor({state:'detached'});review=await detail(client,review.id);review=await h.action(admin,review,'payment-review',{action:'reject',reasonCode:'not_received'});await page.reload();await x.ready();await page.locator('[data-payment-return]').waitFor();await page.getByText('未查到到账',{exact:true}).waitFor();assert.equal(await page.locator('[data-action=cancel-order]').innerText(),'申请取消');await x.shot('payment-return-390');
    const recovery=h.data(await client.request('GET','/api/me/orders/'+review.id+'/query-code')).queryCode;
    const recoveredClient=new Client(runtime);await recoveredClient.guest();h.data(await recoveredClient.request('POST','/api/orders/recover',{queryCode:recovery}));const recoveredContext=await x.browser.newContext({viewport:{width:360,height:800}}),recovered=await recoveredContext.newPage();await x.cookies(recoveredClient,recoveredContext);x.observe(recovered);await go('#orders/'+review.id,recovered);await recovered.locator('[data-payment-return]').waitFor();await recovered.getByText('未查到到账',{exact:true}).waitFor();assert.equal(await recovered.locator('[data-private-code],[data-action=cancel-order]').count(),0);await x.shot('payment-return-recovered-360',recovered);await recovered.locator('[name=paymentReference]').fill('B-software-resubmission');await recovered.locator('[data-action=payment]').click();await recovered.locator('[data-payment-area]').waitFor({state:'detached'});assert.equal(await recovered.locator('[data-payment-return]').count(),0);await recoveredContext.close();await page.reload();await x.ready();review=await detail(client,review.id);review=await h.action(admin,review,'payment-review',{action:'reject',reasonCode:'amount_mismatch'});await page.reload();await x.ready();await page.getByText('金额不符',{exact:true}).waitFor();await page.locator('[data-action=cancel-order]').click();await page.locator('[data-fulfillment-stage=paused]').waitFor();assert.equal(await page.locator('dialog[open]').count(),0);assert(new URL(page.url()).hash.endsWith(review.id));review=await detail(client,review.id);assert.equal(review.cancellation.requestMode,'unavailable');assert.equal(review.lifecycle,'cancel_requested');assert.equal(c.row(runtime,reviewCoupon.coupon).state,'reserved');
  });
  await step('商户拒绝/同意审核，学生历史一致，拒绝不退券，同意退券',async()=>{
    review=await h.action(admin,review,'cancel-resolution',{action:'reject'});await page.reload();await x.ready();await page.locator('[data-action=cancel-order]').waitFor();assert.equal(c.row(runtime,reviewCoupon.coupon).state,'reserved');await page.locator('[data-action=cancel-order]').click();await page.locator('[data-fulfillment-stage=paused]').waitFor();review=await detail(client,review.id);review=await h.action(admin,review,'cancel-resolution',{action:'approve'});await page.reload();await x.ready();await page.locator('[data-cancellation-status]').waitFor();assert.equal(review.lifecycle,'cancelled');assert.equal(review.cancellation.hiddenFromMerchant,false);assert.equal(c.row(runtime,reviewCoupon.coupon).state,'available');assert.equal(review.cancellationRequests.length,2);await x.shot('review-cancel-history-390');
  });
  await step('已有实收无入口；读后发生核款的并发拒绝会刷新而不取消',async()=>{
    let paid=await h.order(runtime,client);paid=await h.confirm(admin,paid);await go('#orders/'+paid.id);assert.equal(await page.locator('[data-action=cancel-order]').count(),0);await page.locator('[data-cancellation-blocked]').waitFor();
    let race=await h.order(runtime,client);await go('#orders/'+race.id);race=await h.confirm(admin,race);await page.locator('[data-action=cancel-order]').click();await page.locator('[data-cancellation-blocked]').waitFor();assert.equal(await page.locator('[data-action=cancel-order]').count(),0);assert.equal((await detail(client,race.id)).lifecycle,'active');await x.shot('receipt-blocked-390');
  });assert.deepEqual(x.errors,[]);
});

test('B1.4 商家补偿码本人权限及可用、占用、核销、停用、到期状态',{timeout:240000},async t=>{
  let now=new Date();const x=await setup(t,'compensation',{studentAccountsEnabled:true,clock:()=>new Date(now),sessionMs:60*86400000}),{runtime,admin,page,go,step}=x;
  const client=new Client(runtime);await client.register();await x.cookies(client);
  async function compensate(){let value=await h.order(runtime,client);return h.action(admin,value,'cancel-resolution',{action:'cancel',reasonCode:'merchant_unavailable',compensate:true});}
  const order=await compensate();let fullCode;
  await step('本人订单展示9折/封顶2元/30天及取消记录，按权限读取并复制',async()=>{
    await go('#orders/'+order.id);await page.locator('[data-compensation-state=available]').waitFor();assert.equal(order.compensation.payRatePercent,90);assert.equal(order.compensation.maxDiscountFen,200);assert.equal(Date.parse(order.compensation.expiresAt)-Date.parse(order.compensation.issuedAt),30*86400000);await page.getByText('9折 · 无门槛 · 最高减免¥2.00 · 发放起30天有效',{exact:true}).waitFor();await page.locator('[data-action=load-compensation-code]').click();await page.locator('[data-code-kind=compensation]').waitFor();fullCode=await codeValue(page,'compensation');assert.equal(fullCode.length,25);assert.equal(await page.locator('[data-action=cancel-order]').count(),0);
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copied=value;}}}));await page.locator('[data-action=copy-compensation-code]').click();assert(await page.evaluate(code=>window.__copied.replace(/-/g,'')===code,fullCode),'Compensation copied');await x.shot('compensation-owner-390');
  });
  await step('恢复者只见规则/状态，不请求码；本人码不串给他人',async()=>{
    const query=h.data(await client.request('GET','/api/me/orders/'+order.id+'/query-code')).queryCode;const other=new Client(runtime);await other.register();assert.equal((await other.request('GET','/api/me/orders/'+order.id+'/compensation-code')).status,404);h.data(await other.request('POST','/api/orders/recover',{queryCode:query}));const context=await x.browser.newContext({viewport:{width:360,height:800}}),tab=await context.newPage();await x.cookies(other,context);x.observe(tab);const before=x.requests.filter(r=>r.path.endsWith('/compensation-code')).length;await go('#orders/'+order.id,tab);await tab.locator('[data-compensation-state=available]').waitFor();assert.equal(await tab.locator('[data-private-code],[data-action=load-compensation-code],[data-action=copy-compensation-code]').count(),0);assert.equal(x.requests.filter(r=>r.path.endsWith('/compensation-code')).length,before);assert.equal((await other.request('GET','/api/me/orders/'+order.id+'/compensation-code')).status,403);await x.shot('compensation-recovered-360',tab);await context.close();
  });
  await step('补偿实际占用和核销后状态更新，完整码撤下且不再取码',async()=>{
    let use=await c.order(runtime,client,fullCode);await page.reload();await x.ready();await page.locator('[data-compensation-state=reserved]').waitFor();use=await h.confirm(admin,use);await page.reload();await x.ready();await page.locator('[data-compensation-state=redeemed]').waitFor();assert.equal(await page.locator('[data-code-kind=compensation],[data-action=load-compensation-code]').count(),0);const response=h.data(await client.request('GET','/api/me/orders/'+order.id+'/compensation-code'));assert.equal(response.code,null);assert.equal(response.unavailableReason,'redeemed');await x.shot('compensation-redeemed-390');
  });
  await step('停用和到期不能呈现为可用，仍保留发放与规则记录',async()=>{
    const stopped=await compensate(),row=runtime.context.orders.coupons.row(stopped.compensation.couponId);h.data(await h.post(admin,'/api/admin/coupons/'+row.id+'/disable',{expectedVersion:row.version,reasonCode:'issued_in_error'}));await go('#orders/'+stopped.id);await page.locator('[data-compensation-state=disabled]').waitFor();await x.shot('compensation-disabled-390');
    const expired=await compensate();now=new Date(+now+31*86400000);await go('#orders/'+expired.id);await page.locator('[data-compensation-state=expired]').waitFor();await x.shot('compensation-expired-390');
  });assert.deepEqual(x.errors,[]);
});

test('B1.4 共享请求兼容：新410保留业务错误，真实文件410仍清理',{timeout:90000},async t=>{
  let now=new Date();const x=await setup(t,'shared-errors',{clock:()=>new Date(now)}),{page,go}=x;await go();await x.cookies(x.admin);
  const owner=await x.owner(),order=await h.order(x.runtime,owner),file=await h.upload(x.runtime,owner);
  await page.evaluate(()=>localStorage.setItem('campusprint.language','en'));await page.reload();await x.ready();
  const result=await page.evaluate(async id=>{
    const {request}=await import('/shared/api.js');let clears=0;const onClear=()=>clears++;window.addEventListener('cp:clear-private-views',onClear);
    const failures=[];for(const [resource,action] of [['payment-review','flag_exception'],['cancel-resolution','request']]){
      try{await request('/admin/orders/'+id+'/'+resource,{method:'POST',context:'admin',body:{expectedVersion:1,action},headers:{'Idempotency-Key':crypto.randomUUID()}});}catch(error){failures.push({status:error.status,code:error.code,message:error.message});}
    }
    window.removeEventListener('cp:clear-private-views',onClear);return {clears,failures};
  },order.id);
  assert.equal(result.clears,0);assert.deepEqual(result.failures.map(e=>e.status),[410,410]);assert.deepEqual(result.failures.map(e=>e.code),['FINANCIAL_EXCEPTION_RECORDING_REMOVED','MERCHANT_CANCEL_REQUEST_REMOVED']);assert(result.failures.every(e=>!e.message.includes('expired')));
  now=new Date(+now+25*3600000);
  const expired=await page.evaluate(async id=>{const {binaryUrl}=await import('/shared/api.js');let clears=0;const handler=()=>clears++;window.addEventListener('cp:clear-private-views',handler);try{await binaryUrl('/files/'+id+'/preview?page=1');}catch(error){window.removeEventListener('cp:clear-private-views',handler);return {clears,status:error.status,code:error.code};}},file.id);
  assert.deepEqual(expired,{clears:1,status:410,code:'FILE_EXPIRED'});assert.deepEqual(x.errors,[]);
});
