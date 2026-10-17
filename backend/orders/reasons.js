'use strict';
const v = require('../validation');
const { invalid } = require('../errors');
const GROUPS = {
  payment: { not_received:'未查到到账', amount_mismatch:'金额不符', channel_mismatch:'付款渠道不符' },
  merchant_cancellation: { cannot_print:'无法完成打印', merchant_unavailable:'经营方无法履约' },
  fulfillment: { print_problem:'打印问题', unreachable:'联系不上', room_incorrect:'房间信息有误', recipient_absent:'收件人不在', other:'其他' },
  cancellation: { user_cancelled:'用户取消', cannot_print:'无法完成打印', duplicate_order:'重复订单', other:'其他' },
  refund: { print_problem:'打印问题', delivery_problem:'配送问题', user_cancelled:'用户取消', duplicate_payment:'重复付款', other:'其他' },
  refund_decision: { verified_request:'已核实申请', unsupported_request:'申请不符', refund_completed:'已核实实际退款', other:'其他' },
  financial_resolution: { exact_receipt:'已核实准确到账', no_receipt:'已核实未到账', other:'其他' },
  coupon_resolution: { honor_discount:'认可原优惠', cancel_order:'转取消处理', other:'其他' },
  coupon_disable: { issued_in_error:'误发优惠券', campaign_ended:'活动结束', other:'其他' },
  resume: { issue_resolved:'问题已解决', verified_continue:'核实后继续', other:'其他' },
  reprint: { print_problem:'打印问题', content_quantity:'内容或份数不符', other:'其他' }
};
const OPERATIONS = {
  payment_reject:'payment', payment_resolve_exception:'financial_resolution',
  fulfillment_pause:'fulfillment', fulfillment_resume:'resume',
  production_fail:'fulfillment', production_retry:'resume', production_progress:'fulfillment', production_resume:'resume',
  production_reprint:'reprint', production_reprint_fail:'fulfillment', production_reprint_retry:'resume', production_reprint_progress:'fulfillment',
  delivery_fail:'fulfillment', delivery_retry:'resume', cancel_request:'cancellation',
  cancel_merchant:'merchant_cancellation',
  refund_request:'refund', refund_approve:'refund_decision', refund_reject:'refund_decision', refund_paid_out:'refund_decision',
  coupon_continue:'coupon_resolution', coupon_cancel:'coupon_resolution', coupon_disable:'coupon_disable'
};
function catalog() {
  return { operations:Object.fromEntries(Object.entries(OPERATIONS).map(([operation,group])=>[operation,Object.entries(GROUPS[group]).map(([code,label])=>({code,label,requiresText:code==='other'}))])),
    textMaxLength:1000, legacyTextSupported:true };
}
function parse(body,operation,legacyField='note',{requiredCode=false}={}) {
  const group=GROUPS[OPERATIONS[operation]];
  if(!group)throw new Error('Missing reason operation: '+operation);
  if(body.reasonCode===undefined){
    if(requiredCode||body.reasonText!==undefined)invalid('reasonCode','请选择适用于此操作的原因');
    // Compatibility for old clients: retain free text, never infer an enum.
    return {code:null,text:v.string(body[legacyField],legacyField,{min:1,max:1000}),legacy:true};
  }
  const code=v.choice(body.reasonCode,Object.keys(group),'reasonCode');
  const text=v.string(body.reasonText,'reasonText',{min:code==='other'?1:0,max:1000,fallback:''});
  if(body[legacyField]!==undefined) v.string(body[legacyField],legacyField,{max:1000});
  return {code,text,legacy:false,label:group[code]};
}
function text(reason){return reason.legacy?reason.text:reason.label+(reason.text?'：'+reason.text:'');}
module.exports={catalog,parse,text,GROUPS,OPERATIONS};
