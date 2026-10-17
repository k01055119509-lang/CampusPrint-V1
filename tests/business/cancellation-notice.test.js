'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {isolated,Client}=require('../helpers/runtime'),h=require('./helpers'),c=require('./coupon-helpers');
const {discountFor}=require('../../backend/coupons/service'),{COMPENSATION_POLICY}=require('../../backend/orders/cancellation');
const detail=async(client,o)=>h.data(await client.request('GET','/api/me/orders/'+o.id));
const cancel=(client,o,extra={},headers=h.key())=>h.post(client,'/api/me/orders/'+o.id+'/cancel-requests',{expectedVersion:o.version,...extra},headers);
const merchant=(admin,o,extra={},headers=h.key())=>h.post(admin,'/api/admin/orders/'+o.id+'/cancel-resolution',{expectedVersion:o.version,action:'cancel',reasonCode:'cannot_print',...extra},headers);
function counts(runtime){return Object.fromEntries(['print_orders','payment_receipts','financial_exceptions','coupons','coupon_batches','coupon_events','order_compensations','cancellation_requests','order_events','business_idempotency','order_coupon_exceptions'].map(n=>[n,runtime.db.get('SELECT count(*) n FROM '+n).n]));}
const currentVersion=(runtime,o)=>runtime.db.get('SELECT version FROM print_orders WHERE id=?',o.id).version;

test('1.4.0 公告和接收默认：独立版本、纯文本、权限、局部更新及订单快照',{timeout:120000},async t=>{
  const runtime=await isolated({rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());
  const anonymous=new Client(runtime),before=runtime.db.get('SELECT count(*) n FROM users').n;
  await t.test('公开公告未发布为空，不创建身份或会话；匿名管理及学生越权拒绝',async()=>{
    const sessions=runtime.db.get('SELECT count(*) n FROM sessions').n,response=await anonymous.request('GET','/api/public/announcement');
    assert.deepEqual(h.data(response),{enabled:false,content:'',version:1,updatedAt:null});assert.equal(response.headers.get('set-cookie'),null);assert.equal(runtime.db.get('SELECT count(*) n FROM users').n,before);assert.equal(runtime.db.get('SELECT count(*) n FROM sessions').n,sessions);assert.equal((await anonymous.forSurface('admin').request('GET','/api/admin/announcement')).status,401);
  });
  const {user,admin}=await h.actors(runtime);
  await t.test('管理草稿、发布/停用、换行及HTML原样纯文本；不覆盖营业收款设置',async()=>{
    const settings=runtime.db.get('SELECT * FROM print_settings WHERE id=1'),content='<script>plain text</script>\n第二行';
    const saved=h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:1,content}));assert.equal(saved.enabled,false);assert.equal(h.data(await anonymous.request('GET','/api/public/announcement')).content,'');
    const published=h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:2,enabled:true}));assert.equal(published.content,content);assert.equal(h.data(await anonymous.request('GET','/api/public/announcement')).content,content);
    const disabled=h.data(await admin.request('PATCH','/api/admin/announcement',{expectedVersion:3,enabled:false}));assert.equal(disabled.content,content);assert.equal(h.data(await anonymous.request('GET','/api/public/announcement')).content,'');assert.deepEqual(runtime.db.get('SELECT * FROM print_settings WHERE id=1'),settings);
  });
  await t.test('公告版本并发、CSRF/白名单/空内容/1000字符边界',async()=>{
    assert.equal((await user.request('GET','/api/admin/announcement')).status,403);
    assert.equal((await admin.request('PATCH','/api/admin/announcement',{expectedVersion:4,enabled:true},{headers:{'X-CSRF-Token':'invalid'}})).status,403);
    for(const input of [{expectedVersion:4,enabled:true,content:'  '},{expectedVersion:4,content:'x'.repeat(1001)},{expectedVersion:4,content:null},{expectedVersion:4,serviceNotice:'forged'},{expectedVersion:4}])assert.equal((await admin.request('PATCH','/api/admin/announcement',input)).status,400);
    const raced=await Promise.all([admin.request('PATCH','/api/admin/announcement',{expectedVersion:4,content:'x'.repeat(1000)}),admin.request('PATCH','/api/admin/announcement',{expectedVersion:4,content:'another'})]);assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);assert.equal(h.data(await admin.request('GET','/api/admin/announcement')).version,5);
  });
  await t.test('默认方式可空、四枚举和条件校验；旧notes兼容且省略不清新字段',async()=>{
    assert.equal(h.data(await user.request('GET','/api/me/print-defaults')).receiptMethod,null);
    const legacy=h.data(await user.request('PATCH','/api/me/print-defaults',{notes:'原有接收原文'}));assert.equal(legacy.receiptMethod,null);
    for(const input of [{receiptMethod:'contact_first',contact:''},{receiptMethod:'other',receiptNote:''},{receiptMethod:'invalid'},{receiptNote:'x'.repeat(501)}])assert.equal((await user.request('PATCH','/api/me/print-defaults',input)).status,400);
    for(const method of ['handover','contact_first','doorstep','other']){const saved=h.data(await user.request('PATCH','/api/me/print-defaults',{receiptMethod:method,receiptNote:method==='other'?'选择的补充':'',contact:'isolated-contact',room:'room-test'}));assert.equal(saved.receiptMethod,method);}
    const patched=h.data(await user.request('PATCH','/api/me/print-defaults',{copies:2}));assert.equal(patched.receiptMethod,'other');assert.equal(patched.receiptNote,'选择的补充');assert.equal(patched.notes,'原有接收原文');assert.deepEqual(h.data(await user.request('GET','/api/me/print-defaults')),patched);
    const file=await h.upload(runtime,user),q=await h.quote(runtime,user,file),body=h.orderBody(q,{deliveryAddress:{...patched,buildingId:'local-dorm'}});delete body.deliveryAddress.copies;delete body.deliveryAddress.duplex;delete body.deliveryAddress.updatedAt;
    const order=h.data(await h.post(user,'/api/orders',body),201);assert.equal(order.deliveryAddress.receiptMethod,'other');assert.equal(order.deliveryAddress.receiptNote,'选择的补充');
    h.data(await user.request('PATCH','/api/me/print-defaults',{receiptMethod:null,receiptNote:''}));const latest=await detail(user,order);assert.equal(latest.deliveryAddress.receiptMethod,'other');assert.equal(latest.version,order.version);
    const nextQ=await h.quote(runtime,user,await h.upload(runtime,user));const missing=h.orderBody(nextQ);delete missing.deliveryAddress.receiptMethod;assert.equal((await h.post(user,'/api/orders',missing)).status,400);
  });
});

