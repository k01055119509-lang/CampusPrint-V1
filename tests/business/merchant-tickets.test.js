'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {isolated,Client}=require('../helpers/runtime');
const h=require('./helpers');
const m=require('./merchant-helpers');
test('五类售后及联系方式：授权投影、筛选、旧请求、幂等和跨单隔离',async t=>{
  const runtime=await isolated();t.after(()=>runtime.destroy());const {user,other,admin}=await h.actors(runtime);
  const order=await h.order(runtime,user),second=await h.order(runtime,user),recovered=new Client(runtime);await recovered.guest();
  const code=h.data(await user.request('GET',`/api/me/orders/${order.id}/query-code`)).queryCode;h.data(await recovered.request('POST','/api/orders/recover',{queryCode:code}));
  const types=['print_quality','content_quantity','delivery','payment_refund','other'],tickets=[];
  for(const feedbackType of types){
    const body={feedbackType,subject:'软件反馈分类',message:'隔离软件售后内容',...(feedbackType==='print_quality'?{contactType:'phone',contactValue:'000-TEST-ONLY'}:feedbackType==='delivery'?{contactType:'wechat',contactValue:'wx_test_only_contact'}:{})};
    const key=h.key(),response=await h.post(user,`/api/me/orders/${order.id}/tickets`,body,key),ticket=h.data(response,201);tickets.push(ticket);
    assert.equal(ticket.feedbackType,feedbackType);assert(!Object.hasOwn(ticket,'contactValue'));assert(!JSON.stringify(ticket).includes('test_only_contact'));
    assert.deepEqual((await h.post(user,`/api/me/orders/${order.id}/tickets`,body,key)).body,response.body);
    const adminList=h.data(await admin.request('GET','/api/admin/tickets?feedbackType='+feedbackType));assert.equal(adminList.total,1);assert.equal(adminList.items[0].feedbackType,feedbackType);
    assert.equal(adminList.items[0].contactValue,body.contactValue||null);
    const read=h.data(await recovered.request('GET',`/api/me/tickets/${ticket.id}`));assert(!Object.hasOwn(read,'contactValue'));assert(!Object.hasOwn(read,'userId'));assert(read.updates.every(u=>!Object.hasOwn(u,'authorId')));
    assert.equal((await other.request('GET',`/api/me/tickets/${ticket.id}`)).status,404);
  }
  assert.equal(runtime.db.get('SELECT COUNT(*) n FROM order_refunds').n,0);assert.equal(runtime.db.get('SELECT COUNT(*) n FROM payment_receipts').n,0);
  const legacy=h.data(await h.post(recovered,`/api/me/orders/${order.id}/tickets`,{subject:'旧客户端',message:'兼容旧请求'}),201);assert.equal(legacy.feedbackType,'other');assert.equal(legacy.contactType,null);assert.equal(legacy.contactProvided,false);
  const updated=h.data(await h.post(admin,`/api/admin/tickets/${tickets[0].id}/updates`,{expectedVersion:tickets[0].version,message:'软件经营者回复',status:'in_progress'}));assert.equal(updated.contactValue,'000-TEST-ONLY');
  const list=h.data(await user.request('GET','/api/me/tickets'));assert(list.items.every(item=>!Object.hasOwn(item,'contactValue')));
  const ownerRead=h.data(await user.request('GET',`/api/me/tickets/${tickets[0].id}`));assert(!Object.hasOwn(ownerRead,'contactValue'));
  for(const body of [{feedbackType:'invalid'},{feedbackType:null},{contactType:'phone'},{contactValue:'test'},{contactType:'email',contactValue:'test'},{contactType:'phone',contactValue:'  '},{contactType:'wechat',contactValue:'bad\ncontact'},{message:'  '},{subject:''}]){
    assert.equal((await h.post(user,`/api/me/orders/${order.id}/tickets`,{feedbackType:'other',subject:'软件',message:'测试',...body})).status,400);
  }
  assert.equal((await h.post(other,`/api/me/orders/${order.id}/tickets`,{subject:'越权',message:'拒绝'})).status,404);
  assert.equal((await h.post(recovered,`/api/me/orders/${second.id}/tickets`,{subject:'跨单',message:'拒绝'})).status,404);
  assert.equal((await user.request('GET','/api/me/tickets?feedbackType=other')).status,400);
  assert.equal((await admin.request('GET','/api/admin/tickets?feedbackType=invalid')).status,400);
  const blank=h.data(await h.post(user,`/api/me/orders/${order.id}/tickets`,{feedbackType:'other',subject:'选填为空',message:'软件测试',contactType:null,contactValue:null}),201);assert.equal(blank.contactProvided,false);
  await m.evidence('merchant-tickets',{types:types,createdTickets:runtime.db.get('SELECT COUNT(*) n FROM order_tickets').n,ownerContactHidden:true,recoveredContactHidden:true,adminContactVerified:true,filteredTypesVerified:true,legacyRequestFeedbackType:legacy.feedbackType,paymentFeedbackDidNotRefund:true});
});
