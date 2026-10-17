'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {isolated,Client,configAt,TEST_ROOT,removeTestStorage,TEST_PASSWORD}=require('../helpers/runtime');
const {startServer}=require('../../backend/server');
const {loadConfig}=require('../../backend/config');
const {createSnapshot,exportAuthority,restoreSnapshot}=require('../../scripts/deploy/backup');
const h=require('./helpers'),c=require('./coupon-helpers'),m=require('./merchant-helpers');
const route=o=>`/api/admin/orders/${o.id}/fulfillment-action`;
const pause=(admin,o,reasonCode='unreachable')=>h.action(admin,o,'fulfillment-action',{action:'pause',reasonCode});
const resume=(admin,o,pauseCode,extra={})=>h.action(admin,o,'fulfillment-action',{action:'resume',pauseCode,reasonCode:'issue_resolved',...extra});

test('新履约筛选在周期扫描前也捕捉占用券到期，不返回与详情矛盾的阶段',async t=>{
  let now=new Date();const runtime=await isolated({clock:()=>new Date(now)});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime),issued=await c.issued(admin,{expiresAt:new Date(now.getTime()+1000).toISOString()}),order=await c.order(runtime,user,issued.code);
  now=new Date(now.getTime()+1000);
  const filtered=h.data(await admin.request('GET','/api/admin/orders?fulfillmentStage=paused'));assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,order.id);assert.equal(filtered.items[0].fulfillment.stage,'paused');
  assert.equal(h.data(await admin.request('GET','/api/admin/orders?fulfillmentStage=pending_acceptance')).total,0);
  assert.equal(h.data(await admin.request('GET','/api/admin/dashboard')).fulfillmentCounts.paused,1);
});

