'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{randomUUID,createHash}=require('node:crypto');
const {legacyFixture}=require('../helpers/legacy-guest');
const {TEST_ROOT,PROJECT,configAt,Client,removeTestStorage}=require('../helpers/runtime');
const {startServer}=require('../../backend/server');
const h=require('./helpers'),m=require('./merchant-helpers');
const sha=value=>createHash('sha256').update(value).digest('hex');
test('真实八迁移1.2.0旧库升级105：所有旧列、状态、文字、回复、时间、期限及权限保持',{timeout:120000},async t=>{
  const name=randomUUID(),root=path.join(TEST_ROOT,name),now=new Date(),legacy=await legacyFixture(root,{clock:()=>new Date(now)}),config=configAt(root,{clock:()=>new Date(now)});let runtime;
  t.after(async()=>{await runtime?.close();await removeTestStorage(name);});
  const raw=new DatabaseSync(config.dbPath),states=[
    ['unpaid',{paymentStatus:'unpaid'},'pending_acceptance'],['submitted',{paymentStatus:'submitted'},'pending_acceptance'],['rejected',{paymentStatus:'rejected'},'pending_acceptance'],
    ['paid',{paymentStatus:'confirmed'},'in_progress'],['printing',{paymentStatus:'confirmed',productionStatus:'printing'},'in_progress'],['print_failed',{paymentStatus:'confirmed',productionStatus:'failed'},'paused'],
    ['printed',{paymentStatus:'confirmed',productionStatus:'printed'},'in_progress'],['delivering',{paymentStatus:'confirmed',productionStatus:'printed',deliveryStatus:'delivering'},'in_progress'],['delivery_failed',{paymentStatus:'confirmed',productionStatus:'printed',deliveryStatus:'failed'},'paused'],
    ['cancel_requested',{paymentStatus:'confirmed',lifecycle:'cancel_requested'},'paused'],['cancelled',{lifecycle:'cancelled'},'cancelled'],
    ['completed',{paymentStatus:'confirmed',productionStatus:'printed',deliveryStatus:'delivered',lifecycle:'completed'},'completed'],
    ['reprint',{paymentStatus:'confirmed',productionStatus:'printing',deliveryStatus:'delivered',lifecycle:'completed',reprintActive:1},'completed'],
    ['financial',{paymentStatus:'confirmed',financialHold:1},'paused'],['hold',{paymentStatus:'confirmed',fulfillmentHold:1},'paused'],['refund_pending',{paymentStatus:'confirmed'},'paused'],['refunded',{paymentStatus:'confirmed',fulfillmentHold:1},'paused']
  ],orders=[];
  const image=await h.fixture('sample-chinese.png'),fileHash=sha(image),completedAt=new Date(now.getTime()-4*86400000).toISOString(),expiresAt=new Date(Date.parse(completedAt)+7*86400000).toISOString();
  const sourceRows={},oldColumns={};let ticketId;
  try{
    for(const migration of ['102-guest-access.sql','103-pricing-coupons.sql','104-merchant-service.sql']){const sql=await fs.readFile(path.join(PROJECT,'backend/migrations',migration),'utf8');raw.exec(sql);raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration,sha(sql),now.toISOString());}
    // Remove the initial fixture to construct all historical states at this real schema level.
    // Both operations occur only in this UUID test database before migration.
    raw.prepare('DELETE FROM print_orders WHERE id=?').run(legacy.orderId);raw.prepare('DELETE FROM print_quotes WHERE id=?').run(legacy.quoteId);
    for(const [label,changes,stage] of states){
      const id=randomUUID(),quoteId=randomUUID(),fileId=randomUUID(),items=JSON.parse(legacy.itemsJson).map(item=>({...item,fileId,sourceSha256:fileHash})),address={...JSON.parse(legacy.addressJson),notes:'历史自由文字接收说明-'+label};
      raw.prepare("INSERT INTO print_quotes(id,userId,status,itemsJson,totalsJson,createdAt,preparationDeadline,readyAt,expiresAt,fingerprint,claimedOrderId) VALUES(?,?,'ready',?,?,?,?,?,?,?,?)").run(quoteId,legacy.users.student.id,JSON.stringify(items),legacy.totalsJson,legacy.createdAt,expiresAt,legacy.createdAt,expiresAt,'c'.repeat(64),id);
      raw.prepare('INSERT INTO print_orders(id,orderNo,userId,quoteId,createdAt,updatedAt,itemsJson,totalsJson,addressJson,totalAmountFen,contentPages,sheetCount) VALUES(?,?,?,?,?,?,?,?,?,1300,52,26)').run(id,'CP-OLD-'+label,legacy.users.student.id,quoteId,legacy.createdAt,legacy.createdAt,JSON.stringify(items),legacy.totalsJson,JSON.stringify(address));
      const patch={...changes,...(changes.lifecycle==='completed'?{completedAt,filesExpireAt:expiresAt}:{})};raw.prepare('UPDATE print_orders SET '+Object.keys(patch).map(k=>k+'=?').join(',')+' WHERE id=?').run(...Object.values(patch),id);
      if(changes.paymentStatus==='confirmed')raw.prepare('INSERT INTO payment_receipts(id,orderId,amountFen,channel,reference,referenceKey,confirmedAt,confirmedBy,note) VALUES(?,?,1300,?,?,?,?,?,?)').run(randomUUID(),id,'wechat','OLD-'+label,'old-'+label,legacy.createdAt,legacy.users.admin.id,'历史实收说明');
      if(label==='refund_pending'||label==='refunded')raw.prepare('INSERT INTO order_refunds(id,orderId,status,amountFen,reason,createdAt,createdBy,fulfillmentDecision,paidAt,paidBy,payoutReference,payoutReferenceKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,label==='refunded'?'paid_out':'requested',label==='refunded'?1300:50,'旧退款文字原因',legacy.createdAt,legacy.users.admin.id,'stop',label==='refunded'?legacy.createdAt:null,label==='refunded'?legacy.users.admin.id:null,label==='refunded'?'OLD-REFUND':null,label==='refunded'?'old-refund':null);
      raw.prepare("INSERT INTO files(id,ownerId,originalName,mimeType,byteSize,sourceSha256,sourcePageCount,status,claimedOrderId,expiresAt,uploadedAt,temporaryExpiresAt) VALUES(?,?,?,'image/png',?,?,52,'ready',?,?,?,?)").run(fileId,legacy.users.student.id,'historical.png',image.length,fileHash,id,changes.lifecycle==='completed'?expiresAt:null,legacy.createdAt,expiresAt);
      await fs.mkdir(path.join(config.fileRoot,fileId),{recursive:true});await fs.writeFile(path.join(config.fileRoot,fileId,'original.bin'),image);
      raw.prepare('INSERT INTO order_events(id,orderId,actorId,type,createdAt,dataJson) VALUES(?,?,?,?,?,?)').run(randomUUID(),id,legacy.users.admin.id,'historical_fact',legacy.createdAt,JSON.stringify({reason:'原有自由文字原因-'+label}));orders.push({id,label,stage});
    }
    ticketId=randomUUID();raw.prepare("INSERT INTO order_tickets(id,orderId,userId,subject,status,createdAt,updatedAt,feedbackType,contactType,contactValue) VALUES(?,?,?,?,'in_progress',?,?,'delivery','wechat','OLD_PRIVATE_CONTACT')").run(ticketId,orders[0].id,legacy.users.student.id,'原售后主题',legacy.createdAt,legacy.createdAt);raw.prepare("INSERT INTO ticket_updates(id,ticketId,authorId,message,status,createdAt) VALUES(?,?,?,?,'in_progress',?)").run(randomUUID(),ticketId,legacy.users.admin.id,'历史回复保持',legacy.createdAt);
    for(const {name:table} of raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
      oldColumns[table]=raw.prepare(`PRAGMA table_info("${table}")`).all().map(c=>'"'+c.name+'"').join(',');sourceRows[table]=raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    }
    assert.equal(raw.prepare('SELECT count(*) n FROM schema_migrations').get().n,8);
  }finally{raw.close();}
  runtime=await startServer(config);const admin=new Client(runtime,{surface:'admin'});admin.cookie='cp_session='+legacy.sessions.admin.token;admin.csrf=legacy.sessions.admin.csrf;
  await t.test('真实8→10迁移且旧列逐行保持；新字段不猜测时间或原因',async()=>{
    assert.equal(runtime.db.get('SELECT count(*) n FROM schema_migrations').n,10);
    for(const [table,rows] of Object.entries(sourceRows))if(!['schema_migrations','sessions','file_cleanup_runs','order_query_codes'].includes(table))assert.deepEqual(runtime.db.all(`SELECT ${oldColumns[table]} FROM "${table}" ORDER BY rowid`),rows,table);
    for(const o of orders){const row=runtime.db.get('SELECT * FROM print_orders WHERE id=?',o.id);assert.equal(row.acceptedAt,null);assert.equal(row.workflowHold,0);assert.equal(row.workflowHoldReasonCode,null);}
    assert.equal(runtime.db.get('PRAGMA integrity_check').integrity_check,'ok');assert.deepEqual(runtime.db.all('PRAGMA foreign_key_check'),[]);
  });
  await t.test('全部旧状态得到统一摘要与安全动作；原历史说明及完成期限仍可查',async()=>{
    for(const o of orders){const dto=h.data(await admin.request('GET',`/api/admin/orders/${o.id}`));assert.equal(dto.fulfillment.stage,o.stage,o.label);assert.equal(dto.fulfillment.acceptedAt,null);assert.equal(dto.deliveryAddress.notes,'历史自由文字接收说明-'+o.label);assert(!Object.hasOwn(dto.deliveryAddress,'receiptMethod'));assert.equal(dto.events[0].data.reason,'原有自由文字原因-'+o.label);
      if(o.stage==='in_progress')assert(dto.allowedActions.includes('confirm_delivered'),o.label);if(o.stage==='paused')assert(!dto.allowedActions.includes('confirm_delivered'),o.label);if(o.stage==='completed'){assert.equal(dto.completedAt,completedAt);assert.equal(dto.filesExpireAt,expiresAt);}
    }
    const ticket=h.data(await admin.request('GET','/api/admin/tickets/'+ticketId));assert.equal(ticket.category,'order');assert.equal(ticket.contactValue,'OLD_PRIVATE_CONTACT');assert.equal(ticket.updates[0].message,'历史回复保持');
    const guest=new Client(runtime);await guest.guest();const query=h.data(await admin.request('GET',`/api/admin/orders/${orders[0].id}/query-code`)).queryCode;h.data(await guest.request('POST','/api/orders/recover',{queryCode:query}));const recovered=h.data(await guest.request('GET','/api/me/tickets/'+ticketId));assert(!Object.hasOwn(recovered,'contactValue'));assert(!Object.hasOwn(recovered,'userId'));assert.equal((await guest.request('GET',`/api/me/orders/${orders[1].id}`)).status,404);
  });
  await t.test('旧已核款单可直接合并送达，保留打印状态；旧失败必须处理再送达',async()=>{
    const paid=orders.find(o=>o.label==='paid'),before=h.data(await admin.request('GET',`/api/admin/orders/${paid.id}`)),delivered=await h.action(admin,before,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});assert.equal(delivered.production.status,'not_started');assert.equal(delivered.fulfillment.acceptedAt,null);assert.equal(delivered.completedAt,now.toISOString());
    const failed=orders.find(o=>o.label==='delivery_failed');let value=h.data(await admin.request('GET',`/api/admin/orders/${failed.id}`));assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/delivery-action`,{expectedVersion:value.version,action:'delivered',actualDeliveryConfirmed:true})).status,409);value=await h.action(admin,value,'fulfillment-action',{action:'resume',pauseCode:'delivery_failed',reasonCode:'issue_resolved'});assert.equal(value.fulfillment.stage,'in_progress');value=await h.action(admin,value,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});assert.equal(value.lifecycle,'completed');
  });
  await m.evidence('workflow-upgrade',{fromMigrations:8,toMigrations:10,oldColumnsPreserved:true,states:orders.map(({label,stage})=>({label,stage})),oldAmountsFen:[1300],historicalTimesAndTextPreserved:true,oldTicketAndReplyPreserved:true,queryCodeScopePreserved:true,integrity:'ok',foreignKeyErrors:0,realDatabaseMigrated:false});
});
