'use strict';
module.exports=function({schemas,spec,add,obj,str,en,integer,bool,id,time,nullable,ref,list,param}){
  const reasons=require('../../backend/orders/reasons'),version=integer(1),nullableTime=nullable(time),stage=en(['pending_acceptance','in_progress','paused','completed','cancelled']);
  const receiptMethod=en(['handover','contact_first','doorstep','other']);
  Object.assign(schemas.DeliveryInput.properties,{receiptMethod,receiptNote:str(500)});
  schemas.DeliveryInput.required.push('receiptMethod');
  schemas.DeliveryInput.description='新单必选 receiptMethod，缺失不猜测；contact_first 必须有 contact，other 必须有 receiptNote；notes 兼容保留。旧订单快照原样只读。';
  Object.assign(schemas.DeliveryAddress.properties,{receiptMethod,receiptNote:str(500)});
  Object.assign(schemas.OrderInput.properties,{acceptedRules:{...bool,deprecated:true,description:'兼容旧布尔值，不创建新的确认事实；可省略。'}});
  schemas.OrderInput.required=schemas.OrderInput.required.filter(k=>k!=='acceptedRules');
  schemas.SubmissionInput.properties.reference=str(160);schemas.SubmissionInput.required=schemas.SubmissionInput.required.filter(k=>k!=='reference');
  schemas.PaymentSubmission.properties.reference=str(160);
  const publicFields={advertisementsEnabled:bool,receiptMethods:list(obj({code:receiptMethod,label:str(40,1)}))};
  for(const name of ['PrintConfig','Settings']){Object.assign(schemas[name].properties,publicFields);schemas[name].required.push(...Object.keys(publicFields));}
  const pauseCode=en(['financial','coupon','refund_pending','fulfillment','refund_stopped','workflow','production_failed','delivery_failed','cancellation','fully_refunded','files_unavailable']);
  schemas.Fulfillment=obj({stage,acceptedAt:nullableTime,completedAt:nullableTime,pauseReasons:list(obj({code:pauseCode,label:str(100,1),reasonCode:nullable(str(100,1)),note:nullable(str(1000))},['code','label'])),allowedActions:list(en(['review_payment','confirm_delivered','pause_fulfillment','resolve_fulfillment_pause']))});
  for(const name of ['OwnerOrder','RecoveredOrder']){schemas[name].properties.fulfillment=ref('Fulfillment');schemas[name].required.push('fulfillment');}
  schemas.Dashboard.properties.fulfillmentCounts=obj(Object.fromEntries(stage.enum.map(k=>[k,integer()])));schemas.Dashboard.required.push('fulfillmentCounts');
  for(const name of ['OwnerTicket','RecoveredTicket']){schemas[name].properties.category=en(name==='OwnerTicket'?['order','general']:['order']);schemas[name].required.push('category');}
  schemas.OwnerTicket.properties.orderId=nullable(id);schemas.OwnerTicket.properties.orderNo=nullable(str(80,1));
  schemas.GeneralFeedbackInput=obj({message:str(4000,1),contactType:nullable(en(['phone','wechat'])),contactValue:nullable({...str(120,1),writeOnly:true})},['message']);
  const reasonEntry=obj({code:str(100,1),label:str(100,1),requiresText:bool});
  schemas.ReasonCatalog=obj({operations:{type:'object',additionalProperties:list(reasonEntry)},textMaxLength:integer(1000,1000),legacyTextSupported:bool});
  const reasonFields=operation=>({reasonCode:en(reasons.catalog().operations[operation].map(x=>x.code)),reasonText:str(1000)});
  function form(original,operation,field='note'){
    const fields=reasonFields(operation),modern=obj({...original.properties,...fields},[...original.required.filter(k=>k!==field),'reasonCode']);
    if(modern.properties[field])modern.properties[field]={...str(1000),deprecated:true};
    modern.description='原因代码按操作目录；other 的 reasonText 必填，其他可补充。';
    return {oneOf:[original,modern],description:'旧客户端可仅交自由文本，原样保留为 legacyReason；新表单交 reasonCode/reasonText，不猜测历史代码。'};
  }
  const operations={PaymentReviewInput:{resolve_exception:'payment_resolve_exception'},ProductionInput:Object.fromEntries(['progress','fail','retry','resume','reprint','reprint_progress','reprint_fail','reprint_retry'].map(k=>[k,'production_'+k])),DeliveryActionInput:{fail:'delivery_fail',retry:'delivery_retry'},RefundInput:Object.fromEntries(['request','approve','reject','paid_out'].map(k=>[k,'refund_'+k]))};
  for(const [name,mapping] of Object.entries(operations))schemas[name].oneOf=schemas[name].oneOf.map(branch=>{const action=branch.properties.action.enum[0];return mapping[action]?form(branch,mapping[action],name==='RefundInput'&&action==='request'?'reason':'note'):branch;});
  schemas.CancelInput=form(schemas.CancelInput,'cancel_request','reason');
  schemas.CouponDisableInput=form(schemas.CouponDisableInput,'coupon_disable');
  schemas.CouponResolutionInput=form(schemas.CouponResolutionInput,'coupon_continue');
  schemas.FulfillmentInput={oneOf:[
    obj({expectedVersion:version,action:en(['delivered']),actualDeliveryConfirmed:{type:'boolean',enum:[true]},note:str(1000)},['expectedVersion','action','actualDeliveryConfirmed']),
    obj({expectedVersion:version,action:en(['pause']),...reasonFields('fulfillment_pause')},['expectedVersion','action','reasonCode']),
    obj({expectedVersion:version,action:en(['resume']),pauseCode:en(['workflow','fulfillment','refund_stopped','production_failed','delivery_failed']),independentCopiesConfirmed:bool,...reasonFields('fulfillment_resume')},['expectedVersion','action','pauseCode','reasonCode'])
  ]};
  add('get','/admin/reason-catalog','异常操作原因目录',{role:'admin',response:'ReasonCatalog'});
  add('post','/admin/orders/{id}/fulfillment-action','合并履约的送达、暂停与逐项恢复',{role:'admin',request:'FulfillmentInput',response:'Order',idem:true,description:'正常 delivered 只要求真实交付确认，不伪造打印事件；首次送达原子设置完成及七天期限。同键同体重试返回原结果。pause/resume 用原因表单；resume 仅解除 pauseCode 指定的一项，不能解除财务、券、退款等待或取消限制。恢复 production_failed 还必须 independentCopiesConfirmed=true。旧失败和完成记录保留。'});
  add('post','/me/feedback','提交无订单的一般反馈',{role:'user',request:'GeneralFeedbackInput',response:'Ticket',code:201,idem:true,description:'message 必填，联系选填；不接受 orderId 或 feedbackType。主题从内容摘要生成；仅当前有效身份及管理员可见，不提供独立找回码。列表/详情/回复复用 tickets，category=general，orderId/orderNo=null。学生响应不含 contactValue。'});
  add('get','/admin/tickets/{id}','订单售后或一般反馈详情',{role:'admin',response:'Ticket'});
  for(const route of ['/me/tickets','/admin/tickets'])spec.paths[route].get.parameters.push(param('category',en(['order','general'])));
  for(const route of ['/me/orders','/admin/orders'])spec.paths[route].get.parameters.push(param('fulfillmentStage',stage));
  spec.paths['/orders'].post.description='confirmedPreview=true 为唯一必须主动确认；acceptedRules 可省略，旧布尔值兼容但不制造确认事实。新接收方式必选并条件验证。报价、金额/券/文件绑定及幂等原子校验保持。';
  spec.paths['/admin/users'].get.description='仅 role=admin，搜索与分页也固定管理员范围。role 等未支持参数拒绝，旧账号和访客记录保留。';
  spec.paths['/admin/orders/{id}/payment-review'].post.description+=' 准确实收与可行接单同一事务：无暂停时 acceptedAt 记录实际接单时间；存在暂停时 payment.status=confirmed、fulfillment.stage=paused，acceptedAt 保持空。不能把此响应当作已放行履约。';
  spec.paths['/admin/orders/{id}/delivery-action'].post.description='兼容入口也使用同一送达校验；不再要求逐步制造打印完成和开始配送事实，所有暂停/资金/并发限制仍校验。';
  spec.paths['/me/orders/{id}/payment-submissions'].post.description+=' reference 可省略或空字符串，保留为空，不使用订单号代替交易号；商户实收 reference 仍必填并跨单去重。';
  spec.paths['/admin/settings'].patch.description='只提交目标字段及 expectedVersion，营业切换用目标布尔值；失败/丢响应先 GET 重读，不盲目反转。';
  for(const name of ['AdvertisementConfig','AdvertisementAdmin']){schemas[name].properties.enabled=bool;schemas[name].required.push('enabled');}
  for(const [route,methods] of Object.entries(spec.paths))if(route.includes('/advertisements'))for(const operation of Object.values(methods))operation.description+=' ADVERTISEMENTS_ENABLED 默认 false。公共列表 200 enabled=false/items=[]；所有图片及管理接口在既有鉴权/CSRF后返回403 ADVERTISEMENTS_DISABLED。保留素材和配置；隔离开启才恢复能力。';
  spec.info.version='1.3.0';spec.info.description='两步履约、独立暂停及原因表单、接收方式、可选声明参考、无订单反馈、管理员范围与默认停用广告。计价版本1.1.0，旧事实保留。';
};
