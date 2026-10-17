'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateItems } = require('../../backend/orders/rules');
const fileId = '12345678-1234-4123-8123-123456789abc';
const source = { id: fileId, originalName: '独立计价样本.pdf', sourcePageCount: 200, sourceSha256: 'a'.repeat(64) };
const item = (pages, copies, duplex) => ({ fileId, pages, copies, duplex });
const examples = [
 ['1 页单面', [item('1',1,false)], 1,1,50],
 ['1 页双面', [item('1',1,true)], 1,1,50],
 ['2 页双面', [item('1-2',1,true)], 2,1,90],
 ['3 页双面', [item('1-3',1,true)], 3,2,140],
 ['3 页双面 2 份', [item('1-3',2,true)], 6,4,280],
 ['两个各 3 页文件独立起纸', [item('1-3',1,true),{...item('1-3',1,true),fileId:'22345678-1234-4123-8123-123456789abc'}],6,4,280],
 ['10 页双面', [item('1-10',1,true)], 10,5,450],
 ['10 页单面', [item('1-10',1,false)], 10,10,500],
 ['3 页双面加 2 页单面', [item('1-3',1,true),{...item('1-2',1,false),fileId:'22345678-1234-4123-8123-123456789abc'}],5,4,240],
 ['11 页 3 份双面', [item('1-11',3,true)], 33,18,1500],
 ['两个各 1 页文件独立起纸', [item('1',1,true),{...item('1',1,true),fileId:'22345678-1234-4123-8123-123456789abc'}],2,2,100],
 ['99 页单面', [item('1-99',1,false)],99,99,4950],
 ['99 页双面', [item('1-99',1,true)],99,50,4460],
 ['1 页 99 份独立起纸', [item('1',99,true)],99,99,4950],
 ['200 页源选合法部分', [item('1,100,200',1,true)],3,2,140]
];
for (const [label, items, pages, sheets, fen] of examples) test(`1.1.0 计价：${label}`, () => {
  const result = calculateItems(items, id => ({ ...source, id }));
  assert.equal(result.totals.contentPages, pages); assert.equal(result.totals.sheetCount, sheets); assert.equal(result.totals.totalAmountFen, fen);
  assert.equal(result.totals.deliveryFeeFen, 0); assert.equal(result.totals.currency, 'CNY');
  assert.equal(result.totals.pricingVersion, '1.1.0'); assert.equal(result.totals.printAmountFen, fen); assert.equal(result.totals.discountAmountFen, 0);
});
const invalids = [[], [item('1-50',2,true)], [item('1-100',1,false)], [item('1',0,false)], [item('1',-1,false)], [item('1',1.5,false)], [item('1','2',false)], [item('1',1,'true')], ...['0','-1','1.5','1,1','1-3,3','201','2-1','1-','', 'all'].map(p => [item(p,1,false)])];
invalids.forEach((items, i) => test(`计价/页码非法参数 ${i+1}`, () => assert.throws(() => calculateItems(items, () => source), error => error.status === 400)));
