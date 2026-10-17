'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../helpers/runtime');
const h = require('./helpers');

test('报价失败、超时、参数绑定、并发认领与接口输入边界', async t => {
  let instant = new Date('2026-10-14T04:00:00.000Z');
  const runtime = await isolated({ clock:()=>new Date(instant), sessionMs:30*86400000 }); t.after(()=>runtime.destroy());
  const {user,other,admin} = await h.actors(runtime);
  await t.test('99 内容页通过真实接口；100/零/负数/小数/重复和越界拒绝',async()=>{
    const source=await h.upload(runtime,user);
    const q=await h.quote(runtime,user,source,{copies:99,duplex:true}); assert.equal(q.contentPages,99);assert.equal(q.sheetCount,99);assert.equal(q.totalAmountFen,4950);
    for (const bad of [{copies:0},{copies:-1},{copies:1.1},{copies:100},{pages:'0'},{pages:'1,1'},{pages:'2'},{duplex:'true'}]) assert.equal((await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false,...bad}]})).status,400);
    assert.equal((await h.post(user,'/api/print/quotes',{items:[]})).status,400);
    assert.equal((await h.post(other,'/api/print/quotes',{items:[{fileId:source.id,pages:'1',copies:1,duplex:false}]})).status,404);
    const second=await h.quote(runtime,user,source,{copies:1,duplex:false}); assert.notEqual(second.id,q.id);assert.notEqual(second.fingerprint,q.fingerprint);
    assert.equal((await h.post(user,'/api/orders',h.orderBody(second,{quoteFingerprint:q.fingerprint}))).body.error.code,'QUOTE_CONFIRMATION_MISMATCH');
    instant=new Date(instant.getTime()+900000); const expired=h.data(await user.request('GET',`/api/print/quotes/${second.id}`));assert.equal(expired.valid,false);assert.equal(expired.invalidReason,'QUOTE_EXPIRED');
    assert.equal((await h.post(user,'/api/orders',h.orderBody(second))).body.error.code,'QUOTE_EXPIRED');
  });
  await t.test('两份报价同一来源并发认领，只有一笔提交；全组认领回滚',async()=>{
    const source=await h.upload(runtime,user),q1=await h.quote(runtime,user,source),q2=await h.quote(runtime,user,source,{duplex:true});
    const results=await Promise.all([h.post(user,'/api/orders',h.orderBody(q1)),h.post(user,'/api/orders',h.orderBody(q2))]);assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);
    assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM print_orders WHERE quoteId IN (?,?)',q1.id,q2.id).n,1);
    const fileA=await h.upload(runtime,user),fileB=await h.upload(runtime,user),qA=await h.quote(runtime,user,fileA);
    let both=h.data(await h.post(user,'/api/print/quotes',{items:[fileA,fileB].map(file=>({fileId:file.id,pages:'all',copies:1,duplex:true}))}),202);await runtime.files.waitForIdle();both=h.data(await user.request('GET',`/api/print/quotes/${both.id}`));assert.equal(both.sheetCount,2);
    h.data(await h.post(user,'/api/orders',h.orderBody(qA)),201);assert.equal((await h.post(user,'/api/orders',h.orderBody(both))).status,409);assert.equal(runtime.db.get('SELECT claimedOrderId FROM files WHERE id=?',fileB.id).claimedOrderId,null);
  });
  await t.test('真实处理失败不发布 ready；处理期限到时有明确失效原因',async()=>{
    const source=await h.upload(runtime,user);const original=runtime.files.preparePrintItem.bind(runtime.files);
    runtime.files.preparePrintItem=async()=>{throw Object.assign(new (require('../../backend/errors').ApiError)(422,'FILE_PROCESS_FAILED','软件注入确定处理故障'));};
    const created=h.data(await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false}]}),202);await new Promise(resolve=>setImmediate(resolve));
    const failed=h.data(await user.request('GET',`/api/print/quotes/${created.id}`));assert.equal(failed.status,'failed');assert.equal(failed.error.code,'FILE_PROCESS_FAILED');assert.equal((await h.post(user,'/api/orders',h.orderBody(failed))).status,409);
    runtime.files.preparePrintItem=original;
    const pending=h.data(await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:true}]}),202);await runtime.files.waitForIdle();instant=new Date(instant.getTime()+600000);
    const timed=h.data(await user.request('GET',`/api/print/quotes/${pending.id}`));assert.equal(timed.status,'failed');assert.equal(timed.error.code,'QUOTE_PREPARATION_TIMEOUT');
  });
  await t.test('收款码替换/清除与设置版本冲突、价格只读、未配置禁核对',async()=>{
    const first=h.data(await h.paymentQr(admin));assert.equal(first.payment.configured,true);
    const oldAsset=JSON.parse(runtime.context.orders.settingsRow().paymentAssetJson).assetId;
    const next=h.data(await h.paymentQr(admin));assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM payment_asset_cleanup').n,0);
    await assert.rejects(runtime.files.openPaymentAsset(oldAsset));
    assert.equal((await admin.request('PATCH','/api/admin/settings',{expectedVersion:first.version,acceptingOrders:false})).body.error.code,'VERSION_CONFLICT');
    assert.equal((await admin.request('PATCH','/api/admin/settings',{expectedVersion:next.version,unitSheetPriceFen:1})).status,400);
    const cleared=h.data(await admin.request('DELETE','/api/admin/payment-qr',{expectedVersion:next.version}));assert.equal(cleared.payment.configured,false);assert.equal((await user.request('GET','/api/public/payment-qr')).status,404);
  });
});

