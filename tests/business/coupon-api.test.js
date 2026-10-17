'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../helpers/runtime');
const h = require('./helpers');
const c = require('./coupon-helpers');
test('优惠券管理真实接口：批次、规则、遮罩、专用读取、权限和优惠试算', async t => {
  let instant = new Date('2026-10-14T04:00:00.000Z');
  const runtime = await isolated({ clock:()=>new Date(instant), rateLimits:{writeIp:6000,writeUser:3000,uploadUser:100} }); t.after(()=>runtime.destroy());
  const { user, other, admin } = await h.actors(runtime), records = [];
  let issued, source;
  await t.test('数量默认 1、边界 1/100、独立 25 字符码，批次幂等且普通结果遮罩', async () => {
    const body = { type:'discount',payRatePercent:80 }, headers = h.key();
    const [first, again] = await Promise.all([h.post(admin,'/api/admin/coupon-batches',body,headers),h.post(admin,'/api/admin/coupon-batches',body,headers)]);
    const value = h.data(first,201); assert.deepEqual(again.body,first.body); assert.equal(value.quantity,1);
    assert.equal(Date.parse(value.expiresAt)-instant.getTime(),7*86400000);
    issued = { batch:value,coupon:value.coupons[0],code:await c.reveal(admin,value.coupons[0].id) };
    assert.equal(issued.code.length,25,'effective code length'); assert(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{25}$/.test(issued.code),'secure alphabet');
    const one = await c.batch(admin,{quantity:1}), hundred = await c.batch(admin,{quantity:100}); assert.equal(one.quantity,1);assert.equal(hundred.coupons.length,100);
    const full = await admin.request('POST','/api/admin/coupons/reveal-codes',{couponIds:hundred.coupons.map(row=>row.id)});
    assert.equal(full.status,200);const codes=full.body.data.items.map(row=>row.code);
    assert.equal(new Set(codes).size,100,'independent unique codes'); assert(codes.every(code=>/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{25}$/.test(code)));
    c.assertNoCodes([first.body,hundred,JSON.parse(runtime.db.get("SELECT resultJson FROM business_idempotency WHERE operation='create_coupon_batch' AND key=?",headers['Idempotency-Key']).resultJson)], [issued.code,...codes]);
    for(const quantity of [0,101,null,1.5,'1']) assert.equal((await h.post(admin,'/api/admin/coupon-batches',{...body,quantity})).status,400);
    assert.equal((await h.post(admin,'/api/admin/coupon-batches',{...body,payRatePercent:85},headers)).body.error.code,'IDEMPOTENCY_CONFLICT');
    records.push({scenario:'batch quantity/default/unique codes/idempotency',defaultQuantity:1,maxQuantity:100,uniqueCodes:100,effectiveLength:25,completeCodesInOrdinaryData:false});
  });
  await t.test('有效期默认七天/自定义/null；非法和过去日期拒绝，发行规则不可修改',async()=>{
    const custom=await c.batch(admin,{expiresAt:'2026-10-14T12:01:00+08:00'}); assert.equal(custom.expiresAt,'2026-10-14T04:01:00.000Z');
    const defaulted=await c.batch(admin,{expiresAt:null});assert.equal(Date.parse(defaulted.expiresAt)-instant.getTime(),7*86400000);
    for(const expiresAt of ['bad','2026-10-14T04:00:00.000Z','2027-02-30T04:00:00.000Z',999]) assert.equal((await h.post(admin,'/api/admin/coupon-batches',{type:'discount',payRatePercent:80,expiresAt})).status,400);
    assert.throws(()=>runtime.db.run('UPDATE coupons SET expiresAt=? WHERE id=?','2027-10-14T04:00:00.000Z',custom.coupons[0].id),/COUPON_RULE_IMMUTABLE/);
  });
  await t.test('0.1/9.9 折、默认门槛/封顶，满减规则与额外精度校验',async()=>{
    for(const payRatePercent of [1,99]){const value=await c.batch(admin,{payRatePercent});assert.equal(value.coupons[0].payRatePercent,payRatePercent);assert.equal(value.coupons[0].minPrintAmountFen,0);assert.equal(value.coupons[0].maxDiscountFen,null);}
    for(const payRatePercent of [0,100,85.5,'85']) assert.equal((await h.post(admin,'/api/admin/coupon-batches',{type:'discount',payRatePercent})).status,400);
    for(const bad of [{maxDiscountFen:0},{minPrintAmountFen:-1},{reductionFen:10}])assert.equal((await h.post(admin,'/api/admin/coupon-batches',{type:'discount',payRatePercent:80,...bad})).status,400);
    const threshold=await c.batch(admin,{type:'threshold',minPrintAmountFen:1000,reductionFen:200}); assert.equal(threshold.coupons[0].payRatePercent,null);assert.equal(threshold.coupons[0].maxDiscountFen,null);
    for(const bad of [{minPrintAmountFen:0,reductionFen:1},{minPrintAmountFen:100,reductionFen:100},{minPrintAmountFen:100,reductionFen:101},{minPrintAmountFen:100,reductionFen:0},{minPrintAmountFen:100,reductionFen:1,payRatePercent:80}])assert.equal((await h.post(admin,'/api/admin/coupon-batches',{type:'threshold',...bad})).status,400);
  });
  await t.test('分页与过滤、查询参数边界、学生/匿名/错误上下文/CSRF 禁止券管理',async()=>{
    const result=h.data(await admin.request('GET','/api/admin/coupons?type=discount&state=available&batchId='+issued.batch.batchId));assert.equal(result.total,1);assert.equal(result.items[0].maskedCode,issued.coupon.maskedCode);assert.equal(result.page,1);assert.equal(result.pageSize,20);
    for(const query of ['pageSize=0','pageSize=101','state=expired','type=other','batchId=bad','unknown=1'])assert.equal((await admin.request('GET','/api/admin/coupons?'+query)).status,400);
    assert.equal(h.data(await admin.request('GET','/api/admin/coupons?pageSize=100')).items.length,100);
    for(const route of ['/api/admin/coupons','/api/admin/orders'])assert.equal((await user.request('GET',route)).status,403);
    assert.equal((await h.post(user,'/api/admin/coupon-batches',{type:'discount',payRatePercent:80})).status,403);
    assert.equal((await user.request('POST','/api/admin/coupons/reveal-codes',{couponIds:[issued.coupon.id]})).status,403);
    assert.equal((await admin.request('POST','/api/admin/coupons/reveal-codes',{couponIds:[issued.coupon.id]},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
    assert.equal((await admin.request('GET','/api/admin/coupons',undefined,{headers:{'X-CP-Surface':'student'}})).status,403);
    for(const couponIds of [[],Array(101).fill(issued.coupon.id),[issued.coupon.id,issued.coupon.id],['bad']])assert.equal((await admin.request('POST','/api/admin/coupons/reveal-codes',{couponIds})).status,400);
  });
  await t.test('大小写/五位分组输入、空码不用券、85% 半分、封顶和门槛都由服务端计算',async()=>{
    source=await h.upload(runtime,user);
    const discounted=await c.issued(admin,{payRatePercent:85}); const input=discounted.code.toLowerCase().match(/.{5}/g).join(' - ');
    const q=await c.quote(runtime,user,source,input);assert.equal(q.printAmountFen,50);assert.equal(q.discountAmountFen,7);assert.equal(q.totalAmountFen,43);assert.equal(q.coupon.maskedCode,discounted.coupon.maskedCode);assert.equal(q.pricingVersion,'1.1.0');
    const capped=await c.issued(admin,{payRatePercent:80,maxDiscountFen:7});const cap=await c.quote(runtime,user,source,capped.code,{copies:3});assert.equal(cap.printAmountFen,150);assert.equal(cap.discountAmountFen,7);assert.equal(cap.totalAmountFen,143);
    const threshold=await c.issued(admin,{type:'threshold',minPrintAmountFen:100,reductionFen:20});const met=await c.quote(runtime,user,source,threshold.code,{copies:2});assert.equal(met.discountAmountFen,20);assert.equal(met.totalAmountFen,80);
    const miss=await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false}],couponCode:threshold.code});assert.equal(miss.body.error.code,'COUPON_THRESHOLD_NOT_MET');
    const oneFenShort=await c.issued(admin,{type:'threshold',minPrintAmountFen:51,reductionFen:1});assert.equal((await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false}],couponCode:oneFenShort.code})).body.error.code,'COUPON_THRESHOLD_NOT_MET');
    const empty=await c.quote(runtime,user,source,'');assert.equal(empty.coupon,null);assert.equal(empty.discountAmountFen,0);
    for(const value of [null,'bad','2'.repeat(25)])assert.equal((await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false}],couponCode:value})).body.error.code,'COUPON_INVALID');
    c.assertNoCodes([q,cap,met,empty],[discounted.code,capped.code,threshold.code]);
    records.push({scenario:'server rounding and cap',printAmountFen:50,payRatePercent:85,totalAmountFen:43,discountAmountFen:7,cappedDiscountFen:7});
  });
  await t.test('两访客试算同码不占用；停用后的报价/建单失败、专用码仍可看但列表有状态',async()=>{
    const otherFile=await h.upload(runtime,other),q1=await c.quote(runtime,user,source,issued.code),q2=await c.quote(runtime,other,otherFile,issued.code);
    assert.equal(c.row(runtime,issued.coupon).state,'available');assert.equal(c.row(runtime,issued.coupon).reservedOrderId,null);
    const headers=h.key(),body={expectedVersion:issued.coupon.version,note:'隔离停用验证'};
    const first=await h.post(admin,'/api/admin/coupons/'+issued.coupon.id+'/disable',body,headers);h.data(first);assert.deepEqual((await h.post(admin,'/api/admin/coupons/'+issued.coupon.id+'/disable',body,headers)).body,first.body);
    assert.equal(h.data(await user.request('GET','/api/print/quotes/'+q1.id)).invalidReason,'COUPON_UNAVAILABLE');
    assert.equal((await h.post(other,'/api/orders',h.orderBody(q2))).body.error.code,'COUPON_UNAVAILABLE');
    assert.equal((await h.post(user,'/api/print/quotes',{items:[{fileId:source.id,pages:'all',copies:1,duplex:false}],couponCode:issued.code})).body.error.code,'COUPON_UNAVAILABLE');
    assert(await c.reveal(admin,issued.coupon.id),'disabled unredeemed code is revealable');
    const dto=h.data(await admin.request('GET','/api/admin/coupons?batchId='+issued.batch.batchId)).items[0];assert.equal(dto.state,'available');assert(dto.disabledAt);assert.equal(dto.isExpired,false);
  });
  await t.test('报价后到期须明确重报；非正应付建单校验不会偷偷改为 1 分',async()=>{
    const expiring=await c.issued(admin,{expiresAt:new Date(instant.getTime()+1000).toISOString()}),q=await c.quote(runtime,user,source,expiring.code);instant=new Date(instant.getTime()+1000);
    assert.equal(h.data(await user.request('GET','/api/print/quotes/'+q.id)).invalidReason,'COUPON_UNAVAILABLE');assert.equal((await h.post(user,'/api/orders',h.orderBody(q))).body.error.code,'COUPON_UNAVAILABLE');assert.equal(c.row(runtime,expiring.coupon).state,'available');
    const clean=await c.quote(runtime,user,source,'');
    // Inject invalid server-side snapshot totals only in the isolated test DB.
    for(const totalAmountFen of [0,-1]){runtime.db.run('UPDATE print_quotes SET totalsJson=? WHERE id=?',JSON.stringify({contentPages:clean.contentPages,sheetCount:clean.sheetCount,pricingVersion:clean.pricingVersion,pricingRules:clean.pricingRules,printAmountFen:clean.printAmountFen,discountAmountFen:clean.discountAmountFen,deliveryFeeFen:0,totalAmountFen,currency:'CNY'}),clean.id);assert.equal((await h.post(user,'/api/orders',h.orderBody(clean))).body.error.code,'COUPON_ZERO_TOTAL');}
    assert.equal(runtime.db.get('SELECT COUNT(*) n FROM print_orders').n,0);assert.equal(runtime.db.get('SELECT claimedOrderId FROM files WHERE id=?',source.id).claimedOrderId,null);
  });
  await c.evidence('coupon-api-evidence',{kind:'B-real-isolated-coupon-management-API',records,realPayment:false,fullCodesRecorded:false});
});
