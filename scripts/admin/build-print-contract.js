'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { DISPLAY_STATUSES, ORDER_ACTIONS } = require('../../backend/orders/rules');
const root = path.resolve(__dirname, '../..'), base = yaml.load(fs.readFileSync(path.join(root,'contracts/base.yaml'),'utf8'));
const obj = (properties, required = Object.keys(properties)) => ({ type:'object',additionalProperties:false,properties,...(required.length?{required}:{}) });
const str = (maxLength = 500, minLength = 0) => ({type:'string',minLength,maxLength});
const en = values => ({type:'string',enum:values});
const integer = (minimum=0,maximum=Number.MAX_SAFE_INTEGER) => ({type:'integer',minimum,maximum});
const bool = {type:'boolean'}, yes = {type:'boolean',enum:[true]}, id = {type:'string',format:'uuid'}, time = {type:'string',format:'date-time'}, nullableTime = {...time,nullable:true};
const hash = {type:'string',pattern:'^[a-f0-9]{64}$'}, nullableHash = {...hash,nullable:true}, nullableId = {...id,nullable:true};
const ref = name => ({$ref:'#/components/schemas/'+name});
const baseRef = name => ({$ref:'./base.yaml#/components/schemas/'+name});
const list = items => ({type:'array',items}), pageList = items => obj({items:list(items),page:integer(1,1000000),pageSize:integer(1,100),total:integer()});
const note = str(1000), requiredNote = str(1000,1), version = integer(1), channel = en(['wechat','alipay','other']), reference = str(160,1);
const nullable = schema => ({...schema,nullable:true});
const schemas = {
  BusinessError: obj({success:{type:'boolean',enum:[false]},error:obj({code:en([...base.components.schemas.Error.properties.error.properties.code.enum,
    'CONTENT_PAGE_LIMIT','BUILDING_NOT_SUPPORTED','ORDERS_PAUSED','PAYMENT_NOT_CONFIGURED','PAYMENT_ASSET_UNAVAILABLE','PAYMENT_CONFIGURATION_CHANGED','ADVERTISEMENT_LIMIT','ADVERTISEMENT_ASSET_UNAVAILABLE','ADVERTISEMENT_CONFIGURATION_CHANGED','QUOTE_PROCESSING','QUOTE_EXPIRED','QUOTE_ALREADY_USED','QUOTE_INVALID','QUOTE_PRICING_CHANGED','QUOTE_CONFIRMATION_MISMATCH','QUOTE_PREPARATION_FAILED','QUOTE_PREPARATION_TIMEOUT','IDEMPOTENCY_CONFLICT','VERSION_CONFLICT','TRANSACTION_ALREADY_RECORDED','REFUND_LIMIT','REFUND_TRANSACTION_ALREADY_RECORDED','COUPON_INVALID','COUPON_UNAVAILABLE','COUPON_THRESHOLD_NOT_MET','COUPON_ZERO_TOTAL','COUPON_EXCEPTION_PENDING']),message:str(2000),fields:{type:'object',additionalProperties:{type:'string'}}},['code','message'])}),
  BusinessFileError: nullable(obj({code:str(100),message:str(2000)})),
  PricingRules: obj({singleSidedSheetPriceFen:{type:'integer',enum:[50]},doubleSidedSheetPriceFen:{type:'integer',enum:[90]},oddTailSheetPriceFen:{type:'integer',enum:[50]}}),
  LegacyPricingRules: obj({unitSheetPriceFen:integer(1)}),
  Totals: obj({contentPages:integer(1,99),sheetCount:integer(1,99),pricingVersion:en(['1.1.0','legacy']),pricingRules:{oneOf:[ref('PricingRules'),ref('LegacyPricingRules')]},unitSheetPriceFen:integer(1),printAmountFen:integer(1,4950),discountAmountFen:integer(0,4949),deliveryFeeFen:{type:'integer',enum:[0]},totalAmountFen:integer(1,4950),currency:en(['CNY'])},['contentPages','sheetCount','pricingVersion','pricingRules','printAmountFen','discountAmountFen','deliveryFeeFen','totalAmountFen','currency']),
  PrintConfig: obj({paperSize:en(['A4']),colorMode:en(['black_white']),unitSheetPriceFen:{type:'integer',enum:[50],deprecated:true,description:'仅为原单面价格的兼容字段，不能用于新双面计价。'},pricingVersion:en(['1.1.0']),singleSidedSheetPriceFen:{type:'integer',enum:[50]},doubleSidedSheetPriceFen:{type:'integer',enum:[90]},oddTailSheetPriceFen:{type:'integer',enum:[50]},minContentPages:{type:'integer',enum:[1]},maxContentPages:{type:'integer',enum:[99]},deliveryFeeFen:{type:'integer',enum:[0]},currency:en(['CNY']),
    building:obj({id:en(['local-dorm']),label:str(80,1)}),acceptingOrders:bool,serviceNotice:str(2000),payment:obj({configured:bool,qrUrl:nullable(str(100)),instructions:str(1000)}),fileRetentionDaysAfterCompletion:{type:'integer',enum:[7]},temporaryUploadHours:{type:'integer',enum:[24]},quoteValiditySeconds:{type:'integer',enum:[900]},maxQuoteItems:{type:'integer',enum:[20]},uploadLimits:baseRef('UploadLimits'),maintenance:obj({enabled:bool,message:str(500),updatedAt:nullableTime})}),
  PrintDefaults: obj({buildingId:en(['local-dorm']),room:str(40),contact:str(120),notes:str(500),copies:integer(1,99),duplex:bool,updatedAt:nullableTime}),
  PrintDefaultsPatch: obj({buildingId:en(['local-dorm']),room:str(40),contact:str(120),notes:str(500),copies:integer(1,99),duplex:bool},[]),
  QuoteInput: obj({items:{...list(obj({fileId:id,pages:str(4000,1),copies:integer(1,99),duplex:bool})),minItems:1,maxItems:20},couponCode:{...str(256),writeOnly:true,description:'可选；空串不用券，25 有效字符；大小写、空白及分组连字符归一。完整码不进入报价或订单响应。'}},['items']),
  PrintItem: obj({itemId:id,fileId:id,originalName:str(180,1),sourceSha256:hash,sourcePageCount:integer(1,2000),pageNumbers:{...list(integer(1,2000)),minItems:1,maxItems:99,uniqueItems:true},selectedPageCount:integer(1,99),copies:integer(1,99),duplex:bool,contentPages:integer(1,99),sheetCount:integer(1,99),amountFen:integer(50,4950),paperSize:en(['A4']),colorMode:en(['black_white']),copiesInPdf:{type:'integer',enum:[1]},printArtifactId:nullableId,printArtifactSha256:nullableHash}),
  DeliveryInput: obj({buildingId:en(['local-dorm']),room:str(40,1),contact:str(120),notes:str(500)},['buildingId','room']),
  OrderInput: obj({quoteId:id,quoteFingerprint:hash,deliveryAddress:ref('DeliveryInput'),confirmedPreview:yes,acceptedRules:yes}),
  SubmissionInput: obj({expectedVersion:version,channel,reference,note:str(500)},['expectedVersion','channel','reference']),
  PaymentSubmission: obj({id,orderId:id,channel,reference,note:str(500),createdAt:time,submittedBy:id}),
  Receipt: nullable(obj({id,orderId:id,amountFen:integer(1,4950),channel,reference,confirmedAt:time,confirmedBy:id,note})),
  FinancialException: obj({id,orderId:id,amountFen:nullable(integer(0,100000000)),reason:requiredNote,reference,createdAt:time,createdBy:id,resolvedAt:nullableTime,resolvedBy:nullableId,resolution:nullable(note)}),
  Cancellation: obj({id,orderId:id,reason:requiredNote,status:en(['requested','approved','rejected']),createdAt:time,createdBy:id,resolvedAt:nullableTime,resolvedBy:nullableId,resolution:nullable(note)}),
  Refund: obj({id,orderId:id,status:en(['requested','approved','rejected','paid_out']),amountFen:integer(1,4950),reason:requiredNote,createdAt:time,createdBy:id,decidedAt:nullableTime,decidedBy:nullableId,decisionNote:nullable(note),paidAt:nullableTime,paidBy:nullableId,payoutReference:nullable(reference),fulfillmentDecision:nullable(en(['resume','stop'])),payoutNote:nullable(note)}),
  OrderEvent: obj({id,orderId:id,actorId:id,type:str(100,1),createdAt:time,data:{type:'object',description:'服务端写入的审计元数据：动作、原因、经办及结果版本；不含文件内容。',additionalProperties:true}}),
  TicketInput: obj({subject:str(120,1),message:str(4000,1)}),
  TicketUpdate: obj({id,authorId:id,message:str(4000,1),status:en(['open','in_progress','resolved']),createdAt:time}),
  Ticket: obj({id,orderId:id,userId:id,subject:str(120,1),status:en(['open','in_progress','resolved']),version,createdAt:time,updatedAt:time,orderNo:str(80,1),updates:list(ref('TicketUpdate'))}),
  TicketUpdateInput: obj({expectedVersion:version,message:str(4000,1),status:en(['open','in_progress','resolved'])}),
  CancelInput: obj({expectedVersion:version,reason:requiredNote}),
  SettingsPatch: obj({expectedVersion:version,buildingLabel:str(80,1),acceptingOrders:bool,serviceNotice:str(2000),paymentInstructions:str(1000),maintenance:obj({enabled:bool,message:str(500)},['enabled'])},['expectedVersion'])
};
schemas.DeliveryAddress=obj({...schemas.DeliveryInput.properties,buildingLabel:str(80,1)});
const couponRules={type:en(['discount','threshold']),minPrintAmountFen:integer(0,100000000),payRatePercent:nullable(integer(1,99)),maxDiscountFen:nullable(integer(1,100000000)),reductionFen:nullable(integer(1,100000000))};
schemas.CouponSnapshot=nullable(obj({id,maskedCode:{type:'string',pattern:'^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}-\\*{5}-\\*{5}-\\*{5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$'},...couponRules,expiresAt:time}));
schemas.CouponSummary=obj({...schemas.CouponSnapshot.properties,batchId:id,state:en(['available','reserved','redeemed']),version,createdAt:time,disabledAt:nullableTime,isExpired:bool,reservedOrderId:nullableId,redeemedAt:nullableTime});
schemas.CouponException=nullable(obj({hold:bool,reasons:{...list(en(['expired','disabled'])),minItems:1,maxItems:2,uniqueItems:true},detectedAt:time,resolution:nullable(en(['continue','cancel'])),resolvedAt:nullableTime}));
schemas.CouponExceptionHistory=obj({id,type:en(['detected','continue','cancel']),reasons:list(en(['expired','disabled'])),createdAt:time,actorId:nullableId,note:requiredNote});
const expiryInput={...nullableTime,description:'省略或 null 为自创建起 7×24 小时，指定时必须为未来 ISO 8601 时间。'};
const batchCommon={quantity:{...integer(1,100),default:1},expiresAt:expiryInput};
schemas.CouponBatchInput={oneOf:[obj({...batchCommon,type:en(['discount']),minPrintAmountFen:{...integer(0,100000000),default:0},payRatePercent:integer(1,99),maxDiscountFen:nullable(integer(1,100000000))},['type','payRatePercent']),obj({...batchCommon,type:en(['threshold']),minPrintAmountFen:integer(1,100000000),reductionFen:{...integer(1,100000000),description:'严格小于使用门槛；每单仅减一次。'}},['type','minPrintAmountFen','reductionFen'])]};
schemas.CouponBatch=obj({batchId:id,quantity:integer(1,100),expiresAt:time,coupons:list(ref('CouponSummary'))});
schemas.CouponRevealInput=obj({couponIds:{...list(id),minItems:1,maxItems:100,uniqueItems:true}});
schemas.CouponReveal=obj({items:list({oneOf:[obj({id,code:{type:'string',pattern:'^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{25}$',description:'仅管理员专用接口返回，不能写入 URL/日志/证据/截图；前端每五位分组。'}}),obj({id,unavailableReason:en(['redeemed'])})]})});
schemas.CouponDisableInput=obj({expectedVersion:version,note:requiredNote});
schemas.CouponResolutionInput=obj({expectedVersion:version,action:en(['continue','cancel']),note:requiredNote});
schemas.Quote=obj({id,status:en(['processing','ready','failed']),...schemas.Totals.properties,coupon:ref('CouponSnapshot'),items:list(ref('PrintItem')),createdAt:time,preparationDeadline:time,readyAt:nullableTime,expiresAt:nullableTime,fingerprint:nullableHash,error:ref('BusinessFileError'),valid:bool,invalidReason:nullable(str(100)),orderId:nullableId,allowedActions:list(en(['preview','create_order'])),preparedItemCount:integer(0,20)});
schemas.Quote.required=schemas.Quote.required.filter(key=>key!=='unitSheetPriceFen');
schemas.Order=obj({id,orderNo:str(80,1),userId:id,user:baseRef('User'),quoteId:id,version,createdAt:time,updatedAt:time,completedAt:nullableTime,items:list(ref('PrintItem')),totals:ref('Totals'),coupon:ref('CouponSnapshot'),couponException:ref('CouponException'),deliveryAddress:ref('DeliveryAddress'),
  payment:obj({status:en(['unpaid','submitted','confirmed','rejected']),configured:bool,submissions:list(ref('PaymentSubmission')),receipt:ref('Receipt'),exceptions:list(ref('FinancialException')),financialHold:bool}),
  production:obj({status:en(['not_started','printing','printed','failed']),completedContentPages:integer(0,99),attempt:integer(),reprintActive:bool,fulfillmentHold:bool}),delivery:obj({status:en(['pending','delivering','delivered','failed'])}),lifecycle:en(['active','cancel_requested','completed','cancelled']),displayStatus:en(DISPLAY_STATUSES),refunds:list(ref('Refund')),actualRefundFen:integer(0,4950),netReceivedFen:integer(0,4950),cancellationRequests:list(ref('Cancellation')),filesExpireAt:nullableTime,fileAvailability:en(['available','expired','deleted']),allowedActions:list(en(ORDER_ACTIONS)),events:list(ref('OrderEvent'))});
