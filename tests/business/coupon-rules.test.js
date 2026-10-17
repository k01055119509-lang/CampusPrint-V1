'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discountFor } = require('../../backend/coupons/service');
const cases = [
  ['85% 半分舍入', { type:'discount', minPrintAmountFen:0, payRatePercent:85, maxDiscountFen:null },50,7],
  ['0.1 折', { type:'discount', minPrintAmountFen:0, payRatePercent:1, maxDiscountFen:null },50,49],
  ['9.9 折舍入后没有优惠', { type:'discount', minPrintAmountFen:0, payRatePercent:99, maxDiscountFen:null },50,0],
  ['折扣封顶', { type:'discount', minPrintAmountFen:100, payRatePercent:80, maxDiscountFen:7 },140,7],
  ['满减恰达门槛', { type:'threshold', minPrintAmountFen:1000, reductionFen:200 },1000,200],
  ['满减不按每满重复', { type:'threshold', minPrintAmountFen:1000, reductionFen:200 },3000,200]
];
for (const [name, rule, amount, expected] of cases) test('优惠金额：' + name, () => assert.equal(discountFor(rule, amount), expected));
test('优惠边界：门槛差一分、舍入到零和负数均明确拒绝', () => {
  assert.throws(() => discountFor({ type:'threshold', minPrintAmountFen:1000,reductionFen:200 },999), e=>e.code==='COUPON_THRESHOLD_NOT_MET');
  assert.throws(() => discountFor({ type:'discount', minPrintAmountFen:0,payRatePercent:1,maxDiscountFen:null },49), e=>e.code==='COUPON_ZERO_TOTAL');
  for (const reductionFen of [100,101]) assert.throws(() => discountFor({type:'threshold',minPrintAmountFen:1,reductionFen},100),e=>e.code==='COUPON_ZERO_TOTAL');
});
