'use strict';
const assert=require('node:assert/strict');
const h=require('../../tests/business/helpers');
const m=require('../../tests/business/merchant-helpers');
module.exports=async function({runtime,spec,validate,user,admin}) {
  const check=(route,method,response,code=200)=>{h.data(response,code);validate(response.body,spec.paths[route][method].responses[String(code)].content['application/json'].schema);return response.body.data;};
  let settings;
  for(const channel of ['wechat','alipay']){
    settings=check('/admin/payment-qr/{channel}','post',await m.image(admin,'/api/admin/payment-qr/'+channel));
    const binary=await user.request('GET','/api/public/payment-qr/'+channel,undefined,{raw:true});assert.equal(binary.status,200);assert.equal(binary.headers.get('content-type'),'image/png');
  }
  const value=await h.order(runtime,user);
  const submitted=check('/me/orders/{id}/payment-submissions','post',await h.post(user,`/api/me/orders/${value.id}/payment-submissions`,{expectedVersion:value.version,channel:'alipay',reference:'契约软件声明'}));assert.equal(submitted.payment.lastSubmittedChannel,'alipay');
  const ticket=check('/me/orders/{id}/tickets','post',await h.post(user,`/api/me/orders/${value.id}/tickets`,{feedbackType:'payment_refund',subject:'契约结构化售后',message:'隔离接口验证',contactType:'wechat',contactValue:'wx_contract_software'}),201);assert(!Object.hasOwn(ticket,'contactValue'));
  const tickets=check('/admin/tickets','get',await admin.request('GET','/api/admin/tickets?feedbackType=payment_refund'));assert.equal(tickets.items[0].contactValue,'wx_contract_software');
  check('/admin/payment-qr/{channel}','delete',await admin.request('DELETE','/api/admin/payment-qr/alipay',{expectedVersion:settings.version}));
  check('/public/advertisements','get',await user.request('GET','/api/public/advertisements'));
  let ads=check('/admin/advertisements','post',await m.image(admin,'/api/admin/advertisements',{kind:'advertisement'}),201);
  const id=ads.items[0].id;
  ads=check('/admin/advertisements/{id}','patch',await admin.request('PATCH',`/api/admin/advertisements/${id}`,{expectedVersion:ads.version,enabled:false,altText:'契约广告'}));
  ads=check('/admin/advertisements/{id}/image','post',await m.image(admin,`/api/admin/advertisements/${id}/image`,{kind:'advertisement',version:ads.version}));
  assert.equal((await user.request('GET',`/api/public/advertisements/${id}/image`)).status,404);
  assert.equal((await admin.request('GET',`/api/admin/advertisements/${id}/image`,undefined,{raw:true})).status,200);
  ads=check('/admin/advertisements/{id}','patch',await admin.request('PATCH',`/api/admin/advertisements/${id}`,{expectedVersion:ads.version,enabled:true}));
  ads=check('/admin/advertisements','patch',await admin.request('PATCH','/api/admin/advertisements',{expectedVersion:ads.version,order:[id],intervalSeconds:2}));
  check('/public/advertisements','get',await user.request('GET','/api/public/advertisements'));
  assert.equal((await user.request('GET',`/api/public/advertisements/${id}/image`,undefined,{raw:true})).status,200);
  check('/admin/advertisements','get',await admin.request('GET','/api/admin/advertisements'));
  check('/admin/advertisements/{id}','delete',await admin.request('DELETE',`/api/admin/advertisements/${id}`,{expectedVersion:ads.version}));
  return 'Live dual-channel QR, declaration/channel timestamps, ticket contact projection/filter, all advertisement JSON and binary operations';
};