test('1.3.0 两步真实接口：原子收款接单、并发、幂等、回滚及七天期限',{timeout:120000},async t=>{
  let now=new Date();const runtime=await isolated({clock:()=>new Date(now),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());
  const {user,admin,other}=await h.actors(runtime);h.data(await h.paymentQr(admin));
  let order;
  await t.test('reference 省略可声明，无真实到账、无自动接单；所有者与恢复访问同一摘要',async()=>{
    order=await h.order(runtime,user,{copies:2});
    const code=h.data(await user.request('GET',`/api/me/orders/${order.id}/query-code`)).queryCode;
    const recovered=h.data(await other.request('POST','/api/orders/recover',{queryCode:code}));assert.deepEqual(recovered.fulfillment,{stage:'pending_acceptance',acceptedAt:null,completedAt:null,pauseReasons:[],allowedActions:[]});
    const body={expectedVersion:order.version,channel:'other'},key=h.key();const submitted=await h.post(other,`/api/me/orders/${order.id}/payment-submissions`,body,key);order=h.data(submitted);
    assert.equal(order.payment.status,'submitted');assert.equal(order.payment.confirmedAt,null);assert.equal(order.fulfillment.acceptedAt,null);
    assert.deepEqual((await h.post(other,`/api/me/orders/${order.id}/payment-submissions`,body,key)).body,submitted.body);
    assert.equal(runtime.db.get('SELECT reference FROM payment_submissions WHERE orderId=?',order.id).reference,'');
    order=h.data(await admin.request('GET',`/api/admin/orders/${order.id}`));assert.equal(order.payment.submissions.length,1);
  });
  await t.test('商户 reference 必填；同键并发仅一次实收和一次核销，直接进入制作与配送中',async()=>{
    const body={expectedVersion:order.version,action:'confirm',amountFen:order.totals.totalAmountFen,channel:'other',reference:''};
    assert.equal((await h.post(admin,`/api/admin/orders/${order.id}/payment-review`,body)).status,400);
    body.reference='WORKFLOW-'+randomUUID();const key=h.key(),responses=await Promise.all([h.post(admin,`/api/admin/orders/${order.id}/payment-review`,body,key),h.post(admin,`/api/admin/orders/${order.id}/payment-review`,body,key)]);
    order=h.data(responses[0]);assert.deepEqual(responses[1].body,responses[0].body);
    assert.equal(order.fulfillment.stage,'in_progress');assert.equal(order.fulfillment.acceptedAt,now.toISOString());assert.equal(order.production.status,'not_started');assert.equal(order.delivery.status,'pending');assert.equal(order.completedAt,null);assert.equal(order.filesExpireAt,null);
    assert(order.allowedActions.includes('confirm_delivered'));assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts WHERE orderId=?',order.id).n,1);assert.equal(order.events.filter(e=>e.type.startsWith('production_')).length,0);
    const another=await h.order(runtime,user);assert.equal((await h.post(admin,`/api/admin/orders/${another.id}/payment-review`,{...body,expectedVersion:another.version,amountFen:another.totals.totalAmountFen})).body.error.code,'TRANSACTION_ALREADY_RECORDED');
    assert.equal((await h.post(admin,`/api/admin/orders/${order.id}/payment-review`,{...body,reference:'DIFFERENT'})).body.error.code,'VERSION_CONFLICT');
    assert.equal((await h.post(user,`/api/me/orders/${order.id}/cancel-requests`,{expectedVersion:order.version,reasonCode:'user_cancelled'})).status,409);
  });
  await t.test('旧送达入口及新入口都要求真实交付、付款与暂停；未知结果重读后重试',async()=>{
    assert.equal((await h.post(admin,route(order),{expectedVersion:order.version,action:'delivered'})).status,400);
    assert.equal((await h.post(user,route(order),{expectedVersion:order.version,action:'delivered',actualDeliveryConfirmed:true})).status,403);
    const key=h.key(),body={expectedVersion:order.version,action:'delivered',actualDeliveryConfirmed:true};
    const first=await h.post(admin,route(order),body,key);order=h.data(first);
    assert.equal(order.lifecycle,'completed');assert.equal(order.fulfillment.stage,'completed');assert.equal(order.production.status,'not_started');assert.equal(order.production.completedContentPages,0);assert.equal(order.delivery.status,'delivered');
    assert.equal(Date.parse(order.filesExpireAt)-Date.parse(order.completedAt),7*86400000);
    const originalExpiry=order.filesExpireAt;now=new Date(now.getTime()+1000);
    assert.deepEqual((await h.post(admin,route(order),body,key)).body,first.body);
    assert.equal(h.data(await admin.request('GET',`/api/admin/orders/${order.id}`)).filesExpireAt,originalExpiry);
    assert.equal((await h.post(admin,route(order),{...body,expectedVersion:order.version})).status,409);
    assert.equal(runtime.db.get("SELECT COUNT(*) n FROM order_events WHERE orderId=? AND type='fulfillment_delivered'",order.id).n,1);
    assert(runtime.db.all('SELECT expiresAt FROM files WHERE claimedOrderId=?',order.id).every(r=>r.expiresAt===originalExpiry));
  });
  await t.test('不同幂等键同版本并发送达恰好一项成功',async()=>{
    const paid=await h.confirm(admin,await h.order(runtime,user)),body={expectedVersion:paid.version,action:'delivered',actualDeliveryConfirmed:true};
    const results=await Promise.all([h.post(admin,route(paid),body),h.post(admin,route(paid),body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal(runtime.db.get("SELECT COUNT(*) n FROM order_events WHERE orderId=? AND type='fulfillment_delivered'",paid.id).n,1);
  });
  await t.test('实收事务故障回滚款项、券核销、接单及幂等；同键随后安全完成',async()=>{
    const issued=await c.issued(admin);const value=await c.order(runtime,user,issued.code),key=h.key(),body={expectedVersion:value.version,action:'confirm',amountFen:value.totals.totalAmountFen,channel:'other',reference:'ROLLBACK-'+randomUUID()};
    runtime.db.raw.exec("CREATE TEMP TRIGGER inject_accept BEFORE UPDATE OF acceptedAt ON print_orders WHEN NEW.acceptedAt IS NOT NULL BEGIN SELECT RAISE(ABORT,'test acceptance rollback'); END");
    try{assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,body,key)).status,500);}finally{runtime.db.raw.exec('DROP TRIGGER inject_accept');}
    assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts WHERE orderId=?',value.id).n,0);assert.equal(c.row(runtime,issued.coupon).state,'reserved');assert.equal(runtime.db.get('SELECT acceptedAt FROM print_orders WHERE id=?',value.id).acceptedAt,null);assert.equal(runtime.db.get('SELECT COUNT(*) n FROM business_idempotency WHERE key=?',key['Idempotency-Key']).n,0);
    const result=h.data(await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,body,key));assert.equal(result.fulfillment.stage,'in_progress');assert.equal(c.row(runtime,issued.coupon).state,'redeemed');
  });
  await t.test('送达事务失败回滚文件期限、事件与完成；保留真实第一次成功时间',async()=>{
    const value=await h.confirm(admin,await h.order(runtime,user));const body={expectedVersion:value.version,action:'delivered',actualDeliveryConfirmed:true},key=h.key();
    runtime.db.raw.exec("CREATE TEMP TRIGGER inject_delivery BEFORE UPDATE OF completedAt ON print_orders WHEN NEW.completedAt IS NOT NULL BEGIN SELECT RAISE(ABORT,'test delivery rollback'); END");
    const factsBefore=JSON.stringify([...runtime.files.ledger.facts]);
    try{assert.equal((await h.post(admin,route(value),body,key)).status,500);}finally{runtime.db.raw.exec('DROP TRIGGER inject_delivery');}
    assert.equal(runtime.db.get('SELECT completedAt FROM print_orders WHERE id=?',value.id).completedAt,null);assert.equal(runtime.db.get('SELECT expiresAt FROM files WHERE claimedOrderId=?',value.id).expiresAt,null);assert.equal(JSON.stringify([...runtime.files.ledger.facts]),factsBefore);
    const result=h.data(await h.post(admin,route(value),body,key));assert.equal(result.completedAt,now.toISOString());
  });
  await m.evidence('workflow-normal',{twoNormalActions:true,noFabricatedPrinting:true,receiptConcurrency:true,deliveryConcurrency:true,idempotentLostResponseRetry:true,receiptRollback:true,deliveryRollback:true,realPayment:false,realPrinting:false,realDelivery:false});
});