schemas.Order.properties.accessType=en(['owner','admin']); schemas.Order.required.push('accessType');
schemas.Order.properties.couponExceptionHistory=list(ref('CouponExceptionHistory'));
Object.assign(schemas.Order.properties.payment.properties,{qrUrl:nullable(str(100)),instructions:str(1000),lastSubmittedAt:nullableTime,confirmedAt:nullableTime});
schemas.Order.properties.payment.required.push('qrUrl','instructions','lastSubmittedAt','confirmedAt');
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
const imageUrl=nullable(str(200));
schemas.PaymentChannel=obj({channel:en(['wechat','alipay']),configured:{...bool,description:'有持久图片引用；实际可选还必须 available=true。'},available:bool,imageUrl});
schemas.LegacyPayment=obj({configured:bool,available:bool,imageUrl});
const paymentFields={channels:{...list(ref('PaymentChannel')),minItems:2,maxItems:2},legacy:ref('LegacyPayment')};
Object.assign(schemas.PrintConfig.properties.payment.properties,paymentFields);
schemas.PrintConfig.properties.payment.required.push(...Object.keys(paymentFields));
const orderPaymentFields={...paymentFields,lastSubmittedChannel:nullable(channel),confirmedChannel:nullable(channel)};
Object.assign(schemas.Order.properties.payment.properties,orderPaymentFields);
schemas.Order.properties.payment.required.push(...Object.keys(orderPaymentFields));
const feedbackType=en(['print_quality','content_quantity','delivery','payment_refund','other']);
Object.assign(schemas.TicketInput.properties,{feedbackType:{...feedbackType,description:'新界面必选；兼容旧请求省略时为 other。'},contactType:nullable(en(['phone','wechat'])),contactValue:nullable({...str(120,1),writeOnly:true})});
Object.assign(schemas.Ticket.properties,{feedbackType,contactType:nullable(en(['phone','wechat'])),contactProvided:bool,contactValue:nullable({...str(120,1),readOnly:true,description:'仅管理员响应返回。所有学生响应均省略，不从订单或账号补出。'})});
schemas.Ticket.required.push('feedbackType','contactType','contactProvided');
schemas.RecoveredPrintItem=obj(pick(schemas.PrintItem.properties,['itemId','originalName','pageNumbers','selectedPageCount','copies','duplex','contentPages','sheetCount','amountFen','paperSize','colorMode','copiesInPdf']));
schemas.RecoveredOrder=obj({...pick(schemas.Order.properties,['id','orderNo','version','createdAt','updatedAt','completedAt','lifecycle','displayStatus','filesExpireAt','fileAvailability','coupon','couponException']),accessType:en(['recovered']),items:list(ref('RecoveredPrintItem')),totals:ref('Totals'),payment:obj(pick(schemas.Order.properties.payment.properties,['status','configured','qrUrl','channels','legacy','instructions','lastSubmittedAt','lastSubmittedChannel','confirmedAt','confirmedChannel'])),production:obj(pick(schemas.Order.properties.production.properties,['status','completedContentPages'])),delivery:schemas.Order.properties.delivery,allowedActions:list(en(['view_tickets','create_ticket','submit_payment']))});
schemas.OwnerOrder=schemas.Order; schemas.Order={oneOf:[ref('OwnerOrder'),ref('RecoveredOrder')]};
schemas.RecoveredTicketUpdate=obj(pick(schemas.TicketUpdate.properties,['id','message','status','createdAt']));
schemas.RecoveredTicket=obj({...pick(schemas.Ticket.properties,['id','orderId','orderNo','subject','feedbackType','contactType','contactProvided','status','version','createdAt','updatedAt']),updates:list(ref('RecoveredTicketUpdate'))});
schemas.OwnerTicket=schemas.Ticket; schemas.Ticket={oneOf:[ref('OwnerTicket'),ref('RecoveredTicket')]};
schemas.QueryCodeInput=obj({queryCode:{type:'string',maxLength:256,writeOnly:true,description:'32 个安全随机有效字符；统一大写，去空白/连字符；无效或不存在统一 404 NOT_FOUND。'}});
schemas.QueryCode=obj({orderId:id,queryCode:{type:'string',pattern:'^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{32}$',description:'仅专用所有者/管理员接口返回，禁止缓存、日志和普通详情。'}});
schemas.UserWithOrders=obj({...base.components.schemas.User.properties,orderCount:integer()});
schemas.Settings=obj({version,...schemas.PrintConfig.properties,updatedAt:nullableTime,updatedBy:nullableId,paymentAssetCleanup:list(obj({assetId:id,attempts:integer(),lastError:nullable(str(100))}))});
schemas.Dashboard=obj({totalOrders:integer(),awaitingPaymentReview:integer(),awaitingPrint:integer(),awaitingDelivery:integer(),exceptions:integer(),confirmedReceivedFen:integer(),actualRefundFen:integer(),netReceivedFen:integer(),today:obj({date:{type:'string',format:'date'},confirmedReceivedFen:integer(),actualRefundFen:integer(),netReceivedFen:integer(-Number.MAX_SAFE_INTEGER)}),userCount:integer(),activeUsers:list(baseRef('User')),acceptingOrders:bool,paymentConfigured:bool,maintenance:schemas.PrintConfig.properties.maintenance,cleanup:baseRef('CleanupStatus')});
const actionSchema=(action,fields,required=Object.keys(fields))=>obj({expectedVersion:version,action:en([action]),...fields},['expectedVersion','action',...required]);
schemas.PaymentReviewInput={oneOf:[actionSchema('confirm',{amountFen:integer(0,100000000),channel,reference,note},['amountFen','channel','reference']),actionSchema('reject',{note:requiredNote}),actionSchema('flag_exception',{amountFen:integer(0,100000000),channel,reference,note:requiredNote}),actionSchema('resolve_exception',{note:requiredNote,resolutionOutcome:en(['exact_receipt','no_receipt'])},['note'])]};
schemas.ProductionInput={oneOf:[actionSchema('start',{note},[]),actionSchema('progress',{completedContentPages:integer(0,99),note:requiredNote}),actionSchema('fail',{completedContentPages:integer(0,99),note:requiredNote}),actionSchema('complete',{actualCompletionConfirmed:yes,note},['actualCompletionConfirmed']),actionSchema('retry',{note:requiredNote,independentCopiesConfirmed:yes}),actionSchema('resume',{note:requiredNote}),actionSchema('reprint',{note:requiredNote}),actionSchema('reprint_progress',{completedContentPages:integer(0,99),note:requiredNote}),actionSchema('reprint_fail',{completedContentPages:integer(0,99),note:requiredNote}),actionSchema('reprint_complete',{actualCompletionConfirmed:yes,note},['actualCompletionConfirmed']),actionSchema('reprint_retry',{note:requiredNote,independentCopiesConfirmed:yes})]};
schemas.DeliveryActionInput={oneOf:[actionSchema('start',{note},[]),actionSchema('fail',{note:requiredNote}),actionSchema('retry',{note:requiredNote}),actionSchema('delivered',{actualDeliveryConfirmed:yes,note},['actualDeliveryConfirmed'])]};
schemas.CancelResolutionInput={oneOf:[actionSchema('request',{note:requiredNote}),actionSchema('approve',{note:requiredNote,settlement:en(['retain_confirmed','refund_complete']),noReceiptConfirmed:{...bool,description:'占用未核销券释放时必须由管理员主动确认为 true；有实收/未解决财务事实时禁止。'}},['note']),actionSchema('reject',{note:requiredNote})]};
const fulfillmentDecision=en(['resume','stop']);
schemas.RefundInput={oneOf:[actionSchema('request',{amountFen:integer(1,4950),reason:requiredNote}),actionSchema('approve',{refundId:id,note:requiredNote,fulfillmentDecision}),actionSchema('reject',{refundId:id,note:requiredNote,fulfillmentDecision}),actionSchema('paid_out',{refundId:id,note:requiredNote,payoutReference:reference,actualRefundConfirmed:yes,fulfillmentDecision})]};
const spec={openapi:'3.0.3',info:{title:'CampusPrint Order and Operations API',version:'1.2.0',description:'营业状态、双渠道收款、结构化售后与图片广告。继承访客权限、1.1.0定价、优惠券及人工核款；UTC 时间、双端会话、CSRF、幂等与版本校验。'},servers:[{url:'/api'}],paths:{},components:{securitySchemes:base.components.securitySchemes,schemas}};
const param=(name,schema,where='query',required=false)=>({name,in:where,required,schema});
const pagination=[param('page',integer(1,1000000)),param('pageSize',integer(1,100))];
const orderFilters=[...pagination,param('q',str(120)),param('status',en(DISPLAY_STATUSES)),param('room',str(40,1)),param('from',time),param('to',time)];
const ticketFilters=[...pagination,param('status',en(['open','in_progress','resolved'])),param('orderId',id)];
const idempotency=param('Idempotency-Key',{type:'string',pattern:'^[A-Za-z0-9_.:-]{8,100}$'},'header',true);
function add(method,route,summary,{role=null,request,response,code=200,binary=null,parameters=[],idem=false,multipart=false,description=''}={}){
  const paths=[...route.matchAll(/\{(\w+)\}/g)].map(m=>param(m[1],m[1]==='channel'?en(['wechat','alipay']):id,'path',true));
  const success=binary?{description:'受控二进制，禁止缓存。预览页码是生产 PDF 的页码；下载始终只有一份已选内容。',headers:{'Cache-Control':{schema:str()},'X-Artifact-SHA256':{schema:hash},'X-Print-Artifact-SHA256':{schema:hash},'X-File-Expires-At':{schema:time}},content:{[binary]:{schema:{type:'string',format:'binary'}}}}:{description:'成功',content:{'application/json':{schema:obj({success:yes,data:typeof response==='string'?ref(response):response})}}};
  const responses={[code]:success};for(const status of [400,401,403,404,409,410,413,415,422,429,500,503]) responses[status]={description:({400:'参数、页数或配送楼栋无效',401:'未登录',403:'角色、来源或 CSRF 失败',404:'不存在或属于他人',409:'版本、幂等键、报价、财务或履约状态冲突',410:'文件已到期禁止读取或再生成',413:'上传/资源超过上限',415:'请求或文件格式不支持',422:'文件准备失败',429:'限流，稍后重试',500:'内部失败',503:'维护或存储/台账暂不可用'})[status],content:{'application/json':{schema:ref('BusinessError')}}};
  const write=!['get','head'].includes(method),surface=role==='admin'?'admin':'student',scheme=surface==='admin'?'AdminSessionCookie':'StudentSessionCookie',security=write?[{[scheme]:[],CsrfToken:[]}]:role?[{[scheme]:[]}]:[];
  const operation={operationId:method+'_'+route.replace(/[^a-zA-Z0-9]/g,'_'),summary,description,tags:[role==='admin'?'Operations':'Print'], 'x-roles':role?[role]:[], 'x-cp-surface':surface,security,parameters:[...paths,...parameters,param('X-CP-Surface',en([surface]),'header'),...(idem?[idempotency]:[])],responses};
  if(request) operation.requestBody={required:true,content:{[multipart?'multipart/form-data':'application/json']:{schema:typeof request==='string'?ref(request):request}}};
  (spec.paths[route]??={})[method]=operation;
}
add('get','/print/config','打印规则、本栋、接单及收款状态',{response:'PrintConfig'});
add('get','/me/print-defaults','个人默认项',{role:'user',response:'PrintDefaults'});add('patch','/me/print-defaults','保存以后使用的默认项',{role:'user',request:'PrintDefaultsPatch',response:'PrintDefaults'});
add('post','/print/quotes','计算报价及可选优惠并异步准备生产版本',{role:'user',request:'QuoteInput',response:'Quote',code:202,idem:true,description:'items 为 fileId/pages/copies/duplex；couponCode 可选，试算不占用。金额顶层含 pricingVersion/pricingRules/printAmountFen/discountAmountFen/deliveryFeeFen/totalAmountFen/coupon。整单含份数 1–99 页。轮询 ready 且 valid 后重新确认生产预览与金额。暂停接单或维护拒绝新报价。'});
add('get','/print/quotes/{id}','查询报价和有效期',{role:'user',response:'Quote',description:'首次 ready 起 900 秒。旧价格/缺少新规则返回 valid=false, invalidReason=QUOTE_PRICING_CHANGED，包括 processing 旧报价。券到期/停用/占用/核销返回 COUPON_UNAVAILABLE。订单金额快照不随状态变化。'});
add('get','/print/quotes/{id}/items/{itemId}/preview','付款前生产预览',{role:'user',binary:'image/png',parameters:[param('page',integer(1,99))]});
add('post','/orders','从有效且已确认的报价原子建单',{role:'user',request:'OrderInput',response:'Order',code:201,idem:true,description:'quoteFingerprint 原样提交。两个确认字段必须 true。不接受客户端金额/份数/状态。相同报价不可再次建单；相同幂等键同 body 返回原结果。'});
add('post','/orders/recover','查询码只恢复当前会话的指定订单',{role:'user',request:'QueryCodeInput',response:'Order',description:'需学生会话及 CSRF；IP/会话持久化限流；重复恢复不换身份、不续期。无效或不存在统一 404。只能明细、付款和该单售后。'});
for(const [prefix,role] of [['/me','user'],['/admin','admin']]){
  add('get',prefix+'/orders','分页查询订单',{role,response:pageList(ref('Order')),parameters:role==='admin'?[...orderFilters,param('userId',id)]:orderFilters});
  add('get',prefix+'/orders/{id}','订单完整详情、事实及允许动作',{role,response:'Order'});
  add('get',prefix+'/orders/{id}/query-code','仅读取该单查询码',{role,response:'QueryCode',description:'仅原所有者或管理员，Cache-Control: no-store；恢复访问者返回 403，陌生订单统一 404。不进入普通详情、URL 或幂等结果。'});
  add('get',prefix+'/orders/{id}/items/{itemId}/preview','订单生产预览',{role,binary:'image/png',parameters:[param('page',integer(1,99))]});
  add('get',prefix+'/orders/{id}/items/{itemId}/'+(role==='admin'?'print-file':'file'),'受控生产 PDF 下载',{role,binary:'application/pdf'});
}
add('post','/me/orders/{id}/payment-submissions','提交付款声明，等待人工核对',{role:'user',request:'SubmissionInput',response:'Order',idem:true,description:'只能声明所选且可读取的 wechat/alipay。other 仅兼容未归属历史单码。未配置 409 PAYMENT_NOT_CONFIGURED，不可读 PAYMENT_ASSET_UNAVAILABLE。旧成功请求同键重试返回原结果。声明仅变 submitted，不记款，不放行打印。'});
add('post','/admin/coupon-batches','幂等批量发行独立一次性兑换码',{role:'admin',request:'CouponBatchInput',response:'CouponBatch',code:201,idem:true,description:'默认1，上限100；默认7天，发行后规则和有效期固定。仅返回券 ID 与遮罩；全批次同一事务，不返回完整码到幂等结果。'});
add('get','/admin/coupons','分页券摘要与基础状态',{role:'admin',response:pageList(ref('CouponSummary')),parameters:[...pagination,param('type',en(['discount','threshold'])),param('state',en(['available','reserved','redeemed'])),param('batchId',id)],description:'state 是基础状态；到期/停用另看 isExpired/disabledAt。已占用券仍保留绑定。'});
add('post','/admin/coupons/reveal-codes','专用读取未核销完整码',{role:'admin',request:'CouponRevealInput',response:'CouponReveal',description:'1–100 个不同 ID；管理员及 CSRF，Cache-Control:no-store；不保存幂等响应，不进日志/URL。已占用、停用、过期但未核销可再读取，已核销返回 unavailableReason=redeemed 且无 code。'});
add('post','/admin/coupons/{id}/disable','停用未核销券并即时标记占用异常',{role:'admin',request:'CouponDisableInput',response:'CouponSummary',idem:true,description:'expectedVersion 为券版本，note 必填。保留基础状态与绑定，不改金额；仅支持停用，不能编辑/重新启用。'});
add('post','/admin/orders/{id}/coupon-resolution','逐单认可原优惠继续或进入取消核查',{role:'admin',request:'CouponResolutionInput',response:'Order',idem:true,description:'continue 仅解除券异常；财务、退款、原履约暂停独立。cancel 进入 cancel_requested，保留实收和券暂停，不直接完成取消。未处理新原因会再次暂停。动作入口检测在业务事务外持久化，expectedVersion 可使用该次入口检测前版本；原本已过期的旧版本仍冲突。'});
add('post','/me/orders/{id}/cancel-requests','生产前申请取消并锁定新履约',{role:'user',request:'CancelInput',response:'Order',idem:true});
add('post','/me/orders/{id}/tickets','创建关联订单售后',{role:'user',request:'TicketInput',response:'Ticket',idem:true,code:201,description:'新界面类型必选，旧请求省略类型兼容 other；subject/message 必填。联系方式 type/value 同时提供或同时为空；phone/wechat，仅该单后台可读完整内容。付款退款类仅建工单，不发起资金动作。'});
add('get','/me/orders/{id}/tickets','分页读取该单售后与回复',{role:'user',response:pageList(ref('Ticket')),parameters:[...pagination,param('status',en(['open','in_progress','resolved']))],description:'允许原所有者和当前会话已恢复该单；不暴露其他单工单。恢复 DTO 隐去用户与回复作者 ID。'});
add('get','/me/tickets','个人工单',{role:'user',response:pageList(ref('Ticket')),parameters:ticketFilters});add('get','/me/tickets/{id}','个人工单详情',{role:'user',response:'Ticket'});
add('get','/admin/dashboard','订单与收退款事实统计',{role:'admin',response:'Dashboard',description:'上海日期按 confirmedAt / paidAt 计算今日实际收退款。netReceivedFen 不是利润。完成文件清理不影响指标。'});
for(const [route,title,request,description] of [
  ['payment-review','人工确认、退回或记录财务异常','PaymentReviewInput','金额不等于应付时记录 exception 并 rejected，不生成 receipt。按准确金额确认后，原异常仍锁定直到 resolve_exception。resolutionOutcome 默认 exact_receipt；no_receipt 明确核实并无本单入账时解除异常，但不放行生产，也不删除任何已有 receipt。交易参考归一后全库唯一。'],
  ['production-action','记录实际生产与重试/售后重印','ProductionInput','正常履约须确认入账且无取消/退款/财务锁。失败与进度允许记录停机事实；恢复剩余履约需 resume + 原因。retry 必须 independentCopiesConfirmed=true。重印不改完成时间或期限。'],
  ['delivery-action','配送、失败、重试与实际送达','DeliveryActionInput','只有 printed 可配送。delivered 必须 actualDeliveryConfirmed=true，事务中首次 completedAt + 7×24h 并调用 A setOrderFileExpiry。'],
  ['cancel-resolution','经营端发起或处理取消','CancelResolutionInput','已开始生产可由经营端 request 锁定，先记录停机。approve 时须未结退款已处理、财务异常已解除。剩余实收须实际退回或 retain_confirmed + 人工结算依据。'],
  ['refunds','申请、批准、拒绝与记录实际退款','RefundInput','不执行转账。批准不等于已退回。requested/approved 保留额度，paid_out 累计不能超过实收。决定后续履约 resume/stop；全额实退不允许 resume。']
]) add('post','/admin/orders/{id}/'+route,title,{role:'admin',request,response:'Order',idem:true,description});
add('get','/admin/users','账号登录/活跃和关联订单数量',{role:'admin',response:pageList(ref('UserWithOrders')),parameters:[...pagination,param('q',str(120))]});
add('get','/admin/tickets','经营端工单列表与回复',{role:'admin',response:pageList(ref('Ticket')),parameters:[...ticketFilters,param('feedbackType',feedbackType)]});add('post','/admin/tickets/{id}/updates','回复和处理文字工单',{role:'admin',request:'TicketUpdateInput',response:'Ticket',idem:true,description:'expectedVersion 是工单版本。关闭工单不触发退款或改动 completedAt。'});
add('get','/admin/settings','经营设置及固定规则',{role:'admin',response:'Settings'});add('patch','/admin/settings','版本受控经营设置',{role:'admin',request:'SettingsPatch',response:'Settings'});
add('post','/admin/payment-qr','配置独立收款图片',{role:'admin',multipart:true,request:obj({file:{type:'string',format:'binary'}}),response:'Settings',parameters:[param('X-Settings-Version',str(20,1),'header',true)],description:'单个 file，无额外 multipart 字段；5 MiB 内 JPG/PNG，经 A 安全重编码为 PNG。X-Settings-Version 为当前 Settings.version；前后都检查版本。替换失败不覆盖旧配置。'});
add('delete','/admin/payment-qr','清除收款信息',{role:'admin',request:obj({expectedVersion:version}),response:'Settings'});
add('get','/public/payment-qr','仅读取当前明确配置的收款图片',{binary:'image/png',description:'正式初始为空，404 PAYMENT_NOT_CONFIGURED。该路由不访问学生文件；图片资产不受订单七天期限清理。'});
require('./merchant-contract')({schemas,add,obj,str,en,integer,bool,id,time,nullable,ref,list,param});
require('./workflow-contract')({schemas,spec,add,obj,str,en,integer,bool,id,time,nullable,ref,list,param});
require('./cancellation-contract')({schemas,spec,add,obj,str,en,integer,bool,id,time,nullable,ref,list,param});
fs.writeFileSync(path.join(root,'contracts/print.yaml'),yaml.dump(spec,{lineWidth:120,noRefs:true}));
const aggregate=yaml.load(fs.readFileSync(path.join(root,'contracts/openapi.yaml'),'utf8'));
aggregate.info={title:'CampusPrint V1 API',version:'1.4.0',description:spec.info.description};
aggregate.components.securitySchemes=base.components.securitySchemes;
for(const route of Object.keys(spec.paths)) aggregate.paths[route]={$ref:'./print.yaml#/paths/'+route.replaceAll('~','~0').replaceAll('/','~1')};
fs.writeFileSync(path.join(root,'contracts/openapi.yaml'),yaml.dump(aggregate,{lineWidth:120,noRefs:true}));
console.log(JSON.stringify({version:spec.info.version,paths:Object.keys(spec.paths).length,operations:Object.values(spec.paths).reduce((n,p)=>n+Object.keys(p).length,0)}));