test('人工核款、退款约束与取消/打印竞争',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);h.data(await h.paymentQr(admin));
  await t.test('首次核款完全幂等、重复交易跨订单拒绝、退回后重提',async()=>{
    let value=await h.order(runtime,user);value=h.data(await h.post(user,`/api/me/orders/${value.id}/payment-submissions`,{expectedVersion:value.version,channel:'other',reference:'声明'}));
    value=await h.action(admin,value,'payment-review',{action:'reject',reasonCode:'not_received'});assert.equal(value.payment.status,'rejected');
    value=h.data(await h.post(user,`/api/me/orders/${value.id}/payment-submissions`,{expectedVersion:value.version,channel:'other',reference:'新声明'}));
    const body={expectedVersion:value.version,action:'confirm',amountFen:value.totals.totalAmountFen,channel:'other',reference:'DUPLICATE-TX-CASE',note:'软件模拟'},headers=h.key();
    const first=await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,body,headers);value=h.data(first);assert.deepEqual((await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,body,headers)).body,first.body);
    const otherOrder=await h.order(runtime,other);assert.equal((await h.post(admin,`/api/admin/orders/${otherOrder.id}/payment-review`,{...body,expectedVersion:otherOrder.version,reference:'duplicate-tx-case'})).body.error.code,'TRANSACTION_ALREADY_RECORDED');
    assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM payment_receipts').n,1);
  });
  await t.test('同版本取消与开始打印竞争恰好一项成功；失败请求不覆盖状态',async()=>{
    const value=await h.confirm(admin,await h.order(runtime,user));
    const results=await Promise.all([h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print'}),h.post(admin,`/api/admin/orders/${value.id}/production-action`,{expectedVersion:value.version,action:'start'})]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);const latest=h.data(await admin.request('GET',`/api/admin/orders/${value.id}`));assert.equal(latest.version,value.version+1);assert(!(latest.lifecycle==='cancel_requested'&&latest.production.status==='printing'));
  });
  await t.test('实收订单始终禁取消；全额批准不等于实退；累计上限与幂等',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user,{copies:2}));
    assert.equal((await h.post(user,`/api/me/orders/${value.id}/cancel-requests`,{expectedVersion:value.version,reason:'已接单不能直接取消'})).status,409);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print'})).body.error.code,'ORDER_CANCELLATION_BLOCKED');
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'approve',note:'尚未退款'})).status,409);
    value=await h.action(admin,value,'refunds',{action:'request',amountFen:100,reason:'软件模拟全额'});const refundId=value.refunds[0].id;
    value=await h.action(admin,value,'refunds',{action:'approve',refundId,note:'批准退款仍待实际操作',fulfillmentDecision:'stop'});assert.equal(value.actualRefundFen,0);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'approve',note:'已批准但没实退'})).status,409);
    const body={expectedVersion:value.version,action:'paid_out',refundId,note:'软件模拟实际退款',payoutReference:'FULL-REFUND-SOFTWARE',actualRefundConfirmed:true,fulfillmentDecision:'stop'},headers=h.key();const first=await h.post(admin,`/api/admin/orders/${value.id}/refunds`,body,headers);value=h.data(first);assert.deepEqual((await h.post(admin,`/api/admin/orders/${value.id}/refunds`,body,headers)).body,first.body);
    assert.equal(value.actualRefundFen,100);assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print'})).body.error.code,'ORDER_CANCELLATION_BLOCKED');assert.equal(value.lifecycle,'active');assert.equal(value.payment.status,'confirmed');assert.equal(value.completedAt,null);
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/refunds`,{expectedVersion:value.version,action:'request',amountFen:1,reason:'超过实收'})).body.error.code,'REFUND_LIMIT');
  });
  await t.test('退款申请暂停新生产，但可记录停机进度；拒绝/实退须明确剩余履约',async()=>{
    let value=await h.confirm(admin,await h.order(runtime,user,{copies:3}));value=await h.action(admin,value,'production-action',{action:'start'});
    value=await h.action(admin,value,'refunds',{action:'request',amountFen:50,reason:'软件卡纸售后'});let refundId=value.refunds[0].id;
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/production-action`,{expectedVersion:value.version,action:'complete',actualCompletionConfirmed:true})).status,409);
    value=await h.action(admin,value,'production-action',{action:'fail',completedContentPages:1,note:'停机保留已完成一份'});
    value=await h.action(admin,value,'refunds',{action:'reject',refundId,note:'人工决定继续处理',fulfillmentDecision:'stop'});assert.equal(value.production.fulfillmentHold,true);
    value=await h.action(admin,value,'production-action',{action:'resume',note:'核实售后已解决，恢复剩余履约'});assert.equal(value.production.fulfillmentHold,false);
    value=await h.action(admin,value,'production-action',{action:'retry',note:'只打印剩余',independentCopiesConfirmed:true});
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print'})).body.error.code,'ORDER_CANCELLATION_BLOCKED');
    value=await h.action(admin,value,'production-action',{action:'fail',completedContentPages:1,note:'按取消申请停止生产'});
    assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/cancel-resolution`,{expectedVersion:value.version,action:'cancel',reasonCode:'cannot_print',settlement:'retain_confirmed'})).status,400);assert.equal(value.lifecycle,'active');assert(value.payment.receipt);
  });
  await t.test('暂停接单与维护独立，已有订单仍可完成付款/打印/配送/售后',async()=>{
    const source=await h.upload(runtime,user),quoteBody={items:[{fileId:source.id,pages:'all',copies:1,duplex:false}]},quoteHeaders=h.key();
    const firstQuote=await h.post(user,'/api/print/quotes',quoteBody,quoteHeaders);const q=h.data(firstQuote,202);await runtime.files.waitForIdle();const ready=h.data(await user.request('GET',`/api/print/quotes/${q.id}`));
    const createBody=h.orderBody(ready),createHeaders=h.key(),created=await h.post(user,'/api/orders',createBody,createHeaders);let value=h.data(created,201);
    const settings=h.data(await admin.request('GET','/api/admin/settings'));h.data(await admin.request('PATCH','/api/admin/settings',{expectedVersion:settings.version,acceptingOrders:false,maintenance:{enabled:true,message:'软件测试维护'}}));
    assert.deepEqual((await h.post(user,'/api/print/quotes',quoteBody,quoteHeaders)).body,firstQuote.body);assert.deepEqual((await h.post(user,'/api/orders',createBody,createHeaders)).body,created.body);
    value=h.data(await h.post(user,`/api/me/orders/${value.id}/payment-submissions`,{expectedVersion:value.version,channel:'other',reference:'维护期间声明'}));value=await h.confirm(admin,value);value=await h.delivered(admin,value);assert.equal(value.lifecycle,'completed');
    const ticket=h.data(await h.post(user,`/api/me/orders/${value.id}/tickets`,{subject:'维护售后',message:'已有订单仍可售后'}),201);assert.equal(ticket.status,'open');
    assert.equal((await h.post(user,'/api/print/quotes',{items:[]})).body.error.code,'MAINTENANCE');
  });
});

test('核实未到账可解除异常而不放行生产；已确认入账不可抹去',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,admin}=await h.actors(runtime);let value=await h.order(runtime,user);
  value=h.legacyFinancial(runtime,value);
  value=await h.action(admin,value,'payment-review',{action:'resolve_exception',resolutionOutcome:'no_receipt',note:'软件核实本单没有入账，不确认付款'});
  assert.equal(value.payment.financialHold,false);assert.equal(value.payment.status,'rejected');assert.equal(value.payment.receipt,null);assert(!value.allowedActions.includes('start_print'));
  value=await h.confirm(admin,value);assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/payment-review`,{expectedVersion:value.version,action:'resolve_exception',resolutionOutcome:'no_receipt',note:'试图抹去事实'})).status,409);
  assert.equal((await h.post(admin,`/api/admin/orders/${value.id}/production-action`,{expectedVersion:value.version,action:'start',actualCompletionConfirmed:true})).status,400);
});