test('1.3.0 原因表单与独立暂停：实收不解锁、逐项恢复、旧接口无旁路',{timeout:120000},async t=>{
  let now=new Date();const runtime=await isolated({clock:()=>new Date(now),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,admin,other}=await h.actors(runtime);
  await t.test('原因目录必须适用操作；other 必说明；旧自由文本保留且不猜代码',async()=>{
    const catalog=h.data(await admin.request('GET','/api/admin/reason-catalog'));assert(catalog.operations.fulfillment_pause.some(r=>r.code==='unreachable'));assert.equal((await user.request('GET','/api/admin/reason-catalog')).status,403);
    let value=await h.order(runtime,user);
    for(const extra of [{reasonCode:'unreachable'},{reasonCode:'other'},{reasonText:'缺少代码'},{reasonCode:'not_received',reasonText:'x'.repeat(1001)}])assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,{expectedVersion:value.version,action:'reject',...extra})).status,400);
    value=await h.action(admin,value,'payment-review',{action:'reject',reasonCode:'not_received'});assert.equal(value.events.at(-1).data.reasonCode,'not_received');
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,{expectedVersion:value.version,action:'reject',note:'旧客户端补充原因'})).status,400);assert.equal((await c.get(admin,value)).events.at(-1).data.reasonCode,'not_received');
  });
  await t.test('券到期和停用、财务、退款等待及两类履约暂停同时存在，分别解除不互相清理',async()=>{
    const issued=await c.issued(admin,{expiresAt:new Date(now.getTime()+1000).toISOString()});let value=await c.order(runtime,user,issued.code);
    value=h.legacyFinancial(runtime,value);
    runtime.db.run('UPDATE print_orders SET fulfillmentHold=1 WHERE id=?',value.id);
    h.data(await h.post(admin,`/api/admin/coupons/${issued.coupon.id}/disable`,{expectedVersion:c.row(runtime,issued.coupon).version,reasonCode:'campaign_ended'}));now=new Date(now.getTime()+1000);runtime.context.orders.coupons.scan();value=await c.get(admin,value);
    value=await h.confirm(admin,value);assert.equal(value.payment.status,'confirmed');assert.equal(value.fulfillment.stage,'paused');assert.equal(value.fulfillment.acceptedAt,null);assert.deepEqual(value.couponException.reasons,['expired','disabled']);assert.equal(c.row(runtime,issued.coupon).state,'redeemed');
    value=await pause(admin,value);value=await h.action(admin,value,'refunds',{action:'request',amountFen:5,reasonCode:'print_problem'});const refund=value.refunds[0].id;
    assert.deepEqual(new Set(value.fulfillment.pauseReasons.map(p=>p.code)),new Set(['financial','coupon','refund_pending','fulfillment','workflow']));
    const code=h.data(await user.request('GET',`/api/me/orders/${value.id}/query-code`)).queryCode;const recovered=h.data(await other.request('POST','/api/orders/recover',{queryCode:code}));assert(recovered.fulfillment.pauseReasons.every(p=>!Object.hasOwn(p,'note')&&!Object.hasOwn(p,'reasonCode')));
    for(const resource of ['fulfillment-action','delivery-action'])assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/${resource}`,{expectedVersion:value.version,action:'delivered',actualDeliveryConfirmed:true})).status,409);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/production-action`,{expectedVersion:value.version,action:'start'})).status,409);
    value=await h.action(admin,value,'coupon-resolution',{action:'continue',reasonCode:'honor_discount'});assert(!value.fulfillment.pauseReasons.some(p=>p.code==='coupon'));assert(value.payment.financialHold);
    value=await h.action(admin,value,'payment-review',{action:'resolve_exception',resolutionOutcome:'exact_receipt',reasonCode:'exact_receipt'});assert(!value.payment.financialHold);assert.equal(value.fulfillment.stage,'paused');
    value=await h.action(admin,value,'refunds',{action:'reject',refundId:refund,reasonCode:'unsupported_request',fulfillmentDecision:'resume'});assert.equal(value.production.fulfillmentHold,true);
    value=await resume(admin,value,'workflow');assert(value.fulfillment.pauseReasons.some(p=>p.code==='fulfillment'));assert.equal(value.fulfillment.acceptedAt,null);
    value=await resume(admin,value,'fulfillment');assert.equal(value.fulfillment.stage,'in_progress');assert.equal(value.fulfillment.acceptedAt,now.toISOString());
    value=await h.action(admin,value,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});assert.equal(value.lifecycle,'completed');assert.equal(value.payment.receipt.amountFen,40);assert.equal(value.actualRefundFen,0);
  });
  await t.test('退款 stop 与一般履约暂停独立；全额实退不能恢复或取消；保留资金和券核销',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user)),receipt=value.payment.receipt.amountFen;
    value=await pause(admin,value);value=await h.action(admin,value,'refunds',{action:'request',amountFen:receipt,reasonCode:'user_cancelled'});const refundId=value.refunds[0].id;
    value=await h.action(admin,value,'refunds',{action:'approve',refundId,reasonCode:'verified_request',fulfillmentDecision:'stop'});
    value=await h.action(admin,value,'refunds',{action:'paid_out',refundId,reasonCode:'refund_completed',fulfillmentDecision:'stop',payoutReference:'REFUND-'+randomUUID(),actualRefundConfirmed:true});
    assert(value.fulfillment.pauseReasons.some(p=>p.code==='workflow'));assert(value.fulfillment.pauseReasons.some(p=>p.code==='refund_stopped'));
    assert.equal((await h.post(admin,route(value),{expectedVersion:value.version,action:'resume',pauseCode:'refund_stopped',reasonCode:'issue_resolved'})).status,409);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print'})).body.error.code,'ORDER_CANCELLATION_BLOCKED');assert.equal(value.fulfillment.stage,'paused');assert.equal(value.payment.receipt.amountFen,receipt);assert.equal(value.actualRefundFen,receipt);
  });
  await t.test('后续退款的 resume 决定不自动抹去先前 stop；只能明确解除指定暂停',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user,{copies:3}));
    value=await h.action(admin,value,'refunds',{action:'request',amountFen:10,reasonCode:'print_problem'});const first=value.refunds.at(-1).id;
    value=await h.action(admin,value,'refunds',{action:'reject',refundId:first,reasonCode:'unsupported_request',fulfillmentDecision:'stop'});
    value=await h.action(admin,value,'refunds',{action:'request',amountFen:10,reasonCode:'delivery_problem'});const second=value.refunds.find(r=>r.status==='requested').id;
    value=await h.action(admin,value,'refunds',{action:'reject',refundId:second,reasonCode:'unsupported_request',fulfillmentDecision:'resume'});
    assert.equal(value.fulfillment.stage,'paused');assert(value.fulfillment.pauseReasons.some(p=>p.code==='refund_stopped'));
    assert(value.fulfillment.allowedActions.includes('resolve_fulfillment_pause'));
    assert.equal((await h.post(admin,route(value),{expectedVersion:value.version,action:'resume',pauseCode:'refund_stopped',reasonCode:'issue_resolved',independentCopiesConfirmed:'true'})).status,400);
    value=await resume(admin,value,'refund_stopped');assert.equal(value.fulfillment.stage,'in_progress');
  });
  await t.test('历史制作/配送失败须先逐项处理，再用合并送达；重印不重设完成期限',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user));value=await h.action(admin,value,'production-action',{action:'start'});value=await h.action(admin,value,'production-action',{action:'fail',completedContentPages:0,reasonCode:'print_problem'});
    assert.equal((await h.post(admin,route(value),{expectedVersion:value.version,action:'delivered',actualDeliveryConfirmed:true})).status,409);
    assert.equal((await h.post(admin,route(value),{expectedVersion:value.version,action:'resume',pauseCode:'production_failed',reasonCode:'issue_resolved'})).status,400);
    value=await resume(admin,value,'production_failed',{independentCopiesConfirmed:true});value=await h.action(admin,value,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});const expiry=value.filesExpireAt,completed=value.completedAt;
    now=new Date(now.getTime()+1000);value=await h.action(admin,value,'production-action',{action:'reprint',reasonCode:'print_problem'});assert.equal(value.fulfillment.stage,'completed');
    value=await h.action(admin,value,'production-action',{action:'reprint_complete',actualCompletionConfirmed:true});assert.equal(value.completedAt,completed);assert.equal(value.filesExpireAt,expiry);
  });
});

