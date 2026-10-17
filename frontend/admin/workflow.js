import { L, esc, date } from './text.js';

let catalog;
export function setReasonCatalog(value) { catalog = value; }
const englishReasons = {
  not_received:'No receipt found', amount_mismatch:'Amount mismatch', channel_mismatch:'Channel mismatch', other:'Other',
  print_problem:'Printing problem', unreachable:'Cannot make contact', room_incorrect:'Incorrect room', recipient_absent:'Recipient absent',
  user_cancelled:'User cancellation', cannot_print:'Unable to print', merchant_unavailable:'Operator unable to fulfill', duplicate_order:'Duplicate order', delivery_problem:'Delivery problem',
  duplicate_payment:'Duplicate payment', verified_request:'Request verified', unsupported_request:'Request not supported', refund_completed:'Actual refund verified',
  exact_receipt:'Exact receipt verified', no_receipt:'No receipt verified', honor_discount:'Honor original discount', cancel_order:'Handle cancellation',
  issued_in_error:'Issued in error', campaign_ended:'Campaign ended', issue_resolved:'Issue resolved', verified_continue:'Verified to continue', content_quantity:'Content or copy count'
};
export function reasonFields(operation, { fixed=false }={}) {
  const options = catalog?.operations?.[operation];
  if (!options) throw new Error(L('原因选项尚未读取，请刷新页面后重试。','Reason options are unavailable. Refresh and retry.'));
  return `<fieldset class="reason-fields" data-reason-fields><legend>${L('处理原因','Handling reason')}</legend><label class="field"><span>${L('原因类型','Reason type')}</span><select name="reasonCode" required><option value="">${L('请选择原因','Choose a reason')}</option>${options.map(item=>`<option value="${esc(item.code)}" data-requires-text="${!!item.requiresText}">${esc(L(item.label,englishReasons[item.code]||item.label))}</option>`).join('')}</select></label>${fixed?'':`<label class="field"><span data-reason-text-label>${L('补充说明（选填）','Additional details (optional)')}</span><textarea name="reasonText" maxlength="${catalog.textMaxLength}"></textarea></label>`}</fieldset>`;
}
export function reasonBody(form) { return {reasonCode:form.get('reasonCode'),reasonText:form.get('reasonText')||''}; }
export function bindReasonForms(root) {
  root.querySelectorAll('[data-reason-fields]').forEach(group=>{
    const select=group.querySelector('[name=reasonCode]'), text=group.querySelector('[name=reasonText]');
    if(!text)return;
    const update=()=>{
      text.required=select.selectedOptions[0]?.dataset.requiresText==='true';
      group.querySelector('[data-reason-text-label]').textContent=text.required?L('补充说明（必填）','Additional details (required)'):L('补充说明（选填）','Additional details (optional)');
      text.setCustomValidity(text.required&&!text.value.trim()?L('请填写其他原因的具体说明。','Describe the other reason.'):'');
    };
    select.addEventListener('change',update); text.addEventListener('input',update); update();
  });
  const pause=root.querySelector('[name=pauseCode]'), copies=root.querySelector('[data-resume-copies]');
  if(pause&&copies){const update=()=>{copies.hidden=pause.value!=='production_failed';const input=copies.querySelector('input');input.disabled=copies.hidden;input.required=!copies.hidden;};pause.addEventListener('change',update);update();}
}
export const stageOptions = () => [['pending_acceptance',L('待接单','Awaiting acceptance')],['in_progress',L('制作与配送中','Making & delivering')],['paused',L('暂停','Paused')],['completed',L('已完成','Completed')],['cancelled',L('已取消','Cancelled')]];
export const stageLabel = stage => stageOptions().find(([code])=>code===stage)?.[1]||L('进度待刷新','Refresh progress');
export const stageBadge = order => `<span class="badge ${order.fulfillment.stage==='paused'?'problem':'attention'}" data-fulfillment-stage="${esc(order.fulfillment.stage)}">${esc(stageLabel(order.fulfillment.stage))}</span>`;
export function eventReason(event) {
  if(event.data.note||event.data.reason)return event.data.note||event.data.reason;
  if(!event.data.reasonCode)return event.data.reasonText||'';
  const option=Object.values(catalog?.operations||{}).flat().find(item=>item.code===event.data.reasonCode);
  const label=option?L(option.label,englishReasons[option.code]||option.label):'';
  return [label,event.data.reasonText].filter(Boolean).join('：');
}
const pauseEnglish={financial:'Financial review pending',coupon:'Coupon exception pending',refund_pending:'Refund request pending',fulfillment:'Fulfillment paused',refund_stopped:'Refund handling paused fulfillment',workflow:'Making or delivery issue',production_failed:'Printing failed',delivery_failed:'Delivery failed',cancellation:'Cancellation pending',fully_refunded:'Receipt fully refunded',files_unavailable:'Print files unavailable'};
export const pauseLabel = reason => L(reason.label,pauseEnglish[reason.code]||reason.label);
export function fulfillmentSummary(order) {
  const progress=order.fulfillment;
  return `<section class="fulfillment-summary" aria-label="${L('履约进度','Fulfillment progress')}"><div class="section-heading"><h3>${L('履约进度','Fulfillment progress')}</h3>${stageBadge(order)}</div><p class="hint">${L('实际接单','Accepted')} ${date(progress.acceptedAt)} · ${L('实际完成','Completed')} ${date(progress.completedAt)}</p>${progress.pauseReasons.length?`<ul class="pause-reasons">${progress.pauseReasons.map(reason=>`<li data-pause-code="${esc(reason.code)}"><strong>${esc(pauseLabel(reason))}</strong>${reason.note?`<p>${esc(reason.note)}</p>`:''}</li>`).join('')}</ul><p class="hint">${L('每项暂停分别处理；记录收款或解除一项原因后，其他限制仍然有效。','Handle each pause separately. Recording a receipt or resolving one pause leaves other restrictions in place.')}</p>`:''}</section>`;
}
export function receiptDescription(address) {
  const methods={handover:L('当面交付','Hand over in person'),contact_first:L('送达前联系','Contact before delivery'),doorstep:L('放在房间门口','Leave at the room door'),other:L('其他','Other')};
  if(!address.receiptMethod)return esc(address.notes)||L('未填写','Not provided');
  return `${esc(methods[address.receiptMethod])}${address.receiptNote?' · '+esc(address.receiptNote):''}${address.notes?' · '+esc(address.notes):''}${address.receiptMethod==='doorstep'?`<p class="notice">${L('用户已主动选择放在房间门口；实际按此方式交付后才可确认送达。','The user explicitly chose delivery at the room door. Confirm delivery only after carrying out this choice.')}</p>`:''}`;
}
