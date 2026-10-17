'use strict';
module.exports=function({schemas,spec,add,obj,str,en,integer,bool,id,time,nullable,ref,list}){
  const version=integer(1),origin=nullable(en(['user','merchant','legacy'])),method=nullable(en(['handover','contact_first','doorstep','other']));
  const codes=['ORDER_CANCELLATION_BLOCKED','PAYMENT_AMOUNT_MISMATCH','FINANCIAL_EXCEPTION_RECORDING_REMOVED','MERCHANT_CANCEL_REQUEST_REMOVED','ORDER_HIDDEN_FROM_MERCHANT'];
  for(const code of codes)if(!schemas.BusinessError.properties.error.properties.code.enum.includes(code))schemas.BusinessError.properties.error.properties.code.enum.push(code);
  for(const name of ['PrintDefaults','PrintDefaultsPatch'])Object.assign(schemas[name].properties,{receiptMethod:method,receiptNote:str(500)});
  schemas.PrintDefaults.required.push('receiptMethod','receiptNote');
  schemas.PrintDefaultsPatch.description='按字段实际出现局部更新；省略不清空。receiptMethod 可空，不从 notes 猜测。contact_first 必须有 contact，other 必须有 receiptNote。结构化接收方式优先；notes 仅兼容旧说明，不能替代 receiptNote。';
  schemas.Cancellation.properties.origin=origin;schemas.Cancellation.required.push('origin');
  // Retain the explicit nullable object type. Private admin-only fields are
  // conditional, rather than applying nullable to an untyped oneOf wrapper.
  schemas.Receipt.required=['id','orderId','amountFen','channel','confirmedAt'];
  schemas.Receipt.description='可空实收摘要。学生仅含五个必填字段；reference/confirmedBy/note 只在管理员响应中存在，不能依赖它们向学生展示内部凭据。';
  schemas.AdminFinancialException=schemas.FinancialException;
  schemas.StudentFinancialException=obj(Object.fromEntries(['id','orderId','amountFen','createdAt','resolvedAt'].map(key=>[key,schemas.FinancialException.properties[key]])));
  schemas.FinancialException={oneOf:[ref('AdminFinancialException'),ref('StudentFinancialException')]};
  schemas.CancellationSummary=obj({requestMode:en(['direct','review','unavailable']),hasPaymentDeclaration:bool,receiptRecorded:bool,origin,hiddenFromMerchant:bool,merchantActions:list(en(['cancel','approve','reject'])),blockedReason:nullable(str(100,1))});
  schemas.Compensation=nullable(obj({couponId:id,type:en(['discount']),payRatePercent:integer(90,90),minPrintAmountFen:integer(0,0),maxDiscountFen:integer(200,200),issuedAt:time,expiresAt:time,state:en(['available','reserved','redeemed']),isExpired:bool,disabled:bool,canViewCode:bool}));
  schemas.PaymentReturnReason=nullable(obj({code:en(['not_received','amount_mismatch','channel_mismatch']),label:en(['未查到到账','金额不符','付款渠道不符']),returnedAt:time}));
  for(const name of ['OwnerOrder','RecoveredOrder']){const row=schemas[name];Object.assign(row.properties,{cancellation:ref('CancellationSummary'),compensation:ref('Compensation')});row.required.push('cancellation','compensation');row.properties.payment.properties.returnReason=ref('PaymentReturnReason');row.properties.payment.required.push('returnReason');}
  const branch=(action,fields={},required=[])=>obj({expectedVersion:version,action:en([action]),...fields},['expectedVersion','action',...required]);
  schemas.CancelInput=obj({expectedVersion:version,reason:str(1000,1),reasonCode:en(['user_cancelled','cannot_print','duplicate_order','other']),reasonText:str(1000)},['expectedVersion']);
  schemas.CancelInput.description='新客户端只交 expectedVersion；兼容合法旧原因输入但实际来源及新记录理由由服务端决定。曾提交声明（包括被退回）走审核，否则直接取消、自动释放原券并商户隐藏。已记录收款或保守财务冲突拒绝。';
  schemas.CancelResolutionInput={oneOf:[branch('cancel',{reasonCode:en(['cannot_print','merchant_unavailable']),compensate:{...bool,default:false}},['reasonCode']),branch('approve',{compensate:bool}),branch('reject')]};
  schemas.CancelResolutionInput.description='商家 cancel 一次完成；approve 的 compensate 仅真实旧商户申请允许，用户申请及 legacy 来源禁止。approve/reject 无原因文本或 noReceiptConfirmed/settlement。旧 action=request 固定410；所有批准必须无真实收款或财务矛盾。';
  const resolution=schemas.PaymentReviewInput.oneOf.find(b=>b.oneOf?.some(x=>x.properties?.action?.enum?.[0]==='resolve_exception')||b.properties?.action?.enum?.[0]==='resolve_exception');
  schemas.PaymentReviewInput={oneOf:[branch('confirm',{amountFen:integer(0,100000000),channel:en(['wechat','alipay','other']),reference:str(160,1),note:str(1000)},['amountFen','channel','reference']),branch('reject',{reasonCode:en(['not_received','amount_mismatch','channel_mismatch'])},['reasonCode']),resolution]};
  schemas.PaymentReviewInput.description='仅准确 confirm、固定原因 reject、既存异常 resolve_exception。flag_exception 不再是可成功动作，任意旧请求固定410且无业务写入；金额不符409，不生成异常/财务暂停。';
  schemas.Announcement=obj({enabled:bool,content:str(1000),version,updatedAt:nullable(time)});
  schemas.AnnouncementPatch=obj({expectedVersion:version,enabled:bool,content:str(1000)},['expectedVersion']);
  schemas.CompensationPolicy=obj({id:en(['merchant_cancellation_v1']),type:en(['discount']),payRatePercent:integer(90,90),minPrintAmountFen:integer(0,0),maxDiscountFen:integer(200,200),validDays:integer(30,30)});
  schemas.CompensationCode=obj({orderId:id,couponId:id,code:nullable({type:'string',pattern:'^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{25}$'}),unavailableReason:nullable(en(['redeemed']))});
  add('get','/public/announcement','仅读取已发布纯文字公告',{response:'Announcement',description:'匿名只读，不初始化访客。未发布 content 为空；独立于广告、营业及 serviceNotice。纯文本保留换行，客户端必须转义。'});
  add('get','/admin/announcement','读取公告及停用草稿',{role:'admin',response:'Announcement'});
  add('patch','/admin/announcement','独立版本编辑、发布或停用公告',{role:'admin',request:'AnnouncementPatch',response:'Announcement',description:'expectedVersion 必填且至少提供 enabled/content 一个；发布要求非空内容，停用保留草稿。只更新本公告。'});
  add('get','/admin/compensation-policy','读取固定商家取消补偿方案',{role:'admin',response:'CompensationPolicy',description:'固定只读；普通券默认7天不变，补偿券发放时独立25字符、连续30天。无编辑接口。'});
  add('get','/me/orders/{id}/compensation-code','所有者专用读取补偿完整码',{role:'user',response:'CompensationCode',description:'仅原所有者，受限恢复授权403、他人或未发放404。已核销 code=null/unavailableReason=redeemed；其他未核销券可读取，是否到期/停用看摘要。完整码不写普通DTO、事件、日志、幂等结果或URL。'});
  spec.paths['/me/orders/{id}/cancel-requests'].post.description=schemas.CancelInput.description;
  Object.assign(spec.paths['/admin/orders/{id}/cancel-resolution'].post,{summary:'商家单次取消或审核历史申请',description:schemas.CancelResolutionInput.description+' 旧已收款取消待处理只可拒绝，自动记录已收款原因且不解除其他暂停。'});
  Object.assign(spec.paths['/admin/orders/{id}/payment-review'].post,{summary:'准确核款、退回核对及处理旧财务异常',description:schemas.PaymentReviewInput.description+' reject 仅三个原因，不接收 note/reasonText/other；当前 rejected 订单返回最小 returnReason，重新声明后为空。准确收款/券核销原子提交，其他暂停不自动解除。'});
  spec.paths['/admin/orders/{id}/coupon-resolution'].post.description='continue 只解除券暂停。cancel 使用统一收款禁取消检查，未收款时单次完成商家取消或已有申请审核，不发补偿、不隐藏；实收、全额退款后及旧状态矛盾均不能绕过。';
  for(const route of ['/admin/orders','/admin/orders/{id}','/admin/dashboard'])spec.paths[route].get.description+=' 排除持久 hiddenFromMerchant=1 的新用户直接取消单；列表/搜索/总数/仪表盘同源。旧打开详情404 ORDER_HIDDEN_FROM_MERCHANT，请回列表。历史取消、商家取消及审核取消继续可见；售后关联保留。';
  for(const route of ['/admin/orders/{id}/payment-review','/admin/orders/{id}/cancel-resolution'])spec.paths[route].post.responses[410].description='旧新增动作已移除：FINANCIAL_EXCEPTION_RECORDING_REMOVED 或 MERCHANT_CANCEL_REQUEST_REMOVED；无业务写入。';
  spec.info.version='1.4.0';spec.info.description='独立公告、结构化接收默认、收款禁取消、用户直接取消自动退原券并隐藏商户列表、审核与商家补偿、固定核款退回及删除新增财务异常。价格规则1.1.0不变。';
};