test('1.3.0 新单接收表单与唯一确认、报价/预览保护',{timeout:120000},async t=>{
  const runtime=await isolated({rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);const file=await h.upload(runtime,user),quote=await h.quote(runtime,user,file);let body=h.orderBody(quote);
  await t.test('新单缺接收方式和无效枚举拒绝；放门口不隐式默认；各条件必填',async()=>{
    const address=body.deliveryAddress;
    for(const update of [{receiptMethod:undefined},{receiptMethod:null},{receiptMethod:'invalid'},{receiptMethod:'contact_first',contact:''},{receiptMethod:'other',receiptNote:''},{receiptMethod:'handover',room:''}]){
      assert.equal((await h.post(user,'/api/orders',{...body,deliveryAddress:{...address,...update}})).status,400);
    }
    assert.equal(runtime.db.get('SELECT COUNT(*) n FROM print_orders').n,0);
  });
  await t.test('只需 confirmedPreview=true；旧 acceptedRules=false/true 布尔兼容，不伪造确认事实',async()=>{
    assert.equal((await h.post(user,'/api/orders',{...body,confirmedPreview:false})).status,400);
    assert.equal((await h.post(user,'/api/orders',{...body,acceptedRules:'true'})).status,400);
    assert.equal((await h.post(user,'/api/orders',{...body,quoteFingerprint:'x'.repeat(64)})).body.error.code,'QUOTE_CONFIRMATION_MISMATCH');
    const result=h.data(await h.post(user,'/api/orders',{...body,deliveryAddress:{...body.deliveryAddress,receiptMethod:'doorstep'},acceptedRules:false}),201);assert.equal(result.deliveryAddress.receiptMethod,'doorstep');assert(!Object.hasOwn(result.events[0].data,'acceptedRules'));
    const saved=runtime.db.get('SELECT addressJson FROM print_orders WHERE id=?',result.id).addressJson;
    const settings=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,buildingLabel:'后续名称'}));assert.equal(runtime.db.get('SELECT addressJson FROM print_orders WHERE id=?',result.id).addressJson,saved);
  });
  await t.test('四种主动选择均可建单；接收信息成为不可变快照',async()=>{
    for(const receiptMethod of ['handover','contact_first','doorstep','other']){
      const q=await h.quote(runtime,user,await h.upload(runtime,user));const input=h.orderBody(q);input.deliveryAddress={...input.deliveryAddress,receiptMethod,contact:receiptMethod==='contact_first'?'软件联系号':'',receiptNote:receiptMethod==='other'?'软件接收说明':''};input.acceptedRules=true;
      const value=h.data(await h.post(user,'/api/orders',input),201);assert.equal(value.deliveryAddress.receiptMethod,receiptMethod);assert.equal(value.deliveryAddress.receiptNote,input.deliveryAddress.receiptNote);
      assert.throws(()=>runtime.db.run('UPDATE print_orders SET addressJson=? WHERE id=?','{}',value.id),/ORDER_SNAPSHOT_IMMUTABLE/);
    }
  });
});

