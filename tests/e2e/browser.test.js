'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright-core');
const {PDFDocument}=require('pdf-lib');
const {isolated,PROJECT,TEST_PASSWORD}=require('../helpers/runtime');
const h=require('../business/helpers');

test('D 同一服务学生网页与经营后台的真实联合流程及七天清理', {timeout:180000}, async t=>{
  let instant=new Date();const runtime=await isolated({studentAccountsEnabled:true,clock:()=>new Date(instant),sessionMs:30*86400000});
  const {user,admin}=await h.actors(runtime),output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-joint'),'e2e-browser'),samples=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-joint'),'samples');await fs.mkdir(output,{recursive:true});await fs.mkdir(samples,{recursive:true});
  let browser;const errors=[],screenshots=[];t.after(async()=>{await browser?.close();await runtime.destroy();});
  browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  const studentContext=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),adminContext=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
  const student=await studentContext.newPage(),operator=await adminContext.newPage();for(const page of [student,operator])page.on('pageerror',error=>errors.push(error.message));

  async function clickAction(page,code){const control=page.locator('[data-action="'+code+'"]');await control.evaluate(node=>{const group=node.closest('details');if(group)group.open=true;});await control.click();}
  const ready=page=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  async function modal(page,values,checks=[]){for(let[name,value]of Object.entries(values)){if(['note','reason'].includes(name)&&!await page.locator('dialog[open] [name='+name+']').count()&&await page.locator('dialog[open] [name=reasonCode]').count()){const reason=page.locator('dialog[open] [name=reasonCode]');const codes=await reason.locator('option').evaluateAll(options=>options.map(option=>option.value));const code=['honor_discount','cancel_order','amount_mismatch','exact_receipt','verified_request','refund_completed','user_cancelled','print_problem','issue_resolved'].find(code=>codes.includes(code))||codes.find(Boolean);await reason.selectOption(code);name='reasonText';}const field=page.locator(`dialog[open] [name=${name}]`);if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));else await field.fill(String(value));}for(const name of checks)await page.locator(`dialog[open] [name=${name}]`).check();await page.locator('dialog[open] [data-submit]').click();await page.locator('dialog[open]').waitFor({state:'hidden'});await ready(page);}
  async function capture(page,name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,mask:[page.locator('[data-private-code],[name=password]')]});screenshots.push(name+'.png');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  async function refreshStudent(){await student.locator('[data-action=reload-view]').first().click();await ready(student);}
  await operator.goto(runtime.url+'/admin/');await ready(operator);await operator.locator('#admin-account').click();await modal(operator,{username:admin.user.username,password:TEST_PASSWORD});
  await studentContext.addCookies([...user.browser.cookies].map(([name,value])=>({name,value,url:runtime.url,httpOnly:true,sameSite:'Lax'})));await student.goto(runtime.url+'/#print');await ready(student);
  await student.locator('#student-files').setInputFiles([{name:'D软件选页顺序100页来源.pdf',mimeType:'application/pdf',buffer:await h.fixture('source-100-pages.pdf')},{name:'D软件方向测试.jpg',mimeType:'image/jpeg',buffer:await h.fixture('orientation-6.jpg')}]);
  const card=student.locator('.file-card').first();await card.locator('[name=pages]').fill('1-2,100');await card.locator('[name=copies]').fill('3');await card.locator('[name=duplex]').selectOption('true');
  
  await student.waitForFunction(()=>[...document.querySelectorAll('.file-status')].filter(el=>el.textContent.includes('文件已就绪')).length===2,null,{timeout:90000});
  await student.waitForFunction(()=>document.querySelector('[data-total-fen]')?.dataset.totalFen==='470',null,{timeout:90000});
  assert.equal(await student.locator('[data-content-pages]').textContent(),'10');assert.equal(await student.locator('[data-sheet-count]').textContent(),'7');
  for(const button of await student.locator('[data-action=quote-preview]').all()){await button.click();await student.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);await student.locator('[data-action=close-preview]').click();}
  await student.locator('[name=confirmedPreview]').check();await student.locator('#confirm-order [name=room]').fill('D-软件测试房间');await capture(student,'student-quote-390');
  const created=student.waitForResponse(response=>new URL(response.url()).pathname==='/api/orders'&&response.request().method()==='POST');await student.locator('[name=receiptMethod][value=handover]').check();await student.locator('#create-order').click();const creation=await(await created).json();assert.equal(creation.success,true);const orderId=creation.data.id;
  await student.locator('.order-detail').waitFor();assert.equal(await student.locator('[data-action=payment]').isDisabled(),true);await capture(student,'student-payment-empty-390');
  await operator.locator('[data-view=settings]').click();await ready(operator);await operator.locator('[data-payment-upload=wechat] input[type=file]').setInputFiles(path.join(PROJECT,'tests/fixtures/sample-chinese.png'));await operator.locator('[data-payment-upload=wechat] [type=submit]').click();await operator.locator('[data-channel-preview=wechat]').waitFor({state:'visible'});
  await student.reload();await ready(student);await student.locator('[name=paymentChannel]').selectOption('wechat');await student.locator('[name=paymentReference]').fill('D-SOFTWARE-BROWSER-PAYMENT');await student.locator('[name=paymentNote]').fill('隔离软件付款声明，未发生真实资金');await student.locator('[data-action=payment]').click();await student.locator('[data-payment-area]').waitFor({state:'hidden'});
  let order=h.data(await admin.request('GET',`/api/admin/orders/${orderId}`));assert.equal(order.payment.status,'submitted');assert.equal(order.payment.receipt,null);
  await operator.locator('[data-view=orders]').click();await ready(operator);await operator.locator(`[data-order="${orderId}"]`).click();await operator.locator('[data-action=operation-confirm]').waitFor();
  await operator.locator('[data-action=operation-confirm]').click();await modal(operator,{amountFen:470,channel:'wechat',reference:'D-SOFTWARE-BROWSER-RECEIPT',note:'隔离软件人工核款记录，未真实收款'},['verified']);
  await refreshStudent();await student.locator('[data-fulfillment-stage=in_progress]').waitFor();
  order=h.data(await admin.request('GET',`/api/admin/orders/${orderId}`));
  const pdfs=[];
  for(const item of order.items){const fromStudent=await student.request.get(runtime.url+`/api/me/orders/${orderId}/items/${item.itemId}/file`,{headers:{'X-CP-Surface':'student'}}),fromAdmin=await operator.request.get(runtime.url+`/api/admin/orders/${orderId}/items/${item.itemId}/print-file`,{headers:{'X-CP-Surface':'admin'}});assert.equal(fromStudent.status(),200);assert.equal(fromAdmin.status(),200);const bytes=await fromAdmin.body();assert.deepEqual(await fromStudent.body(),bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.printArtifactSha256);const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),item.selectedPageCount);for(const page of pdf.getPages()){assert(Math.abs(page.getWidth()-595.28)<1);assert(Math.abs(page.getHeight()-841.89)<1);}const filename=pdfs.length?'oriented-image-production.pdf':'selected-pages-production.pdf';await fs.writeFile(path.join(samples,filename),bytes);pdfs.push({file:filename,sha256:item.printArtifactSha256,pages:pdf.getPageCount(),copiesInPdf:1});}
  assert.equal(h.data(await admin.request('GET',`/api/admin/orders/${orderId}`)).production.status,'not_started');
  await clickAction(operator,'operation-fulfillment_pause');await modal(operator,{reasonCode:'print_problem',reasonText:'D 软件模拟卡纸，保留部分实际进度核查'});
  await refreshStudent();await student.locator('[data-fulfillment-stage=paused]').waitFor();
  await clickAction(operator,'operation-fulfillment_resume');await modal(operator,{pauseCode:'workflow',reasonCode:'issue_resolved',reasonText:'已核对已完成部分与独立起纸'});
  await clickAction(operator,'operation-fulfillment_pause');await modal(operator,{reasonCode:'recipient_absent',reasonText:'D 软件模拟未能接收'});
  order=h.data(await admin.request('GET',`/api/admin/orders/${orderId}`));assert.equal(order.completedAt,null);assert.equal(order.filesExpireAt,null);
  await clickAction(operator,'operation-fulfillment_resume');await modal(operator,{pauseCode:'workflow',reasonCode:'verified_continue'});
  await operator.locator('[data-action=operation-fulfillment_delivered]').click();await modal(operator,{note:'D 软件确认送达，仅测试状态'},['actualDeliveryConfirmed']);
  order=h.data(await admin.request('GET',`/api/admin/orders/${orderId}`));assert.equal(order.lifecycle,'completed');assert.equal(Date.parse(order.filesExpireAt)-Date.parse(order.completedAt),604800000);
  await refreshStudent();await capture(student,'student-completed-390');await capture(operator,'admin-completed-1440');
  instant=new Date(Date.parse(order.filesExpireAt)-1000);await student.locator('[data-action=order-preview]').first().click();await student.waitForFunction(()=>document.querySelector('#production-preview')?.naturalWidth>0);const oldBlob=await student.locator('#production-preview').getAttribute('src');
  instant=new Date(order.filesExpireAt);assert.equal((await student.request.get(runtime.url+`/api/me/orders/${orderId}/items/${order.items[0].itemId}/file`,{headers:{'X-CP-Surface':'student'}})).status(),410);
  await student.locator('[data-action=close-preview]').click();assert.equal(await student.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},oldBlob),true);
  await operator.locator('[data-view=settings]').click();await ready(operator);await operator.locator('#cleanup-run').click();await modal(operator,{},['confirm']);
  await refreshStudent();await student.locator('#file-expired').waitFor();assert.equal(await student.locator('[data-action=order-preview]').count(),0);await capture(student,'student-files-cleared-390');
  await operator.locator('[data-view=orders]').click();await ready(operator);await operator.locator(`[data-order="${orderId}"]`).click();assert.equal(await operator.locator('[data-action^=download-]').count(),0);await capture(operator,'admin-files-cleared-1440');
  order=h.data(await admin.request('GET',`/api/admin/orders/${orderId}`));assert.equal(order.fileAvailability,'deleted');assert.equal(order.payment.receipt.amountFen,470);assert.deepEqual(errors,[]);
  const report={kind:'D-two-browser-contexts-one-real-service',browser:browser.version(),viewports:[390,1440],screenshots,pageErrors:errors,order:{id:order.id,orderNo:order.orderNo,contentPages:10,sheetCount:7,totalAmountFen:470,payment:'confirmed-software-only',lifecycle:order.lifecycle,completedAt:order.completedAt,filesExpireAt:order.filesExpireAt,fileAvailability:order.fileAvailability},studentAndAdminPdfBytesIdentical:true,pdfs,downloadDidNotStartPrinting:true,printingFailureRetryViaUi:true,deliveryFailureDidNotComplete:true,oldBlobRevoked:true,realMobileDevice:false,realPayment:false,realPrinting:false,realDelivery:false,publicDeployment:false};
  await fs.writeFile(path.join(output,'browser.json'),JSON.stringify(report,null,2));
});
