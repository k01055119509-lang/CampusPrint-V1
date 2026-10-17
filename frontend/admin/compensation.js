import { L, esc, money, date } from './text.js';

export function policySummary(policy) {
  return L(`${policy.payRatePercent/10}折 · 无门槛 · 最高减免${money(policy.maxDiscountFen)} · 发放起${policy.validDays}天`,`${policy.payRatePercent}% payable · no minimum · save up to ${money(policy.maxDiscountFen)} · ${policy.validDays} days from issue`);
}
export const cancellationRecordStatus=value=>({requested:L('取消申请待处理','Cancellation pending'),approved:L('已同意取消','Cancellation approved'),rejected:L('不同意取消','Cancellation rejected')})[value]||value;
export function compensationPanel(order) {
  const item=order.compensation;
  if(!item)return order.lifecycle==='cancelled'&&order.cancellation?.origin==='merchant'?`<p data-compensation-record>${L('商家取消：未发放补偿券。','Merchant cancellation: no compensation coupon issued.')}</p>`:'';
  const state=item.state==='redeemed'?L('已使用','Redeemed'):item.disabled?L('已停用','Disabled'):item.isExpired?L('已到期','Expired'):item.state==='reserved'?L('已被订单占用','Reserved by an order'):L('可用','Available');
  return `<div class="reply" data-compensation-record><strong>${L('已发放取消补偿券','Cancellation compensation issued')}</strong><p>${esc(policySummary({...item,validDays:30}))}</p><p>${L('状态：','Status: ')}${esc(state)}</p><small>${L('发放','Issued')} ${date(item.issuedAt)} · ${L('到期','Expires')} ${date(item.expiresAt)}</small>${item.state!=='redeemed'?`<button class="button" data-action="compensation-code" type="button">${L('查看 / 复制补偿兑换码','Reveal / copy compensation code')}</button>`:''}</div>`;
}
export function compensationEvent(event) {
  if(!['merchant_cancelled','cancel_resolved'].includes(event.type)||event.data.action!=='approve')return '';
  if(event.data.compensation)return L('已发放补偿券：','Compensation issued: ')+policySummary({...event.data.compensation,validDays:30})+L('；发放时间 ','; issued ')+date(event.data.compensation.issuedAt);
  return event.data.origin==='merchant'?L('未发放补偿券','No compensation coupon issued'):'';
}