test('1.3.0 一般反馈、管理员范围、广告停用与营业局部写入',{timeout:120000},async t=>{
  let now=new Date();const runtime=await isolated({clock:()=>new Date(now),rateLimits:{writeUser:3000,writeIp:6000}});t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);let feedback,order;
  await t.test('无订单也能反馈；成对联系验证、幂等与敏感投影',async()=>{
    const counts=()=>Object.fromEntries(['print_orders','coupons','files'].map(t=>[t,runtime.db.get(`SELECT COUNT(*) n FROM ${t}`).n]));const before=counts();
    for(const input of [{message:''},{message:'反馈',orderId:randomUUID()},{message:'反馈',contactType:'phone'},{message:'反馈',contactType:'email',contactValue:'x'},{message:'反馈',contactType:'wechat',contactValue:'\n'}])assert.equal((await h.post(user,'/api/me/feedback',input)).status,400);
    const body={message:'无需关联订单的一般意见',contactType:'wechat',contactValue:'private-software-contact'},key=h.key(),first=await h.post(user,'/api/me/feedback',body,key);feedback=h.data(first,201);assert.deepEqual((await h.post(user,'/api/me/feedback',body,key)).body,first.body);
    assert.equal(feedback.category,'general');assert.equal(feedback.orderId,null);assert.equal(feedback.orderNo,null);assert.equal(feedback.contactProvided,true);assert(!Object.hasOwn(feedback,'contactValue'));assert.deepEqual(counts(),before);
    assert.equal((await other.request('GET','/api/me/tickets/'+feedback.id)).status,404);assert.equal(h.data(await other.request('GET','/api/me/tickets?category=general')).total,0);
    assert.equal(h.data(await admin.request('GET','/api/admin/tickets/'+feedback.id)).contactValue,'private-software-contact');
  });
  await t.test('原订单售后和一般反馈统一列表/类别/类型/状态及管理回复；查询码不能访问一般反馈',async()=>{
    order=await h.order(runtime,user);const ticket=h.data(await h.post(user,`/api/me/orders/${order.id}/tickets`,{feedbackType:'delivery',subject:'旧订单售后',message:'软件内容'}),201);assert.equal(ticket.category,'order');
    const code=h.data(await user.request('GET',`/api/me/orders/${order.id}/query-code`)).queryCode;h.data(await other.request('POST','/api/orders/recover',{queryCode:code}));assert.equal((await other.request('GET','/api/me/tickets/'+feedback.id)).status,404);
    const recovered=h.data(await other.request('GET','/api/me/tickets'));assert.equal(recovered.total,1);assert.equal(recovered.items[0].category,'order');assert(!Object.hasOwn(recovered.items[0],'userId'));
    assert.equal(h.data(await admin.request('GET','/api/admin/tickets?category=general&feedbackType=other')).total,1);assert.equal(h.data(await admin.request('GET','/api/admin/tickets?category=order&feedbackType=delivery')).total,1);
    feedback=h.data(await h.post(admin,`/api/admin/tickets/${feedback.id}/updates`,{expectedVersion:feedback.version,message:'商户回复软件意见',status:'resolved'}));assert.equal(feedback.status,'resolved');assert.equal(h.data(await user.request('GET','/api/me/tickets/'+feedback.id)).updates.at(-1).message,'商户回复软件意见');
    assert.equal(h.data(await admin.request('GET','/api/admin/tickets?category=general&status=resolved')).total,1);
    assert.equal((await h.post(admin,`/api/admin/tickets/${feedback.id}/updates`,{expectedVersion:1,message:'旧版本',status:'resolved'})).body.error.code,'VERSION_CONFLICT');
  });
  await t.test('管理员列表搜索分页固定管理员；role 参数、搜索或通配字符无法泄露学生访客',async()=>{
    const admin2=new Client(runtime);await admin2.admin();const list=h.data(await admin.request('GET','/api/admin/users?pageSize=1&page=1'));assert.equal(list.total,2);assert.equal(list.items.length,1);assert(list.items.every(v=>v.role==='admin'));
    assert.equal(h.data(await admin.request('GET','/api/admin/users?q='+encodeURIComponent(user.user.username))).total,0);
    assert.equal((await admin.request('GET','/api/admin/users?role=user')).status,400);assert.equal(h.data(await admin.request('GET','/api/admin/users?q=%25')).total,0);assert.equal((await user.request('GET','/api/admin/users')).status,403);
    assert.equal(runtime.db.get('SELECT COUNT(*) n FROM users WHERE role=\'user\'').n,2);
  });
  await t.test('默认广告关闭；公开空列表，所有旧图/管理入口拒绝且保留图片配置、鉴权和CSRF',async()=>{
    assert.equal(loadConfig({}).advertisementsEnabled,false);assert.throws(()=>loadConfig({ADVERTISEMENTS_ENABLED:'yes'}));assert.equal(h.data(await user.request('GET','/api/public/config')).capabilities.advertisements,false);
    const publicAds=h.data(await user.request('GET','/api/public/advertisements'));assert.equal(publicAds.enabled,false);assert.deepEqual(publicAds.items,[]);const id=randomUUID();
    for(const [method,p,input] of [['GET','/api/admin/advertisements'],['POST','/api/admin/advertisements',{}],['PATCH','/api/admin/advertisements',{expectedVersion:1}],['PATCH',`/api/admin/advertisements/${id}`,{expectedVersion:1,enabled:true}],['DELETE',`/api/admin/advertisements/${id}`,{expectedVersion:1}],['POST',`/api/admin/advertisements/${id}/image`,{}],['GET',`/api/admin/advertisements/${id}/image`],['GET',`/api/public/advertisements/${id}/image`]]){
      let response;if(method==='POST'){const form=new FormData();form.append('file',new Blob(['x']), 'disabled.png');response=await admin.request(method,p,form,{form:true});}else response=await admin.request(method,p,input);
      assert.equal(response.status,403,p);assert.equal(response.body.error.code,'ADVERTISEMENTS_DISABLED',p);
    }
    const anon=new Client(runtime,{surface:'admin'});assert.equal((await anon.request('GET','/api/admin/advertisements')).status,401);
    assert.equal((await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:1},{headers:{'X-CSRF-Token':'invalid'}})).body.error.code,'FORBIDDEN');
  });
  await t.test('营业单目标局部切换不改码和维护，冲突重读；休息挡三个新入口但允许已有单及反馈',async()=>{
    h.data(await m.image(admin,'/api/admin/payment-qr/wechat'));const q=await h.quote(runtime,user,await h.upload(runtime,user)),input=h.orderBody(q),file=await h.upload(runtime,user);let settings=h.data(await admin.request('GET','/api/admin/settings'));
    const paymentBefore=JSON.stringify(settings.payment),maintenanceBefore=JSON.stringify(settings.maintenance),beforeVersion=settings.version;
    settings=h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:beforeVersion,acceptingOrders:false}));assert.equal(settings.acceptingOrders,false);assert.equal(JSON.stringify(settings.payment),paymentBefore);assert.equal(JSON.stringify(settings.maintenance),maintenanceBefore);
    assert.equal((await admin.request('PATCH','/api/admin/settings',{expectedVersion:beforeVersion,acceptingOrders:true})).body.error.code,'VERSION_CONFLICT');assert.equal(h.data(await admin.request('GET','/api/admin/settings')).acceptingOrders,false);
    assert.equal((await user.upload(await h.fixture('sample-chinese.png'),'paused.png','image/png')).body.error.code,'ORDERS_PAUSED');assert.equal((await h.post(user,'/api/print/quotes',{items:[{fileId:file.id,pages:'all',copies:1,duplex:false}]})).body.error.code,'ORDERS_PAUSED');assert.equal((await h.post(user,'/api/orders',input)).body.error.code,'ORDERS_PAUSED');
    h.data(await h.post(user,'/api/me/feedback',{message:'休息仍可反馈'}),201);order=h.data(await h.post(user,`/api/me/orders/${order.id}/payment-submissions`,{expectedVersion:order.version,channel:'wechat',reference:''}));order=await h.confirm(admin,order,{channel:'wechat'});order=await h.action(admin,order,'fulfillment-action',{action:'delivered',actualDeliveryConfirmed:true});assert.equal(order.lifecycle,'completed');
  });
  await t.test('固定七天凭证失效后不能读原身份反馈；新身份和订单码也不能找回一般反馈',async()=>{
    now=new Date(now.getTime()+7*86400000);assert.equal((await user.request('GET','/api/me/tickets/'+feedback.id)).status,401);const fresh=new Client(runtime);await fresh.guest();assert.equal((await fresh.request('GET','/api/me/tickets/'+feedback.id)).status,404);assert.equal(h.data(await fresh.request('GET','/api/me/tickets?category=general')).total,0);
  });
});