test('1.4.0 两种用户取消、原券同码退回、商户隐藏及核款退回最小投影',{timeout:120000},async t=>{
  const fixed=new Date();const runtime=await isolated({clock:()=>new Date(fixed),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);h.data(await h.paymentQr(admin));
  await t.test('未声明直接取消原子退券、学生可查；商户列表/搜索/统计/详情隐藏，售后仍可关联',async()=>{
    const issued=await c.issued(admin);let value=await c.order(runtime,user,issued.code);const expiry=runtime.context.orders.coupons.row(issued.coupon.id).expiresAt,body={expectedVersion:value.version},headers=h.key();
    assert.equal(value.cancellation.requestMode,'direct');assert.equal(value.cancellation.receiptRecorded,false);
    const first=await cancel(user,value,{},headers);value=h.data(first);assert.equal(value.lifecycle,'cancelled');assert.equal(value.cancellation.hiddenFromMerchant,true);assert.equal(value.cancellation.origin,'user');assert.equal(value.cancellationRequests.at(-1).resolvedBy,user.user.id);assert(!value.events.some(e=>e.data.noReceiptConfirmed===true));
    assert.deepEqual((await h.post(user,'/api/me/orders/'+value.id+'/cancel-requests',body,headers)).body,first.body);
    const coupon=runtime.context.orders.coupons.row(issued.coupon.id);assert.equal(coupon.state,'available');assert.equal(coupon.reservedOrderId,null);assert.equal(coupon.expiresAt,expiry);assert.equal(coupon.code===issued.code,true);
    assert.equal(h.data(await user.request('GET','/api/me/orders')).total,1);for(const query of ['', '?status=cancelled','?q='+value.orderNo,'?fulfillmentStage=cancelled'])assert.equal(h.data(await admin.request('GET','/api/admin/orders'+query)).total,0);
    const dashboard=h.data(await admin.request('GET','/api/admin/dashboard'));assert.equal(dashboard.totalOrders,0);assert.equal(dashboard.fulfillmentCounts.cancelled,0);assert.equal((await admin.request('GET','/api/admin/orders/'+value.id)).body.error.code,'ORDER_HIDDEN_FROM_MERCHANT');
    const ticket=h.data(await h.post(user,'/api/me/orders/'+value.id+'/tickets',{subject:'取消后售后',message:'保留关联'}),201);assert.equal(h.data(await admin.request('GET','/api/admin/tickets/'+ticket.id)).orderId,value.id);
    const reused=await c.order(runtime,other,issued.code);assert.equal(c.row(runtime,issued.coupon).reservedOrderId,reused.id);assert.equal(value.totals.totalAmountFen,40);
  });
  await t.test('伪造来源/隐藏/补偿字段拒绝；恢复授权和他人无直接取消或完整码权限',async()=>{
    const value=await h.order(runtime,user),old=counts(runtime);
    for(const extra of [{origin:'merchant'},{hiddenFromMerchant:true},{compensate:true}])assert.equal((await cancel(user,value,extra)).status,400);assert.deepEqual(counts(runtime),old);
    assert.equal((await cancel(other,value)).status,404);const code=h.data(await user.request('GET','/api/me/orders/'+value.id+'/query-code')).queryCode;h.data(await other.request('POST','/api/orders/recover',{queryCode:code}));assert.equal((await cancel(other,value)).status,403);assert.equal((await other.request('GET','/api/me/orders/'+value.id+'/query-code')).status,403);assert.equal((await other.request('GET','/api/me/orders/'+value.id+'/compensation-code')).status,403);
  });
  await t.test('三项退回原因与重新声明；曾声明含rejected仍需审核，拒绝不退券、同意自动释放',async()=>{
    const issued=await c.issued(admin);let value=await c.order(runtime,user,issued.code);
    value=h.data(await h.post(user,'/api/me/orders/'+value.id+'/payment-submissions',{expectedVersion:value.version,channel:'other'}));
    const queryCode=h.data(await user.request('GET','/api/me/orders/'+value.id+'/query-code')).queryCode;h.data(await other.request('POST','/api/orders/recover',{queryCode}));
    for(const code of ['not_received','amount_mismatch','channel_mismatch']){value=await h.action(admin,value,'payment-review',{action:'reject',reasonCode:code});assert.equal(value.payment.returnReason.code,code);const restored=await detail(other,value);assert.deepEqual(restored.payment.returnReason,value.payment.returnReason);assert(!Object.hasOwn(restored.payment,'receipt'));assert(!Object.hasOwn(restored.payment,'exceptions'));}
    for(const input of [{reasonCode:'other'},{reasonCode:'not_received',reasonText:'internal'},{note:'legacy reason'}])assert.equal((await h.post(admin,'/api/admin/orders/'+value.id+'/payment-review',{expectedVersion:value.version,action:'reject',...input})).status,400);
    value=await detail(user,value);assert.equal(value.cancellation.requestMode,'review');value=h.data(await cancel(user,value));assert.equal(value.lifecycle,'cancel_requested');assert.equal(value.cancellation.hiddenFromMerchant,false);assert.equal(c.row(runtime,issued.coupon).state,'reserved');
    assert.equal((await h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',{expectedVersion:value.version,action:'approve',compensate:true})).status,400);
    value=await h.action(admin,value,'cancel-resolution',{action:'reject'});assert.equal(value.lifecycle,'active');assert.equal(c.row(runtime,issued.coupon).state,'reserved');
    value=h.data(await h.post(user,'/api/me/orders/'+value.id+'/payment-submissions',{expectedVersion:value.version,channel:'other'}));assert.equal(value.payment.returnReason,null);value=h.data(await cancel(user,value));value=await h.action(admin,value,'cancel-resolution',{action:'approve'});assert.equal(value.lifecycle,'cancelled');assert.equal(value.cancellation.hiddenFromMerchant,false);assert.equal(c.row(runtime,issued.coupon).state,'available');assert.equal((await admin.request('GET','/api/admin/orders/'+value.id)).status,200);
  });
  await t.test('到期及停用原券释放不复活、不续期，也不留下退券待办',async()=>{
    for(const mode of ['expired','disabled']){const issued=await c.issued(admin,mode==='expired'?{expiresAt:new Date(runtime.config.clock().getTime()+1000).toISOString()}:{});let value=await c.order(runtime,user,issued.code);const coupon=runtime.context.orders.coupons.row(issued.coupon.id),expiry=coupon.expiresAt;
      if(mode==='disabled')h.data(await h.post(admin,'/api/admin/coupons/'+coupon.id+'/disable',{expectedVersion:coupon.version,reasonCode:'campaign_ended'}));
      else {const clock=runtime.config.clock;runtime.config.clock=()=>new Date(expiry);runtime.context.orders.coupons.scan();value=await detail(user,value);value=h.data(await cancel(user,value));assert.equal(runtime.context.orders.coupons.row(coupon.id).expiresAt,expiry);assert.throws(()=>runtime.context.orders.coupons.preview(issued.code,50),e=>e.code==='COUPON_UNAVAILABLE');runtime.config.clock=clock;continue;}
      value=await detail(user,value);value=h.data(await cancel(user,value));assert.equal(value.couponException.hold,false);assert.equal(c.row(runtime,issued.coupon).state,'available');assert(c.row(runtime,issued.coupon).disabledAt);assert.equal(runtime.context.orders.coupons.row(coupon.id).expiresAt,expiry);assert.throws(()=>runtime.context.orders.coupons.preview(issued.code,50),e=>e.code==='COUPON_UNAVAILABLE');
    }
  });
});

test('1.4.0 商家取消补偿、原子回滚及完整码最小权限',{timeout:120000},async t=>{
  let now=new Date();const runtime=await isolated({clock:()=>new Date(now),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);h.data(await h.paymentQr(admin));
  await t.test('固定预设只读、舍入/封顶/无门槛及普通券7天保持',async()=>{
    assert.deepEqual(h.data(await admin.request('GET','/api/admin/compensation-policy')),COMPENSATION_POLICY);assert.equal((await user.request('GET','/api/admin/compensation-policy')).status,403);assert.equal((await admin.request('PATCH','/api/admin/compensation-policy',{validDays:1})).status,404);
    for(const [amount,discount]of [[1,0],[5,0],[15,1],[25,2],[2000,200],[2001,200],[4950,200]])assert.equal(discountFor(COMPENSATION_POLICY,amount),discount);assert.throws(()=>discountFor(COMPENSATION_POLICY,0));
    const regular=await c.issued(admin);assert.equal(Date.parse(regular.batch.expiresAt)-now.getTime(),7*86400000);
  });
  await t.test('商家默认不发、可选发独立补偿；不同键并发最多一张，幂等不重复',async()=>{
    let no=await h.order(runtime,user);no=h.data(await merchant(admin,no));assert.equal(no.lifecycle,'cancelled');assert.equal(no.compensation,null);assert.equal(no.cancellation.hiddenFromMerchant,false);
    const issued=await c.issued(admin);let value=await c.order(runtime,user,issued.code);const body={expectedVersion:value.version,action:'cancel',reasonCode:'merchant_unavailable',compensate:true},headers=h.key();
    const results=await Promise.all([h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',body,headers),h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',body)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);const first=results.find(x=>x.status===200);value=h.data(first);assert.equal(value.cancellation.origin,'merchant');assert.equal(value.lifecycle,'cancelled');assert.equal(value.compensation.payRatePercent,90);assert.equal(value.compensation.maxDiscountFen,200);assert.equal(value.compensation.minPrintAmountFen,0);assert.equal(Date.parse(value.compensation.expiresAt)-Date.parse(value.compensation.issuedAt),30*86400000);assert.equal(c.row(runtime,issued.coupon).state,'available');assert.equal(runtime.db.get('SELECT count(*) n FROM order_compensations WHERE orderId=?',value.id).n,1);
    assert.deepEqual((await h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',body,headers)).body,first.body);const original=runtime.context.orders.coupons.row(issued.coupon.id),comp=runtime.context.orders.coupons.row(value.compensation.couponId);assert.notEqual(original.id,comp.id);assert.equal(original.code===comp.code,false);assert(!JSON.stringify(value).includes(comp.code));assert.equal((await merchant(admin,value,{compensate:true})).status,409);
    const owner=await detail(user,value);assert(owner.compensation.canViewCode);assert(owner.allowedActions.includes('view_compensation_code'));const reveal=h.data(await user.request('GET','/api/me/orders/'+value.id+'/compensation-code'));assert.equal(reveal.code===comp.code,true);assert.equal(reveal.code.length,25);assert.equal((await other.request('GET','/api/me/orders/'+value.id+'/compensation-code')).status,404);
    const queryCode=h.data(await user.request('GET','/api/me/orders/'+value.id+'/query-code')).queryCode;const restored=h.data(await other.request('POST','/api/orders/recover',{queryCode}));assert.equal(restored.compensation.canViewCode,false);assert(!Object.hasOwn(restored.compensation,'code'));assert.equal((await other.request('GET','/api/me/orders/'+value.id+'/compensation-code')).status,403);
    const next=await c.order(runtime,user,comp.code);await h.confirm(admin,next);const redeemed=h.data(await user.request('GET','/api/me/orders/'+value.id+'/compensation-code'));assert.equal(redeemed.code,null);assert.equal(redeemed.unavailableReason,'redeemed');assert.equal((await detail(user,value)).compensation.canViewCode,false);
  });
  await t.test('取消、释放、发券、事件任一步故障全部回滚，原键可重试',async()=>{
    const issued=await c.issued(admin);const value=await c.order(runtime,user,issued.code),before=counts(runtime),body={expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print',compensate:true},headers=h.key();
    runtime.db.raw.exec("CREATE TRIGGER test_cancel_event_failure BEFORE INSERT ON order_events WHEN NEW.type='merchant_cancelled' BEGIN SELECT RAISE(ABORT,'TEST_CANCEL_EVENT_FAILURE'); END");
    assert.equal((await h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',body,headers)).status,500);assert.deepEqual(counts(runtime),before);assert.equal(c.row(runtime,issued.coupon).state,'reserved');assert.equal(currentVersion(runtime,value),value.version);
    runtime.db.raw.exec('DROP TRIGGER test_cancel_event_failure');const completed=h.data(await h.post(admin,'/api/admin/orders/'+value.id+'/cancel-resolution',body,headers));assert.equal(completed.lifecycle,'cancelled');assert(completed.compensation);
    const another=await c.issued(admin);const direct=await c.order(runtime,user,another.code),baseline=counts(runtime);
    runtime.db.raw.exec("CREATE TRIGGER test_release_failure BEFORE INSERT ON coupon_events WHEN NEW.type='released_user_cancellation' BEGIN SELECT RAISE(ABORT,'TEST_RELEASE_FAILURE'); END");assert.equal((await cancel(user,direct)).status,500);assert.deepEqual(counts(runtime),baseline);assert.equal(currentVersion(runtime,direct),direct.version);assert.equal(c.row(runtime,another.coupon).state,'reserved');runtime.db.raw.exec('DROP TRIGGER test_release_failure');
  });
  await t.test('补偿恰在30天到期，停用/到期状态与码权限独立',async()=>{
    const value=h.data(await merchant(admin,await h.order(runtime,user),{compensate:true})),coupon=runtime.context.orders.coupons.row(value.compensation.couponId);now=new Date(Date.parse(coupon.expiresAt)-1);assert.equal(runtime.context.orders.cancellation.compensation(runtime.context.orders.owned(admin.user,value.id),user.user,'owner').isExpired,false);runtime.context.orders.coupons.preview(coupon.code,50);
    now=new Date(coupon.expiresAt);assert.equal(runtime.context.orders.cancellation.compensation(runtime.context.orders.owned(admin.user,value.id),user.user,'owner').isExpired,true);assert.throws(()=>runtime.context.orders.coupons.preview(coupon.code,50),e=>e.code==='COUPON_UNAVAILABLE');
    // Boundary inspection uses the service directly; expired visitor credentials are not extended.
    now=new Date(Date.parse(coupon.createdAt));h.data(await h.post(admin,'/api/admin/coupons/'+coupon.id+'/disable',{expectedVersion:coupon.version,reasonCode:'issued_in_error'}));assert.equal((await detail(user,value)).compensation.disabled,true);
  });
});

test('1.4.0 收款禁取消、删除财务创建、旧异常及并发不变量',{timeout:180000},async t=>{
  const fixed=new Date();const runtime=await isolated({clock:()=>new Date(fixed),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);h.data(await h.paymentQr(admin));
  await t.test('flag_exception 即使券已到期也无业务写入/版本变动；金额不符不创建财务锁',async()=>{
    const issued=await c.issued(admin,{expiresAt:new Date(runtime.config.clock().getTime()+1000).toISOString()});let value=await c.order(runtime,user,issued.code),before=counts(runtime),clock=runtime.config.clock;runtime.config.clock=()=>new Date(issued.coupon.expiresAt);
    const response=await h.post(admin,'/api/admin/orders/'+value.id+'/payment-review',{expectedVersion:value.version,action:'flag_exception',amountFen:0,reference:'REMOVED',channel:'other',note:'removed'});assert.equal(response.status,410);assert.equal(response.body.error.code,'FINANCIAL_EXCEPTION_RECORDING_REMOVED');assert.deepEqual(counts(runtime),before);assert.equal(currentVersion(runtime,value),value.version);runtime.config.clock=clock;
    const mismatch=await h.post(admin,'/api/admin/orders/'+value.id+'/payment-review',{expectedVersion:value.version,action:'confirm',amountFen:value.totals.totalAmountFen+1,reference:'MISMATCH',channel:'other'});assert.equal(mismatch.body.error.code,'PAYMENT_AMOUNT_MISMATCH');assert.deepEqual(counts(runtime),before);assert.equal(currentVersion(runtime,value),value.version);value=await detail(user,value);assert.equal(value.payment.financialHold,false);assert.equal(value.payment.status,'unpaid');
  });
  await t.test('旧财务异常有逐单处理路径，不能用未到账抹掉真实收款；学生无真实凭据',async()=>{
    let value=h.legacyFinancial(runtime,await h.order(runtime,user));assert.equal((await cancel(user,value)).body.error.code,'ORDER_CANCELLATION_BLOCKED');value=await h.action(admin,value,'payment-review',{action:'resolve_exception',resolutionOutcome:'no_receipt',reasonCode:'no_receipt'});assert.equal(value.payment.financialHold,false);assert.equal(value.payment.receipt,null);
    value=h.legacyFinancial(runtime,value);value=await h.confirm(admin,value,{reference:'INTERNAL-REAL-REFERENCE',note:'INTERNAL-MERCHANT-NOTE'});assert.equal(value.payment.financialHold,true);assert.equal((await h.post(admin,'/api/admin/orders/'+value.id+'/payment-review',{expectedVersion:value.version,action:'resolve_exception',resolutionOutcome:'no_receipt',reasonCode:'no_receipt'})).status,409);
    value=await h.action(admin,value,'payment-review',{action:'resolve_exception',resolutionOutcome:'exact_receipt',reasonCode:'exact_receipt'});assert.equal(value.payment.financialHold,false);const owner=await detail(user,value);assert(!JSON.stringify(owner).includes('INTERNAL-REAL-REFERENCE'));assert(!JSON.stringify(owner).includes('INTERNAL-MERCHANT-NOTE'));assert(!JSON.stringify(owner).includes('LEGACY-PRIVATE-REFERENCE'));assert.equal(owner.payment.receipt.amountFen,value.totals.totalAmountFen);
  });
  await t.test('存在receipt而旧paymentStatus异常、全额退款、旧merchant request/settlement都不能取消',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user));runtime.db.run("UPDATE print_orders SET paymentStatus='unpaid' WHERE id=?",value.id);value=await detail(user,value);assert(value.cancellation.receiptRecorded);assert.equal(value.cancellation.requestMode,'unavailable');assert(!value.allowedActions.includes('request_cancel'));assert.equal((await cancel(user,value)).body.error.code,'ORDER_CANCELLATION_BLOCKED');assert.equal((await merchant(admin,value)).body.error.code,'ORDER_CANCELLATION_BLOCKED');assert.equal((await merchant(admin,value,{action:'request'})).body.error.code,'MERCHANT_CANCEL_REQUEST_REMOVED');
    runtime.db.run("UPDATE print_orders SET paymentStatus='confirmed' WHERE id=?",value.id);value=await c.get(admin,value);value=await h.action(admin,value,'refunds',{action:'request',amountFen:value.totals.totalAmountFen,reasonCode:'user_cancelled'});const refundId=value.refunds.at(-1).id;value=await h.action(admin,value,'refunds',{action:'approve',refundId,reasonCode:'verified_request',fulfillmentDecision:'stop'});value=await h.action(admin,value,'refunds',{action:'paid_out',refundId,reasonCode:'refund_completed',fulfillmentDecision:'stop',payoutReference:'REFUNDED-'+randomUUID(),actualRefundConfirmed:true});assert.equal(value.netReceivedFen,0);assert.equal((await merchant(admin,value,{compensate:true})).body.error.code,'ORDER_CANCELLATION_BLOCKED');assert.equal(value.compensation,null);
  });
  await t.test('收款与直接取消竞争仅一方成功；声明竞争后历史决定审核；双取消与停用不会半释放',async()=>{
    const issued=await c.issued(admin);const value=await c.order(runtime,user,issued.code),receipt={expectedVersion:value.version,action:'confirm',amountFen:value.totals.totalAmountFen,channel:'other',reference:'RACE-'+randomUUID()};
    const result=await Promise.all([cancel(user,value),h.post(admin,'/api/admin/orders/'+value.id+'/payment-review',receipt)]);assert.equal(result.filter(x=>x.status===200).length,1);const row=runtime.db.get('SELECT * FROM print_orders WHERE id=?',value.id),hasReceipt=!!runtime.context.orders.receipt(value.id);assert.equal(row.lifecycle==='cancelled',!hasReceipt);assert.equal(c.row(runtime,issued.coupon).state,hasReceipt?'redeemed':'available');assert.equal(!!row.hiddenFromMerchant,!hasReceipt);
    let pending=await h.order(runtime,user);const raced=await Promise.all([cancel(user,pending),h.post(user,'/api/me/orders/'+pending.id+'/payment-submissions',{expectedVersion:pending.version,channel:'other'})]);assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);pending=await detail(user,pending);if(pending.lifecycle==='active'){assert.equal(pending.cancellation.requestMode,'review');pending=h.data(await cancel(user,pending));assert.equal(pending.lifecycle,'cancel_requested');}else assert.equal(pending.cancellation.hasPaymentDeclaration,false);
    const twin=await h.order(runtime,user),twins=await Promise.all([cancel(user,twin),cancel(user,twin)]);assert.deepEqual(twins.map(x=>x.status).sort(),[200,409]);assert.equal(runtime.db.get('SELECT count(*) n FROM cancellation_requests WHERE orderId=?',twin.id).n,1);
    const stop=await c.issued(admin);const target=await c.order(runtime,user,stop.code);const stopped=await Promise.all([cancel(user,target),h.post(admin,'/api/admin/coupons/'+stop.coupon.id+'/disable',{expectedVersion:c.row(runtime,stop.coupon).version,reasonCode:'campaign_ended'})]);assert.equal(stopped.filter(x=>x.status===200).length,1);const order=runtime.db.get('SELECT * FROM print_orders WHERE id=?',target.id),coupon=c.row(runtime,stop.coupon);assert.equal(order.lifecycle==='cancelled',coupon.state==='available');if(coupon.disabledAt)assert.throws(()=>runtime.context.orders.coupons.preview(stop.code,50),e=>e.code==='COUPON_UNAVAILABLE');
  });
});

test('1.4.0 保留旧账号模式的结构化默认信息',{timeout:30000},async t=>{
  const runtime=await isolated({studentAccountsEnabled:true});t.after(()=>runtime.destroy());const client=new Client(runtime);await client.register();const saved=h.data(await client.request('PATCH','/api/me/print-defaults',{receiptMethod:'doorstep',receiptNote:'',notes:'原账户说明'}));assert.equal(saved.receiptMethod,'doorstep');assert.equal(h.data(await client.request('GET','/api/me/print-defaults')).notes,'原账户说明');
});
