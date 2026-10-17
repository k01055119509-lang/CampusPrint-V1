'use strict';
const assert=require('node:assert/strict');
const h=require('../../tests/business/helpers');
module.exports=async function({runtime,spec,validate,user,admin}){
  const check=(route,method,response,code=200)=>{h.data(response,code);validate(response.body,spec.paths[route][method].responses[String(code)].content['application/json'].schema);return response.body.data;};
  const post=async(route,documentedRoute,body,client=admin,code=200)=>{
    validate(body,spec.paths[documentedRoute].post.requestBody.content['application/json'].schema);
    return check(documentedRoute,'post',await h.post(client,'/api'+route,body),code);
  };
  check('/admin/reason-catalog','get',await admin.request('GET','/api/admin/reason-catalog'));
  const feedback=await post('/me/feedback','/me/feedback',{message:'契约一般反馈',contactType:'wechat',contactValue:'contract-private-feedback'},user,201);assert.equal(feedback.orderId,null);assert(!Object.hasOwn(feedback,'contactValue'));
  check('/admin/tickets/{id}','get',await admin.request('GET','/api/admin/tickets/'+feedback.id));
  await post('/admin/tickets/'+feedback.id+'/updates','/admin/tickets/{id}/updates',{expectedVersion:1,message:'契约一般回复',status:'resolved'});
  check('/me/tickets/{id}','get',await user.request('GET','/api/me/tickets/'+feedback.id));
  check('/admin/tickets','get',await admin.request('GET','/api/admin/tickets?category=general&status=resolved'));
  let order=await h.order(runtime,user);
  order=await post('/admin/orders/'+order.id+'/payment-review','/admin/orders/{id}/payment-review',{expectedVersion:order.version,action:'reject',reasonCode:'not_received'});assert.equal(order.payment.status,'rejected');
  order=await post('/me/orders/'+order.id+'/payment-submissions','/me/orders/{id}/payment-submissions',{expectedVersion:order.version,channel:'wechat'},user);assert.equal(order.payment.submissions.at(-1).reference,'');
  order=await h.confirm(admin,order);assert.equal(order.fulfillment.stage,'in_progress');
  order=await post('/admin/orders/'+order.id+'/fulfillment-action','/admin/orders/{id}/fulfillment-action',{expectedVersion:order.version,action:'pause',reasonCode:'unreachable'});
  order=await post('/admin/orders/'+order.id+'/fulfillment-action','/admin/orders/{id}/fulfillment-action',{expectedVersion:order.version,action:'resume',pauseCode:'workflow',reasonCode:'issue_resolved'});
  order=await post('/admin/orders/'+order.id+'/fulfillment-action','/admin/orders/{id}/fulfillment-action',{expectedVersion:order.version,action:'delivered',actualDeliveryConfirmed:true});assert.equal(order.production.status,'not_started');assert.equal(order.fulfillment.stage,'completed');
  return 'Live reason catalog and structured reason input, general feedback/list/detail/reply, optional student reference, merged fulfillment pause/resume/delivery schemas';
};