test('1.3.0 默认关闭后经营素材/一般反馈备份恢复仍完整，隔离开启可恢复广告',{timeout:120000},async t=>{
  const runtime=await isolated({advertisementsEnabled:true}),names=[];let restored;const config=()=>{const name=randomUUID();names.push(name);return configAt(path.join(TEST_ROOT,name),{clock:()=>new Date()});};
  t.after(async()=>{await restored?.close();await runtime.destroy();for(const name of names)await removeTestStorage(name);});const {user,admin}=await h.actors(runtime);
  const original=h.data(await m.image(admin,'/api/admin/advertisements',{kind:'advertisement'}),201),ad=original.items[0],meta=runtime.db.get('SELECT assetJson FROM advertisements WHERE id=?',ad.id).assetJson;
  const feedback=h.data(await h.post(user,'/api/me/feedback',{message:'备份中的一般反馈',contactType:'phone',contactValue:'software-contact'}),201);h.data(await h.post(admin,`/api/admin/tickets/${feedback.id}/updates`,{expectedVersion:1,status:'in_progress',message:'备份中的回复'}));
  runtime.config.advertisementsEnabled=false;
  const snapshot=await createSnapshot(runtime),authority=path.join(runtime.root,'latest-authority');await exportAuthority(runtime,authority);const target=config();await restoreSnapshot({snapshotRoot:snapshot.directory,authorityRoot:authority,config:target});restored=await startServer(target);
  const anon=new Client(restored);assert.deepEqual(h.data(await anon.request('GET','/api/public/advertisements')).items,[]);assert.equal((await anon.request('GET',`/api/public/advertisements/${ad.id}/image`)).status,403);assert.equal(restored.db.get('SELECT assetJson FROM advertisements WHERE id=?',ad.id).assetJson,meta);
  const row=JSON.parse(meta),bytes=await fs.readFile(path.join(target.advertisementRoot,row.assetId+'.png'));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);assert.equal(restored.db.get('SELECT count(*) n FROM general_feedback_updates').n,2);assert.equal(restored.db.get('SELECT contactValue FROM general_feedback WHERE id=?',feedback.id).contactValue,'software-contact');
  await restored.close();restored=await startServer({...target,advertisementsEnabled:true});assert.equal(h.data(await new Client(restored).request('GET','/api/public/advertisements')).items[0].id,ad.id);assert.equal((await new Client(restored).request('GET',`/api/public/advertisements/${ad.id}/image`,undefined,{raw:true})).status,200);
  await m.evidence('workflow-backup',{defaultDisabledPreserved:true,imagesPreserved:true,feedbackAndReplyPreserved:true,isolatedReenableVerified:true,actualProductionSwitch:false});
});
