'use strict';
const v=require('../validation'),r=require('./rules');
const {ApiError,invalid,conflict,missing}=require('../errors');
const COMPENSATION_POLICY=Object.freeze({id:'merchant_cancellation_v1',type:'discount',payRatePercent:90,minPrintAmountFen:0,maxDiscountFen:200,validDays:30});
const MERCHANT_REASONS=Object.freeze({cannot_print:'无法完成打印',merchant_unavailable:'经营方无法履约'});
const RETURN_REASONS=Object.freeze({not_received:'未查到到账',amount_mismatch:'金额不符',channel_mismatch:'付款渠道不符'});
class CancellationService {
  constructor(orders){this.o=orders;}
  declared(id){return !!this.o.db.get('SELECT 1 FROM payment_submissions WHERE orderId=? LIMIT 1',id);}
  pending(row){return this.o.db.get("SELECT * FROM cancellation_requests WHERE orderId=? AND status='requested'",row.id);}
  origin(request){return request?.origin||'legacy';}
  blocked(row){
    const o=this.o;
    if(o.receipt(row.id))return 'receipt_recorded';
    if(row.paymentStatus==='confirmed')return 'payment_status_inconsistent';
    if(row.financialHold||o.db.get('SELECT 1 FROM financial_exceptions WHERE orderId=? AND resolvedAt IS NULL',row.id))return 'financial_exception_pending';
    if(o.pendingRefund(row.id))return 'refund_pending';
    if(!['active','cancel_requested'].includes(row.lifecycle))return 'order_ended';
    if(row.productionStatus==='printing'||row.reprintActive)return 'production_in_progress';
    return null;
  }
  assert(row){const reason=this.blocked(row);if(reason)throw new ApiError(409,'ORDER_CANCELLATION_BLOCKED','当前订单不支持取消；已记录收款的订单请通过售后处理',{reason});}
  userAllowed(row){return !this.blocked(row)&&row.lifecycle==='active'&&row.productionStatus==='not_started'&&!row.acceptedAt;}
  snapshot(row,actor,accessType){
    const o=this.o,pending=this.pending(row),latest=pending||o.db.get('SELECT * FROM cancellation_requests WHERE orderId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1',row.id);
    const receiptRecorded=!!o.receipt(row.id),hasPaymentDeclaration=this.declared(row.id);
    let blockedReason=this.blocked(row);
    if(!blockedReason&&row.lifecycle==='cancel_requested')blockedReason='cancellation_pending';
    if(!blockedReason&&(row.productionStatus!=='not_started'||row.acceptedAt))blockedReason='order_in_progress';
    const requestMode=accessType==='recovered'||!this.userAllowed(row)?'unavailable':hasPaymentDeclaration?'review':'direct';
    const merchantActions=[];
    if(actor.role==='admin'){
      if(row.lifecycle==='active'&&!this.blocked(row))merchantActions.push('cancel');
      if(row.lifecycle==='cancel_requested'&&pending){if(!this.blocked(row))merchantActions.push('approve');merchantActions.push('reject');}
    }
    return {requestMode,hasPaymentDeclaration,receiptRecorded,origin:latest?this.origin(latest):null,hiddenFromMerchant:!!row.hiddenFromMerchant,merchantActions,blockedReason:accessType==='recovered'&&!blockedReason?'owner_required':blockedReason};
  }
  returnReason(row){
    if(row.paymentStatus!=='rejected')return null;
    const event=this.o.db.get("SELECT createdAt,dataJson FROM order_events WHERE orderId=? AND type='payment_rejected' ORDER BY seq DESC LIMIT 1",row.id);
    const code=event&&JSON.parse(event.dataJson).reasonCode;
    return code&&RETURN_REASONS[code]?{code,label:RETURN_REASONS[code],returnedAt:event.createdAt}:null;
  }
  compensation(row,actor,accessType){
    const o=this.o,issued=o.db.get('SELECT * FROM order_compensations WHERE orderId=?',row.id);if(!issued)return null;
    const coupon=o.coupons.row(issued.couponId);
    return {couponId:coupon.id,type:issued.type,payRatePercent:issued.payRatePercent,minPrintAmountFen:issued.minPrintAmountFen,maxDiscountFen:issued.maxDiscountFen,issuedAt:issued.issuedAt,expiresAt:issued.expiresAt,state:coupon.state,isExpired:coupon.expiresAt<=o.now(),disabled:!!coupon.disabledAt,canViewCode:accessType!=='recovered'&&(actor.role==='admin'||actor.id===row.userId)&&coupon.state!=='redeemed'};
  }
  reveal(req){
    const o=this.o,{row}=o.access.resolve(req.user,req.params.id,req.session,'compensation_code');
    const issued=o.db.get('SELECT couponId FROM order_compensations WHERE orderId=?',row.id);if(!issued)missing();
    const coupon=o.coupons.row(issued.couponId);
    return {orderId:row.id,couponId:coupon.id,code:coupon.state==='redeemed'?null:coupon.code,unavailableReason:coupon.state==='redeemed'?'redeemed':null};
  }
  complete(row,actor,{request=null,origin,reason,reasonCode=null,compensate=false,hidden=false,source}){
    const o=this.o;if(!o.db.inTransaction)throw Error('Cancellation requires a transaction');
    this.assert(row);
    if(compensate&&origin!=='merchant')invalid('compensate','用户取消申请不支持发放商家补偿');
    const requestId=request?.id||o.requestCancellation(row,actor,reason,origin),now=o.now();
    o.db.run("UPDATE cancellation_requests SET status='approved',resolvedAt=?,resolvedBy=?,resolution=? WHERE id=? AND status='requested'",now,actor.id,reason,requestId);
    const originalCouponReleased=!!o.db.get("SELECT 1 FROM coupons WHERE reservedOrderId=? AND state='reserved'",row.id);
    o.coupons.release(row.id,actor.id,{source,automated:hidden});
    const exception=o.coupons.exceptionRow(row.id);
    if(exception?.hold){o.db.run("UPDATE order_coupon_exceptions SET hold=0,resolution='cancel',resolvedAt=?,resolvedBy=?,resolutionNote=? WHERE orderId=?",now,actor.id,reason,row.id);o.coupons.recordHistory(row.id,'cancel',JSON.parse(exception.reasonsJson),actor.id,reason);}
    if(compensate)o.coupons.issueCompensation(row.id,actor.id,COMPENSATION_POLICY);
    return o.update(row,actor,hidden?'user_cancelled_direct':origin==='merchant'?'merchant_cancelled':'cancel_resolved',{lifecycle:'cancelled',hiddenFromMerchant:hidden?1:0},{action:'approve',requestId,origin,source,reason,reasonCode,compensate,originalCouponReleased,compensation:this.compensation(row,actor,actor.role==='admin'?'admin':'owner')});
  }
  userRequest(req){
    const o=this.o;o.access.resolve(req.user,req.params.id,req.session,'cancel');
    return o.idempotent(req,`cancel_request:${req.params.id}`,()=>{
      const row=o.owned(req.user,req.params.id);o.version(row,req.body.expectedVersion);this.assert(row);
      if(!this.userAllowed(row))throw new ApiError(409,'ORDER_CANCELLATION_BLOCKED','订单当前不能发起取消',{reason:row.lifecycle==='cancel_requested'?'cancellation_pending':'order_in_progress'});
      // Validate old request shapes, but derive the new reason/source from the real actor.
      if(req.body.reason!==undefined||req.body.reasonCode!==undefined||req.body.reasonText!==undefined)o.reason(req,'cancel_request','reason');
      const reason='用户取消';
      if(!this.declared(row.id))return this.complete(row,req.user,{origin:'user',reason,reasonCode:'user_cancelled',hidden:true,source:'user_direct'});
      const requestId=o.requestCancellation(row,req.user,reason,'user');
      return o.update(row,req.user,'cancel_requested',{lifecycle:'cancel_requested'},{requestId,origin:'user',reason,reasonCode:'user_cancelled'});
    });
  }
  merchantResolution(req){
    const o=this.o;
    if(req.body.action==='request')throw new ApiError(410,'MERCHANT_CANCEL_REQUEST_REMOVED','商家取消已改为一次确认，请使用 action=cancel',{action:'cancel'});
    return o.idempotent(req,`cancel_resolution:${req.params.id}`,()=>{
      const row=o.owned(req.user,req.params.id);o.version(row,req.body.expectedVersion);
      const action=v.choice(req.body.action,['cancel','approve','reject'],'action');
      if(action==='cancel'){
        v.keys(req.body,['expectedVersion','action','reasonCode','compensate']);this.assert(row);
        if(row.lifecycle!=='active')conflict('请处理已有取消申请');
        const reasonCode=v.choice(req.body.reasonCode,Object.keys(MERCHANT_REASONS),'reasonCode'),compensate=req.body.compensate===undefined?false:r.bool(req.body.compensate,'compensate');
        return this.complete(row,req.user,{origin:'merchant',reason:MERCHANT_REASONS[reasonCode],reasonCode,compensate,source:'merchant_direct'});
      }
      const request=this.pending(row);if(row.lifecycle!=='cancel_requested'||!request)conflict('没有待处理取消申请');
      const origin=this.origin(request);
      v.keys(req.body,['expectedVersion','action',...(action==='approve'&&origin==='merchant'?['compensate']:[])]);
      if(action==='approve')return this.complete(row,req.user,{request,origin,reason:origin==='user'?'同意用户取消':'同意历史取消申请',compensate:req.body.compensate===undefined?false:r.bool(req.body.compensate,'compensate'),source:'merchant_review'});
      // Rejecting an old request is always available, including received orders;
      // only lifecycle changes. Every independent hold and receipt is preserved.
      const reason=o.receipt(row.id)||row.paymentStatus==='confirmed'?'已记录收款，不支持取消':'不同意取消申请';
      o.db.run("UPDATE cancellation_requests SET status='rejected',resolvedAt=?,resolvedBy=?,resolution=? WHERE id=? AND status='requested'",o.now(),req.user.id,reason,request.id);
      return o.update(row,req.user,'cancel_resolved',{lifecycle:'active'},{action:'reject',requestId:request.id,origin,reason});
    });
  }
}
module.exports={CancellationService,COMPENSATION_POLICY,MERCHANT_REASONS,RETURN_REASONS};
