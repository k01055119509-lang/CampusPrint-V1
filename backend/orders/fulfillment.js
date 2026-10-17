'use strict';
const v=require('../validation');
const {invalid,conflict}=require('../errors');
const r=require('./rules');
const reasons=require('./reasons');
class FulfillmentService {
  constructor(orders){this.orders=orders;}
  pauses(row,availability){
    const o=this.orders,items=[];
    const add=(code,label,extra={})=>items.push({code,label,...extra});
    if(row.financialHold)add('financial','财务异常待核实');
    if(o.coupons.hold(row.id))add('coupon','优惠券异常待处理');
    if(o.pendingRefund(row.id))add('refund_pending','退款申请待处理');
    if(row.fulfillmentHold)add('fulfillment','履约暂停');
    if(row.refundFulfillmentHold)add('refund_stopped','退款处理要求暂停履约');
    if(row.workflowHold)add('workflow','制作或配送异常',{reasonCode:row.workflowHoldReasonCode,note:row.workflowHoldNote});
    if(row.productionStatus==='failed')add('production_failed','打印失败待处理');
    if(row.deliveryStatus==='failed')add('delivery_failed','配送失败待处理');
    if(row.lifecycle==='cancel_requested')add('cancellation','取消申请待处理');
    if(row.paymentStatus==='confirmed'&&(o.receipt(row.id)?.amountFen||0)<=o.paidRefunds(row.id))add('fully_refunded','实收已全额退款');
    if(availability!=='available')add('files_unavailable','打印文件已不可用');
    return items;
  }
  canDeliver(row,availability){return this.orders.fulfillmentAllowed(row)&&!this.pauses(row,availability).length;}
  snapshot(row,actor,availability,accessType){
    const pauseReasons=this.pauses(row,availability);
    const stage=row.lifecycle==='cancelled'?'cancelled':row.lifecycle==='completed'?'completed':pauseReasons.length?'paused':row.paymentStatus==='confirmed'?'in_progress':'pending_acceptance';
    const allowedActions=[];
    if(actor.role==='admin'){
      if(!['completed','cancelled'].includes(row.lifecycle)&&!this.orders.receipt(row.id)&&row.paymentStatus!=='confirmed')allowedActions.push('review_payment');
      if(this.canDeliver(row,availability))allowedActions.push('confirm_delivered');
      if(row.lifecycle==='active'&&row.paymentStatus==='confirmed'&&!row.workflowHold)allowedActions.push('pause_fulfillment');
      if(row.lifecycle==='active'&&pauseReasons.some(p=>['workflow','production_failed','delivery_failed'].includes(p.code)||(['fulfillment','refund_stopped'].includes(p.code)&&(this.orders.receipt(row.id)?.amountFen||0)>this.orders.paidRefunds(row.id))))allowedActions.push('resolve_fulfillment_pause');
    }
    return {stage,acceptedAt:row.acceptedAt,completedAt:row.completedAt,
      pauseReasons:accessType==='recovered'?pauseReasons.map(({code,label})=>({code,label})):pauseReasons,allowedActions};
  }
  action(req){
    const o=this.orders;
    return o.idempotent(req,`fulfillment:${req.params.id}`,()=>{
      const row=o.owned(req.user,req.params.id);o.requestVersion(row,req);
      const action=v.choice(req.body.action,['delivered','pause','resume'],'action');
      v.keys(req.body,['expectedVersion','action',...(action==='delivered'?['actualDeliveryConfirmed','note']:['reasonCode','reasonText',...(action==='resume'?['pauseCode','independentCopiesConfirmed']:[])])]);
      if(action==='delivered')return this.deliver(req,row,'fulfillment_delivered');
      if(row.lifecycle!=='active')conflict('当前订单不能更改履约暂停');
      const reason=reasons.parse(req.body,`fulfillment_${action}`,'note',{requiredCode:true}),data={reasonCode:reason.code,reasonText:reason.text};
      if(action==='pause'){
        if(row.paymentStatus!=='confirmed')conflict('未核款订单不能进入制作配送处理');
        if(row.workflowHold)conflict('已有制作配送异常，请先处理当前原因');
        return o.update(row,req.user,'fulfillment_paused',{workflowHold:1,workflowHoldReasonCode:reason.code,workflowHoldNote:reason.text},data);
      }
      const pauseCode=v.choice(req.body.pauseCode,['workflow','fulfillment','refund_stopped','production_failed','delivery_failed'],'pauseCode');
      if(req.body.independentCopiesConfirmed!==undefined)r.bool(req.body.independentCopiesConfirmed,'independentCopiesConfirmed');
      const columns={workflow:'workflowHold',fulfillment:'fulfillmentHold',refund_stopped:'refundFulfillmentHold'};
      let changes;
      if(columns[pauseCode]){
        if(!row[columns[pauseCode]])conflict('该暂停原因已解除或不存在');
        if(['fulfillment','refund_stopped'].includes(pauseCode)&&(o.receipt(row.id)?.amountFen||0)<=o.paidRefunds(row.id))conflict('全额实际退款后不能恢复履约');
        changes={[columns[pauseCode]]:0,...(pauseCode==='workflow'?{workflowHoldReasonCode:null,workflowHoldNote:null}:{})};
      }else{
        const column=pauseCode==='production_failed'?'productionStatus':'deliveryStatus';
        if(row[column]!=='failed')conflict('该异常已解除或不存在');
        if(column==='productionStatus'&&req.body.independentCopiesConfirmed!==true)invalid('independentCopiesConfirmed','恢复打印前须核对已完成部分，避免重复打印');
        changes={[column]:column==='productionStatus'?'not_started':'pending'};
      }
      const next={...row,...changes};
      if(!row.acceptedAt&&this.canDeliver(next,o.availability(next)))changes.acceptedAt=o.now();
      return o.update(row,req.user,'fulfillment_resumed',changes,{...data,pauseCode});
    });
  }
  deliver(req,row,event){
    const o=this.orders;
    if(req.body.actualDeliveryConfirmed!==true)invalid('actualDeliveryConfirmed','必须确认已按用户选择的方式实际交付');
    if(!this.canDeliver(row,o.availability(row)))conflict('当前付款、暂停、取消或履约状态不允许确认送达');
    if(row.completedAt)conflict('送达时间已记录，不能重算');
    const note=r.optional(req.body.note,'note',1000),completedAt=o.now(),filesExpireAt=new Date(Date.parse(completedAt)+7*86400000).toISOString();
    o.files.setOrderFileExpiry({orderId:row.id,expiresAt:filesExpireAt});
    return o.update(row,req.user,event,{deliveryStatus:'delivered',lifecycle:'completed',completedAt,filesExpireAt},{note});
  }
}
module.exports={FulfillmentService};
