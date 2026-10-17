'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{randomUUID,createHash}=require('node:crypto');
const {chromium}=require('playwright-core');
const {startServer}=require('../../backend/server');
const {legacyFixture}=require('../helpers/legacy-guest');
const {TEST_ROOT,PROJECT,removeTestStorage}=require('../helpers/runtime');
const h=require('../business/helpers');
test('C 真1.2.0八迁移订单管理页面：历史文字、无接单时间、直接送达与原期限',{timeout:60000},async t=>{
  const name=randomUUID(),root=path.join(TEST_ROOT,name),now=new Date(),fixture=await legacyFixture(root,{clock:()=>now}),raw=new DatabaseSync(fixture.config.dbPath);
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),image=await h.fixture('sample-chinese.png'),items=JSON.parse(fixture.itemsJson),address={...JSON.parse(fixture.addressJson),notes:'历史自由文字：请先联系再当面交付'},file=items[0].fileId;
  try{
    for(const migration of ['102-guest-access.sql','103-pricing-coupons.sql','104-merchant-service.sql']){const sql=await fs.readFile(path.join(PROJECT,'backend/migrations',migration),'utf8');raw.exec(sql);raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration,sha(sql),now.toISOString());}
    // Rebuild only this synthetic fixture row at the old schema, without removing immutable guards.
    raw.prepare('DELETE FROM print_orders WHERE id=?').run(fixture.orderId);
    raw.prepare("INSERT INTO print_orders(id,orderNo,userId,quoteId,createdAt,updatedAt,itemsJson,totalsJson,addressJson,totalAmountFen,contentPages,sheetCount,paymentStatus) VALUES(?,?,?,?,?,?,?,?,?,1300,52,26,'confirmed')").run(fixture.orderId,'CP-LEGACY-TEST',fixture.users.student.id,fixture.quoteId,fixture.createdAt,fixture.createdAt,fixture.itemsJson,fixture.totalsJson,JSON.stringify(address));
    raw.prepare("INSERT INTO payment_receipts(id,orderId,amountFen,channel,reference,referenceKey,confirmedAt,confirmedBy,note) VALUES(?,?,1300,'other','LEGACY-SOFTWARE-RECEIPT','legacy-software-receipt',?,?,'历史软件收款说明')").run(randomUUID(),fixture.orderId,fixture.createdAt,fixture.users.admin.id);
    raw.prepare("INSERT INTO files(id,ownerId,originalName,mimeType,byteSize,sourceSha256,sourcePageCount,status,claimedOrderId,uploadedAt,temporaryExpiresAt) VALUES(?,?,?,'image/png',?,?,52,'ready',?,?,?)").run(file,fixture.users.student.id,'legacy-software.png',image.length,sha(image),fixture.orderId,fixture.createdAt,new Date(+now+86400000).toISOString());
    assert.equal(raw.prepare('SELECT count(*) n FROM schema_migrations').get().n,8);
  }finally{raw.close();}
  await fs.mkdir(path.join(fixture.config.fileRoot,file),{recursive:true});await fs.writeFile(path.join(fixture.config.fileRoot,file,'original.bin'),image);
  const runtime=await startServer({...fixture.config,clock:()=>now}),browser=await chromium.launch(process.env.CP_TEST_BROWSER_PATH?{executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true}:{channel:'msedge',headless:true});
  t.after(async()=>{await browser.close();await runtime.close();await removeTestStorage(name);});
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});await context.addCookies([{name:'cp_session',value:fixture.sessions.admin.token,url:runtime.url,httpOnly:true,sameSite:'Lax'}]);const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(runtime.url+'/admin/#orders&orderId='+fixture.orderId);await page.locator('[data-action=operation-fulfillment_delivered]').waitFor();await page.getByText(address.notes,{exact:true}).waitFor();
  let row=runtime.db.get('SELECT * FROM print_orders WHERE id=?',fixture.orderId);assert.equal(row.acceptedAt,null);assert.equal(row.addressJson,JSON.stringify(address));assert.equal(row.productionStatus,'not_started');
  assert.equal(await page.locator('[data-normal-actions] button').count(),1);await page.locator('[data-action=operation-fulfillment_delivered]').click();await page.locator('dialog [name=actualDeliveryConfirmed]').check();await page.locator('dialog [data-submit]').click();await page.locator('dialog').waitFor({state:'hidden'});
  row=runtime.db.get('SELECT * FROM print_orders WHERE id=?',fixture.orderId);assert.equal(row.acceptedAt,null);assert.equal(row.productionStatus,'not_started');assert.equal(row.completedAt,now.toISOString());assert.equal(Date.parse(row.filesExpireAt)-Date.parse(row.completedAt),7*86400000);const deadline=row.filesExpireAt;
  await page.reload();await page.locator('#order-detail [data-fulfillment-stage=completed]').first().waitFor();assert.equal(runtime.db.get('SELECT filesExpireAt FROM print_orders WHERE id=?',fixture.orderId).filesExpireAt,deadline);assert.equal(await page.locator('[data-action=operation-fulfillment_delivered]').count(),0);
  const output=path.join(process.env.CP_VERIFICATION_DIR||path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-admin'),'legacy-admin-browser');await fs.mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'legacy-completed-390.png'),fullPage:true});assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,kind:'C-real-eight-migration-legacy-admin-browser',fromMigrations:8,toMigrations:runtime.db.get('SELECT count(*) n FROM schema_migrations').n,historicalAddressText:true,noInferredAcceptanceTime:true,directActualDelivery:true,noInventedPrintCompletion:true,expiryUnchangedOnReload:true,oldAmountFen:row.totalAmountFen,pageErrors:errors,realDatabaseMigrated:false},null,2));
});
