'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {isolated,PROJECT}=require('../helpers/runtime');
const h=require('../business/helpers');
const EVIDENCE=process.env.CP_VERIFICATION_DIR || path.join(PROJECT,'docs/verification/B');

test('B 学生接口集成：新计价、业务边界、访客权限及生产版本',async t=>{
  const runtime=await isolated({rateLimits:{authIp:100,authAccount:100,writeUser:1000,writeIp:3000,csrfIp:1000,uploadUser:100,previewUser:1000}});
  t.after(()=>runtime.destroy());
  const {user,other,admin}=await h.actors(runtime);
  const pdf=await h.upload(runtime,user,'source-100-pages.pdf'),image=await h.upload(runtime,user,'sample-chinese.png'),secondImage=await h.upload(runtime,user,'orientation-6.jpg'),secondPdf=await h.upload(runtime,user,'source-100-pages.pdf','第二个独立文件.pdf');
  const records=[];
  // Expected values are the task 01 examples, not a copy of the server's pricing algorithm.
  const examples=[
    {name:'1 页单面',items:[{fileId:pdf.id,pages:'1',copies:1,duplex:false}],content:1,sheets:1,fen:50},
    {name:'1 页双面',items:[{fileId:pdf.id,pages:'1',copies:1,duplex:true}],content:1,sheets:1,fen:50},
    {name:'2 页双面',items:[{fileId:pdf.id,pages:'1-2',copies:1,duplex:true}],content:2,sheets:1,fen:90},
    {name:'3 页双面奇数尾页',items:[{fileId:pdf.id,pages:'1-3',copies:1,duplex:true}],content:3,sheets:2,fen:140},
    {name:'3 页双面 2 份',items:[{fileId:pdf.id,pages:'1-3',copies:2,duplex:true}],content:6,sheets:4,fen:280},
    {name:'两文件各 3 页双面独立起纸',items:[{fileId:pdf.id,pages:'1-3',copies:1,duplex:true},{fileId:secondPdf.id,pages:'1-3',copies:1,duplex:true}],content:6,sheets:4,fen:280},
    {name:'10 页双面',items:[{fileId:pdf.id,pages:'1-10',copies:1,duplex:true}],content:10,sheets:5,fen:450},
    {name:'10 页单面',items:[{fileId:pdf.id,pages:'1-10',copies:1,duplex:false}],content:10,sheets:10,fen:500},
    {name:'混合 3 页双面加 2 页单面',items:[{fileId:pdf.id,pages:'1-3',copies:1,duplex:true},{fileId:image.id,pages:'all',copies:2,duplex:false}],content:5,sheets:4,fen:240},
    {name:'11 页 3 份双面',items:[{fileId:pdf.id,pages:'1-11',copies:3,duplex:true}],content:33,sheets:18,fen:1500},
    {name:'两文件各 1 页双面独立起纸',items:[{fileId:image.id,pages:'all',copies:1,duplex:true},{fileId:secondImage.id,pages:'all',copies:1,duplex:true}],content:2,sheets:2,fen:100},
    {name:'99 页单面',items:[{fileId:pdf.id,pages:'1-99',copies:1,duplex:false}],content:99,sheets:99,fen:4950},
    {name:'99 页双面',items:[{fileId:pdf.id,pages:'1-99',copies:1,duplex:true}],content:99,sheets:50,fen:4460},
    {name:'1 页 99 份双面独立起纸',items:[{fileId:image.id,pages:'all',copies:99,duplex:true}],content:99,sheets:99,fen:4950}
  ];
  for(const example of examples){await t.test(example.name,async()=>{
    const created=h.data(await h.post(user,'/api/print/quotes',{items:example.items}),202);await runtime.files.waitForIdle();const quote=h.data(await user.request('GET','/api/print/quotes/'+created.id));assert.equal(quote.status,'ready',JSON.stringify(quote.error));assert.equal(quote.valid,true);assert.equal(quote.contentPages,example.content);assert.equal(quote.sheetCount,example.sheets);assert.equal(quote.totalAmountFen,example.fen);assert.equal(quote.deliveryFeeFen,0);assert.equal(quote.currency,'CNY');records.push({name:example.name,status:quote.status,contentPages:quote.contentPages,sheetCount:quote.sheetCount,totalAmountFen:quote.totalAmountFen});
  });}
  for(const [name,items,code] of [
    ['零明细内容页',[],'VALIDATION_ERROR'],
    ['50 页 2 份超过 99 内容页',[{fileId:pdf.id,pages:'1-50',copies:2,duplex:true}],'CONTENT_PAGE_LIMIT'],
    ['100 内容页拒绝',[{fileId:pdf.id,pages:'all',copies:1,duplex:true}],'CONTENT_PAGE_LIMIT'],
    ['零份数',[{fileId:image.id,pages:'all',copies:0,duplex:false}],'VALIDATION_ERROR'],
    ['小数份数',[{fileId:image.id,pages:'all',copies:1.5,duplex:false}],'VALIDATION_ERROR'],
    ['重复页码',[{fileId:pdf.id,pages:'1-3,3',copies:1,duplex:false}],'VALIDATION_ERROR'],
    ['越界页码',[{fileId:pdf.id,pages:'101',copies:1,duplex:false}],'VALIDATION_ERROR']
  ]){await t.test(name,async()=>{const result=await h.post(user,'/api/print/quotes',{items});assert.equal(result.status,400);assert.equal(result.body.error.code,code);records.push({name,status:result.status,errorCode:code});});}
  await t.test('本栋规则、价格不可篡改、同源生产版本和跨账号 404',async()=>{
    const quote=await h.quote(runtime,user,pdf,{pages:'1-2,100',copies:1,duplex:true});
    const before=await user.request('GET',`/api/print/quotes/${quote.id}/items/${quote.items[0].itemId}/preview?page=1`,undefined,{raw:true});
    let result=await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'other-dorm',room:'302'}}));assert.equal(result.status,400);assert.equal(result.body.error.code,'BUILDING_NOT_SUPPORTED');
    result=await h.post(user,'/api/orders',{...h.orderBody(quote),totalAmountFen:1});assert.equal(result.status,400);
    result=await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'local-dorm',room:'',contact:''}}));assert.equal(result.status,400);
    const order=h.data(await h.post(user,'/api/orders',h.orderBody(quote,{deliveryAddress:{buildingId:'local-dorm',room:'软件学生房间',contact:'',notes:'',receiptMethod:'handover'}})),201);
    const after=await user.request('GET',`/api/me/orders/${order.id}/items/${order.items[0].itemId}/file`,undefined,{raw:true});
    const operator=await admin.request('GET',`/api/admin/orders/${order.id}/items/${order.items[0].itemId}/print-file`,undefined,{raw:true});
    assert.equal(before.status,200);assert.equal(after.status,200);assert.equal(operator.status,200);
    assert.equal(before.headers.get('x-print-artifact-sha256'),after.headers.get('x-print-artifact-sha256'));assert.deepEqual(after.body,operator.body);assert.match(after.headers.get('cache-control'),/no-store/);
    assert.equal((await other.request('GET','/api/me/orders/'+order.id)).status,404);assert.equal((await other.request('GET',`/api/me/orders/${order.id}/items/${order.items[0].itemId}/file`,undefined,{raw:true})).status,404);
    records.push({name:'Student production preview / student PDF / operator PDF',sameSha256:true,samePdfBytes:true,sourceOver99Selected:true,roomNotNumeric:true,emptyContact:true,otherAccountStatus:404});
  });
  await fs.mkdir(EVIDENCE,{recursive:true});await fs.writeFile(path.join(EVIDENCE,'api-pricing-report.json'),JSON.stringify({kind:'B-guest-pricing-real-api-test',at:new Date().toISOString(),records,realPayment:false,realPrinting:false},null,2));
});
