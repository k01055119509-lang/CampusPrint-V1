'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const parser = require('@apidevtools/swagger-parser');
const { isolated, Client, PROJECT, TEST_PASSWORD } = require('../../tests/helpers/runtime');
const h = require('../../tests/business/helpers');
const c = require('../../tests/business/coupon-helpers');
function validate(value,schema,location='$') {
  if(value===null){assert(schema.nullable,location+': null not allowed');return;}
  if(schema.oneOf){let matches=0;for(const branch of schema.oneOf)try{validate(value,branch,location);matches++;}catch{}assert.equal(matches,1,location+': oneOf');return;}
  if(schema.enum)assert(schema.enum.includes(value),location+': enum '+value);
  if(schema.type==='object'){
    assert(value&&typeof value==='object'&&!Array.isArray(value),location+': object');
    for(const key of schema.required||[])assert(Object.hasOwn(value,key),location+': required '+key);
    for(const [key,item] of Object.entries(value)){if(schema.properties?.[key])validate(item,schema.properties[key],location+'.'+key);else if(schema.additionalProperties===false)assert.fail(location+': unexpected '+key);else if(typeof schema.additionalProperties==='object')validate(item,schema.additionalProperties,location+'.'+key);}
  }else if(schema.type==='array'){assert(Array.isArray(value),location+': array');if(schema.minItems!==undefined)assert(value.length>=schema.minItems);if(schema.maxItems!==undefined)assert(value.length<=schema.maxItems);value.forEach((item,i)=>validate(item,schema.items,location+'['+i+']'));}
  else if(schema.type==='integer'){assert(Number.isSafeInteger(value),location+': integer');if(schema.minimum!==undefined)assert(value>=schema.minimum);if(schema.maximum!==undefined)assert(value<=schema.maximum);}
  else if(schema.type==='boolean')assert.equal(typeof value,'boolean',location);
  else if(schema.type==='string'){assert.equal(typeof value,'string',location);if(schema.minLength!==undefined)assert(value.length>=schema.minLength);if(schema.maxLength!==undefined)assert(value.length<=schema.maxLength);if(schema.pattern)assert(new RegExp(schema.pattern).test(value),location+': pattern');if(schema.format==='date-time')assert(!Number.isNaN(Date.parse(value)),location+': time');}
}
async function main(){
  for(const name of ['base.yaml','print.yaml','openapi.yaml'])await parser.validate(path.join(PROJECT,'contracts',name));
  const spec=await parser.dereference(path.join(PROJECT,'contracts/openapi.yaml'));
  const runtime=await isolated({studentAccountsEnabled:true,advertisementsEnabled:true});const checks=[];
  try{
    const documented=Object.entries(spec.paths).flatMap(([route,methods])=>Object.keys(methods).filter(method=>['get','post','patch','delete'].includes(method)).map(method=>`${method.toUpperCase()} /api${route}`));
    const actual=runtime.routes.map(row=>`${row.method} ${row.path.replace(/:([A-Za-z0-9_]+)/g,'{$1}')}`);
    assert.deepEqual([...actual].sort(),[...documented].sort());checks.push('All real operations match aggregate contract');
    for(const row of runtime.routes){const route=row.path.slice(4).replace(/:([A-Za-z0-9_]+)/g,'{$1}'),operation=spec.paths[route][row.method.toLowerCase()];assert.deepEqual(operation['x-roles'],row.role==='session'?['user','admin']:row.role?[row.role]:[]);assert(operation.parameters.some(p=>p.name==='X-CP-Surface'));for(const auth of operation.security)assert(!Object.hasOwn(auth,'SessionCookie'));}
    checks.push('Roles and independent surface cookie/CSRF schemes match runtime');
    const {user,admin}=await h.actors(runtime);
    const base=await parser.dereference(path.join(PROJECT,'contracts/base.yaml'));
    const foundationOperations=Object.values(base.paths).reduce((sum,methods)=>sum+Object.keys(methods).filter(method=>['get','post','patch','delete'].includes(method)).length,0);
    for(const [route,client] of [['/public/config',user],['/me/security-questions',user],['/print/config',user],['/me/print-defaults',user],['/admin/settings',admin],['/admin/dashboard',admin],['/admin/users',admin],['/admin/tickets',admin],['/me/orders',user],['/me/tickets',user]]){
      const response=await client.request('GET','/api'+route);h.data(response);validate(response.body,spec.paths[route].get.responses['200'].content['application/json'].schema);checks.push('Live response schema: '+route);
    }
    const securityQuestions=require('../../backend/routes/account-security').questions.slice(0,3).map((q,i)=>({questionId:q.id,answer:'contract answer '+i}));
    const configured=await user.request('POST','/api/me/security-questions',{expectedVersion:0,currentPassword:TEST_PASSWORD,questions:securityQuestions});h.data(configured);validate(configured.body,spec.paths['/me/security-questions'].post.responses['200'].content['application/json'].schema);
    const changed=await user.request('POST','/api/me/password',{expectedVersion:1,answers:securityQuestions.map(q=>q.answer),newPassword:'Contract9'});h.data(changed);validate(changed.body,spec.paths['/me/password'].post.responses['200'].content['application/json'].schema);checks.push('Live security question setup and verified password change schemas');
    const source=await h.upload(runtime,user);let quote=await h.quote(runtime,user,source);validate({success:true,data:quote},spec.paths['/print/quotes/{id}'].get.responses['200'].content['application/json'].schema);
    let order=h.data(await h.post(user,'/api/orders',h.orderBody(quote)),201);validate({success:true,data:order},spec.paths['/orders'].post.responses['201'].content['application/json'].schema);
    h.data(await h.paymentQr(admin));order=await h.confirm(admin,order);order=await h.delivered(admin,order);
    order=await h.action(admin,order,'refunds',{action:'request',amountFen:50,reason:'契约软件退款'});const refundId=order.refunds[0].id;order=await h.action(admin,order,'refunds',{action:'approve',refundId,note:'软件批准',fulfillmentDecision:'stop'});order=await h.action(admin,order,'refunds',{action:'paid_out',refundId,note:'软件记款',fulfillmentDecision:'stop',payoutReference:'CONTRACT-REFUND-TEST',actualRefundConfirmed:true});
    validate({success:true,data:order},spec.paths['/admin/orders/{id}'].get.responses['200'].content['application/json'].schema);checks.push('Live quote/order/receipt/refund/event schemas');
    const ticket=h.data(await h.post(user,`/api/me/orders/${order.id}/tickets`,{subject:'契约售后',message:'软件测试'}),201);validate({success:true,data:ticket},spec.paths['/me/orders/{id}/tickets'].post.responses['201'].content['application/json'].schema);checks.push('Live ticket schema');
    const failure=await h.post(user,'/api/orders',{...h.orderBody(quote),totalAmountFen:1});validate(failure.body,spec.paths['/orders'].post.responses['400'].content['application/json'].schema);checks.push('Live error schema');
    checks.push(await require('./check-merchant-contract')({runtime,spec,validate,user,admin}));
    checks.push(await require('./check-workflow-contract')({runtime,spec,validate,user,admin}));
    checks.push(await require('./check-cancellation-contract')({runtime,spec,validate,user,admin}));
    const guestRuntime=await isolated();
    try{
      const owner=new Client(guestRuntime),restored=new Client(guestRuntime),operator=new Client(guestRuntime);
      const guest=await owner.guest();validate(guest.body,spec.paths['/auth/guest'].post.responses['200'].content['application/json'].schema);await restored.guest();await operator.admin();
      const disabledAds=await owner.request('GET','/api/public/advertisements');h.data(disabledAds);validate(disabledAds.body,spec.paths['/public/advertisements'].get.responses['200'].content['application/json'].schema);assert.equal(disabledAds.body.data.enabled,false);assert.equal((await operator.request('GET','/api/admin/advertisements')).body.error.code,'ADVERTISEMENTS_DISABLED');
      for(const [route,client] of [['/public/config',owner],['/auth/me',owner],['/auth/me',operator],['/admin/users',operator]]){const response=await client.request('GET','/api'+route);h.data(response);validate(response.body,spec.paths[route].get.responses['200'].content['application/json'].schema);}
      const owned=await h.order(guestRuntime,owner);validate({success:true,data:owned},spec.paths['/orders'].post.responses['201'].content['application/json'].schema);
      const revealed=await owner.request('GET',`/api/me/orders/${owned.id}/query-code`);assert.equal(revealed.status,200);validate(revealed.body,spec.paths['/me/orders/{id}/query-code'].get.responses['200'].content['application/json'].schema);
      const adminCode=await operator.request('GET',`/api/admin/orders/${owned.id}/query-code`);assert.equal(adminCode.status,200);validate(adminCode.body,spec.paths['/admin/orders/{id}/query-code'].get.responses['200'].content['application/json'].schema);
      const recovered=await restored.request('POST','/api/orders/recover',{queryCode:revealed.body.data.queryCode});assert.equal(recovered.status,200);validate(recovered.body,spec.paths['/orders/recover'].post.responses['200'].content['application/json'].schema);
      const ticket=h.data(await h.post(restored,`/api/me/orders/${owned.id}/tickets`,{subject:'查询码契约售后',message:'隔离验证'}),201);validate({success:true,data:ticket},spec.paths['/me/orders/{id}/tickets'].post.responses['201'].content['application/json'].schema);
      for(const [route,documentedRoute] of [[`/me/orders/${owned.id}`,'/me/orders/{id}'],['/me/orders','/me/orders'],[`/me/orders/${owned.id}/tickets`,'/me/orders/{id}/tickets'],[`/me/tickets/${ticket.id}`,'/me/tickets/{id}']]){const response=await restored.request('GET','/api'+route);h.data(response);validate(response.body,spec.paths[documentedRoute].get.responses['200'].content['application/json'].schema);}
      const disabled=await owner.request('GET','/api/me/security-questions');assert.equal(disabled.status,403);validate(disabled.body,spec.paths['/me/security-questions'].get.responses['403'].content['application/json'].schema);
      checks.push('Default guest/identity/query-code/recovered order/ticket/disabled-account live schemas');
      let instant=guestRuntime.config.clock();guestRuntime.config.clock=()=>new Date(instant);
      const batch=await h.post(operator,'/api/admin/coupon-batches',{type:'discount',payRatePercent:85,quantity:2,expiresAt:new Date(instant.getTime()+1000).toISOString()});h.data(batch,201);validate(batch.body,spec.paths['/admin/coupon-batches'].post.responses['201'].content['application/json'].schema);
      const couponIds=batch.body.data.coupons.map(row=>row.id),reveal=await operator.request('POST','/api/admin/coupons/reveal-codes',{couponIds});assert.equal(reveal.status,200);validate(reveal.body,spec.paths['/admin/coupons/reveal-codes'].post.responses['200'].content['application/json'].schema);
      const listed=await operator.request('GET','/api/admin/coupons?state=available&batchId='+batch.body.data.batchId);h.data(listed);validate(listed.body,spec.paths['/admin/coupons'].get.responses['200'].content['application/json'].schema);
      const couponQuote=await c.quote(guestRuntime,owner,await h.upload(guestRuntime,owner),reveal.body.data.items[0].code);validate({success:true,data:couponQuote},spec.paths['/print/quotes/{id}'].get.responses['200'].content['application/json'].schema);assert.equal(couponQuote.totalAmountFen,43);
      let couponOrder=h.data(await h.post(owner,'/api/orders',h.orderBody(couponQuote)),201);validate({success:true,data:couponOrder},spec.paths['/orders'].post.responses['201'].content['application/json'].schema);
      const orderCode=h.data(await owner.request('GET',`/api/me/orders/${couponOrder.id}/query-code`)).queryCode;
      const recoveredCoupon=await restored.request('POST','/api/orders/recover',{queryCode:orderCode});h.data(recoveredCoupon);validate(recoveredCoupon.body,spec.paths['/orders/recover'].post.responses['200'].content['application/json'].schema);
      instant=new Date(instant.getTime()+1000);couponOrder=await h.confirm(operator,couponOrder);validate({success:true,data:couponOrder},spec.paths['/admin/orders/{id}'].get.responses['200'].content['application/json'].schema);assert.equal(couponOrder.couponException.hold,true);
      const continued=await h.post(operator,`/api/admin/orders/${couponOrder.id}/coupon-resolution`,{expectedVersion:couponOrder.version,action:'continue',note:'契约隔离验证：认可原优惠'});h.data(continued);validate(continued.body,spec.paths['/admin/orders/{id}/coupon-resolution'].post.responses['200'].content['application/json'].schema);
      const hidden=await operator.request('POST','/api/admin/coupons/reveal-codes',{couponIds});assert.equal(hidden.status,200);validate(hidden.body,spec.paths['/admin/coupons/reveal-codes'].post.responses['200'].content['application/json'].schema);assert(!Object.hasOwn(hidden.body.data.items[0],'code'));
      const stopped=await h.post(operator,`/api/admin/coupons/${couponIds[1]}/disable`,{expectedVersion:1,note:'契约隔离停用'});h.data(stopped);validate(stopped.body,spec.paths['/admin/coupons/{id}/disable'].post.responses['200'].content['application/json'].schema);
      const invalid=await h.post(owner,'/api/print/quotes',{items:[{fileId:(await h.upload(guestRuntime,owner)).id,pages:'all',copies:1,duplex:false}],couponCode:'invalid'});assert.equal(invalid.body.error.code,'COUPON_INVALID');validate(invalid.body,spec.paths['/print/quotes'].post.responses['400'].content['application/json'].schema);
      checks.push('Live batch/list/reveal/disable, discounted quote/order/recovered DTO, expiry receipt and resolution schemas');
    }finally{await guestRuntime.destroy();}
    const report={kind:'cancellation-notice-live-OpenAPI-verification',version:spec.info.version,validated:['base.yaml','print.yaml','openapi.yaml'],matchedOperations:documented.length,foundationOperations,businessOperations:documented.length-foundationOperations,checks,fullCodesRecorded:false};
    const output=process.env.CP_VERIFICATION_DIR ? path.resolve(process.env.CP_VERIFICATION_DIR,'contract-report.json') : path.join(PROJECT,'tmp/workflow-contract/contract-report.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await runtime.destroy();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={validate};
