'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), path=require('node:path');
const {chromium}=require('playwright-core');
const {isolated,Client,TEST_PASSWORD,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers');

test('C 身份、查询码与独立售后真实接口浏览器回归',async t=>{
  let instant=new Date();
  const runtime=await isolated({clock:()=>new Date(instant),sessionMs:30*86400000,rateLimits:{guestIp:100,csrfIp:1000,writeIp:3000,writeUser:1000,authIp:100,authAccount:100,previewUser:1000,recoverIp:100,recoverSession:100}});
  const operator=new Client(runtime);await operator.admin();
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/guest-pricing-coupons-v1.1.0/C/local-ui'),'guest-browser');await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage(),adminPage=await context.newPage();
  const errors=[],requests=[],shots=[];let order,queryCode,studentId,recoveredId;
  for(const tab of [page,adminPage]){tab.on('pageerror',error=>errors.push(error.message));tab.on('request',req=>{const url=new URL(req.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method(),surface:req.headers()['x-cp-surface']||null});});}
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const ready=tab=>tab.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  async function shot(tab,name){assert.equal(await tab.locator('.private-code-dialog[open]').count(),0,'Close modal private panels before screenshots');await tab.screenshot({path:path.join(output,name+'.png'),fullPage:true,maskColor:'#dce5de',mask:[tab.locator('[data-private-code],[name=queryCode],[name=couponCode]')]});shots.push(name+'.png');assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Viewport overflow: '+name);}
  async function json(tab,route,surface='student'){const response=await tab.request.get(runtime.url+'/api'+route,{headers:{'X-CP-Surface':surface}});assert.equal(response.status(),200);return (await response.json()).data;}
  async function loginAdmin(){await adminPage.goto(runtime.url+'/admin/');await ready(adminPage);await adminPage.locator('#admin-account').click();const dialog=adminPage.locator('dialog[open]');await dialog.locator('[name=username]').fill(operator.user.username);await dialog.locator('[name=password]').fill(TEST_PASSWORD);await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await ready(adminPage);}
  async function step(name,work){let failure;await t.test(name,async()=>{try{await work();}catch(error){failure=error;await page.screenshot({path:path.join(output,'failed-state.png'),fullPage:true,mask:[page.locator('[data-private-code],[name=queryCode],[name=couponCode]')],maskColor:'#dce5de'}).catch(()=>{});throw error;}});if(failure)throw failure;}
  await step('自动访客、七天期限、账号入口停用、360/390 桌面视口',async()=>{
    await page.goto(runtime.url+'/user/');await ready(page);assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('[data-view]').count(),5);
    const me=await json(page,'/auth/me');studentId=me.id;assert.equal(me.identityKind,'guest');const expiration=me.sessionExpiresAt;
    await page.locator('[data-view=me]').click();await ready(page);assert.equal(await page.locator('#nickname-form,[data-action=account-security],[data-action=logout]').count(),0);
    assert.equal((await json(page,'/auth/me')).sessionExpiresAt,expiration);await shot(page,'guest-me-390');
    await page.setViewportSize({width:360,height:800});assert.equal(new Set(await page.locator('[data-view]').evaluateAll(nodes=>nodes.map(node=>Math.round(node.getBoundingClientRect().top)))).size,1);await shot(page,'guest-me-360');await page.locator('#theme-control').selectOption('dark');await page.locator('#language-control').selectOption('en');await shot(page,'guest-me-360-dark-en');await page.locator('#language-control').selectOption('zh');await page.locator('#theme-control').selectOption('light');
  });
  await step('同浏览器后台登录、真实收款图片上传及双端 Cookie/CSRF 隔离',async()=>{
    await loginAdmin();assert.equal((await json(page,'/auth/me')).id,studentId);assert.equal((await json(adminPage,'/auth/me','admin')).role,'admin');
    await adminPage.goto(runtime.url+'/admin/#settings');await ready(adminPage);await adminPage.locator('[data-payment-upload=wechat] [name=file]').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await adminPage.locator('[data-payment-upload=wechat] [type=submit]').click();await adminPage.locator('[data-channel-preview=wechat]').waitFor({state:'visible'});await shot(adminPage,'admin-settings-390');
    await adminPage.locator('#admin-logout').click();await ready(adminPage);assert.equal((await json(page,'/auth/me')).id,studentId);await loginAdmin();
  });
  await step('访客真实上传、原有报价预览建单、查询码专用查看及关闭清理',async()=>{
    await page.locator('[data-view=print]').click();await page.locator('[data-view=print][aria-current=page]').waitFor();await ready(page);await page.locator('#student-files').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await page.locator('.file-card').waitFor();await page.getByText('文件已就绪',{exact:true}).waitFor({timeout:90000});
    await page.locator('[data-action=quote-preview]').waitFor({timeout:90000});await page.locator('[data-action=quote-preview]').click();await page.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await page.locator('[data-action=close-preview]').click();
    await page.locator('[name=confirmedPreview]').check();await page.locator('[name=receiptMethod][value=handover]').check();await page.locator('#confirm-order [name=room]').fill('C-隔离测试');await page.locator('#create-order').click();await page.locator('.order-detail').waitFor({timeout:30000});order=await json(page,'/me/orders/'+new URL(page.url()).hash.split('/')[1]);
    assert.equal(order.accessType,'owner');await page.locator('[data-code-kind=query]').waitFor();queryCode=(await page.locator('[data-code-kind=query]').inputValue()).replace(/-/g,'');assert.equal(queryCode.length,32);assert.equal(await page.locator('.private-code-dialog').count(),0);await shot(page,'owner-order-360');
    assert.equal(await page.locator('[data-action=ticket]').count(),0);await page.locator(`a[href="#support/${order.id}"]`).first().click();await ready(page);await page.getByRole('heading',{name:'售后服务',exact:true}).waitFor();
  });
  const recoveredContext=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),recovered=await recoveredContext.newPage();recovered.on('pageerror',error=>errors.push(error.message));
  await step('新访客凭码单单恢复，列表/首页兼容受限 DTO，无私有文件预取',async()=>{
    await recovered.goto(runtime.url+'/#orders');await ready(recovered);recoveredId=(await json(recovered,'/auth/me')).id;assert.notEqual(recoveredId,studentId);
    await recovered.locator('[name=queryCode]').fill('invalid');await recovered.locator('#recover-form [type=submit]').click();await recovered.getByText('查询码应为 32 位有效字符，请核对后重试。',{exact:true}).waitFor();
    const privateRequests=[];recovered.on('request',req=>{if(/\/api\/(files\/|print\/quotes|me\/orders\/[^/]+\/items)/.test(req.url()))privateRequests.push(new URL(req.url()).pathname);});
    await recovered.locator('[name=queryCode]').fill(queryCode.toLowerCase().match(/.{1,4}/g).join(' - '));await recovered.locator('#recover-form [type=submit]').click();await recovered.locator('.recovered-order').waitFor();
    assert.equal(await recovered.locator('[data-action=order-preview],[data-action=download],[data-action=cancel-order],[data-action=load-query-code],[data-private-code]').count(),0);assert.equal(await recovered.locator('#preview-host').count(),0);assert.equal((await json(recovered,'/auth/me')).id,recoveredId);
    await shot(recovered,'recovered-order-390');await recovered.locator('[data-view=orders]').click();await ready(recovered);await recovered.locator('[data-order]').click();await recovered.locator('.recovered-order').waitFor();await recovered.locator('[data-view=home]').click();await ready(recovered);assert.deepEqual(privateRequests,[]);
  });
  await step('独立售后按单提交、读取原工单及后台回复，恢复单可继续付款声明',async()=>{
    await recovered.goto(runtime.url+'/#support/'+order.id);await ready(recovered);await recovered.locator('[data-action=feedback]').click();let dialog=recovered.locator('dialog[open]');await dialog.locator('[name=feedbackType]').selectOption('other');await dialog.locator('[name=subject]').fill('C-隔离售后');await dialog.locator('[name=message]').fill('文字售后与文件权限分别处理');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await recovered.getByRole('heading',{name:'C-隔离售后'}).waitFor();
    const tickets=h.data(await operator.request('GET','/api/admin/tickets?orderId='+order.id));const ticket=tickets.items[0];h.data(await h.post(operator,'/api/admin/tickets/'+ticket.id+'/updates',{expectedVersion:ticket.version,status:'in_progress',message:'C-隔离经营者回复'}));await recovered.reload();await ready(recovered);await recovered.getByText('C-隔离经营者回复',{exact:true}).waitFor();await shot(recovered,'recovered-support-390');
    await recovered.goto(runtime.url+'/#orders/'+order.id);await ready(recovered);await recovered.locator('[name=paymentReference]').fill('C-软件声明-未真实转账');await recovered.locator('[data-action=payment]').click();await recovered.locator('[data-payment-area]').waitFor({state:'detached'});assert((await json(recovered,'/me/orders/'+order.id)).payment.lastSubmittedAt);await shot(recovered,'recovered-payment-declared-390');
  });
  await step('后台查看订单查询码，七天期满更换访客而管理员继续有效',async()=>{
    await adminPage.goto(runtime.url+'/admin/#orders&orderId='+order.id);await ready(adminPage);await adminPage.locator('[data-action=query-code]').click();let panel=adminPage.locator('.private-code-dialog');assert((await panel.locator('textarea').inputValue()).replace(/-/g,'')===queryCode,'Query code mismatch');await panel.locator('[data-close]').click();
    instant=new Date(+instant+7*86400000+1000);await page.reload();await ready(page);const me=await json(page,'/auth/me');assert.notEqual(me.id,studentId);assert.equal(await page.locator('#production-preview').count(),0);assert.equal((await json(adminPage,'/auth/me','admin')).role,'admin');
  });
  assert.deepEqual(errors,[]);
  assert(requests.filter(req=>req.path==='/api/files'&&req.method==='POST').every(req=>req.surface==='student'));
  assert(requests.filter(req=>req.path.startsWith('/api/admin/')).every(req=>req.surface==='admin'));
  assert(requests.filter(req=>req.path.includes('/preview')).every(req=>['student','admin'].includes(req.surface)));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({phase:'frontend-A-real-interfaces',passed:true,bJointAcceptance:false,pricingCouponAcceptance:'covered separately by the live coupon E2E suite',browser:browser.version(),screenshots:shots,requests,pageErrors:errors,realPhone:false,realPayment:false,realPaper:false},null,2));
});
