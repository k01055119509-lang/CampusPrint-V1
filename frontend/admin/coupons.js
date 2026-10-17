import { request } from '/shared/api.js';
import { privateCodes } from '/shared/codes.js';
import { L, money, date, esc } from './text.js';
import { policySummary } from './compensation.js';
import { reasonFields, reasonBody } from './workflow.js';

const states = () => ({available:L('可用','Available'),reserved:L('已占用','Reserved'),redeemed:L('已核销','Redeemed')});
const input = (name, label, value='', extra='') => `<label class="field"><span>${esc(label)}</span><input name="${name}" value="${esc(value)}" ${extra}></label>`;
const select = (name, label, options, value='') => `<label class="field"><span>${esc(label)}</span><select name="${name}">${options.map(([code,text])=>`<option value="${code}" ${code===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
function amount(value, label, optional=false) {
  if(optional&&!value.trim())return null;
  if(!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error(label+L('请使用最多两位小数的人民币金额。',' must be a CNY amount with up to two decimal places.'));
  const [yuan,fen='']=value.split('.'), result=Number(yuan)*100+Number(fen.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result>100000000)throw new Error(L('金额超出范围。','Amount is out of range.'));
  return result;
}
function rule(coupon) {
  if(coupon.type==='discount')return `${coupon.payRatePercent/10}${L('折',' tenths')} · ${L('最低打印费','Minimum print fee')} ${money(coupon.minPrintAmountFen)}${coupon.maxDiscountFen?` · ${L('最多优惠','Maximum discount')} ${money(coupon.maxDiscountFen)}`:''}`;
  return `${L('满','Spend')} ${money(coupon.minPrintAmountFen)} ${L('减','save')} ${money(coupon.reductionFen)}`;
}
export function couponExceptionPanel(order) {
  const exception=order.couponException;if(!exception)return '';
  const reasons={expired:L('已到期','Expired'),disabled:L('已停用','Disabled')};
  const decisions={continue:L('认可原优惠继续履约','Original discount accepted'),cancel:L('进入取消处理','Entered cancellation handling')};
  return `<section class="subsection coupon-exception"><h3>${L('优惠券异常（独立处理）','Coupon exception')}</h3><p class="notice ${exception.hold?'error':''}">${exception.hold?L('打印与配送暂停。可以如实记录收款，核款不会自动解除此异常。','Printing and delivery are paused. Record actual receipts truthfully; payment confirmation does not resolve this exception.'):L('此项异常已有处理决定；其他财务、退款或履约限制仍按订单状态执行。','A decision is recorded. Financial, refund and other fulfillment restrictions still apply.')}</p><p>${L('原因','Reasons')}: ${(exception.reasons||[]).map(reason=>esc(reasons[reason]||reason)).join(' · ')}</p><p>${L('发现时间','Detected')}: ${date(exception.detectedAt)}</p><p>${L('处理决定','Decision')}: ${esc(decisions[exception.resolution]||L('待处理','Pending'))} · ${date(exception.resolvedAt)}</p><p class="hint">${L('原订单金额保留。继续履约只处理本单已识别的券异常，不能替代财务核查或退款。下方操作记录保留原因和处理过程。','The original order amount is retained. Continuing handles the identified coupon exception only; financial checks and refunds remain separate. See the activity history for handling records.')}</p>${(order.couponExceptionHistory||[]).map(entry=>`<div class="reply"><strong>${esc(({detected:L('发现异常','Detected'),continue:L('认可原优惠继续履约','Continue with original discount'),cancel:L('进入取消处理','Entered cancellation')})[entry.type]||L('异常处理记录','Exception record'))}</strong><p>${(entry.reasons||[]).map(reason=>esc(reasons[reason]||reason)).join(' · ')}</p><p>${esc(entry.note||'')}</p><small>${date(entry.createdAt)} · ${esc(entry.actorId||'')}</small></div>`).join('')}</section>`;
}
export async function revealCoupons(ids, notify, isCurrent=()=>true) {
  const result=await request('/admin/coupons/reveal-codes',{method:'POST',body:{couponIds:ids}});
  if(!isCurrent())return;
  const visible=result.items.filter(item=>item.code).map(item=>({label:item.id,code:item.code,length:25}));
  const unavailable=result.items.length-visible.length;
  if(visible.length)privateCodes({title:L('优惠券兑换码','Coupon codes'),help:L('请私下复制发放。已占用、停用或到期的码不代表可用；每码最多核销一次，核销后不再显示。','Copy and distribute privately. Reserved, disabled or expired codes are not available for new orders. Each code can be redeemed once; redeemed codes are no longer revealed.'),items:visible});
  if(unavailable)notify(L('部分券已核销或不可查看，未返回完整码。','Some coupons are redeemed or unavailable; their codes were not returned.'));
}
export async function renderCoupons({content,state,epoch,modal,mutation,notify,refresh}) {
  const filters=state.couponFilters||{}, query=new URLSearchParams({page:String(state.couponPage||1),pageSize:'20',...filters});
  const [list,policy]=await Promise.all([request('/admin/coupons?'+query),request('/admin/compensation-policy')]);if(epoch!==state.epoch)return;
  const types=[['',L('全部类型','All types')],['discount',L('折扣券','Discount')],['threshold',L('满减券','Threshold')]];
  content.innerHTML=`<div class="stack"><section class="panel" data-compensation-policy><h2>${L('商家取消补偿（固定方案）','Merchant cancellation compensation (fixed policy)')}</h2><p>${esc(policySummary(policy))}</p><p class="hint">${L('在未收款订单的商家取消确认中选发，每单最多一次；普通优惠券仍按下方规则生成。','Select at merchant cancellation before any receipt, once per order. Ordinary coupons retain the creation rules below.')}</p></section><section class="panel"><div class="page-heading"><div><h2>${L('一次性优惠券','Single use coupons')}</h2><p class="hint">${L('一单一券；报价不占用，建单成功后占用，确认收款后核销。已发行规则固定。','One coupon per order. Quotes do not reserve coupons; successful orders reserve them and receipt confirmation redeems them. Issued rules are fixed.')}</p></div><button class="button primary" data-coupon-create>${L('生成优惠券','Create coupons')}</button></div><form id="coupon-filter" class="coupon-filters">${select('type',L('类型','Type'),types,filters.type)}${select('state',L('基础状态','State'),[['',L('全部状态','All states')],...Object.entries(states())],filters.state)}${input('batchId',L('批次 ID（可选）','Batch ID (optional)'),filters.batchId||'','maxlength="36"')}<button class="button" type="submit">${L('筛选','Filter')}</button></form></section><section class="panel"><div class="actions"><button class="button" data-coupon-reveal-page ${list.items.some(item=>item.state!=='redeemed')?'':'disabled'}>${L('查看本页未核销兑换码','Reveal unredeemed codes on this page')}</button></div><div class="coupon-list">${list.items.map(coupon=>`<article class="coupon-card"><div class="section-heading"><h3>${esc(coupon.maskedCode)}</h3><span class="badge">${esc(states()[coupon.state]||coupon.state)}</span></div><p>${esc(rule(coupon))}</p><p class="hint">${L('创建','Created')} ${date(coupon.createdAt)} · ${L('到期','Expires')} ${date(coupon.expiresAt)}</p><p>${coupon.isExpired?L('已到期 · ','Expired · '):''}${coupon.disabledAt?L('已停用 · ','Disabled · '):''}${coupon.reservedOrderId?`<a href="#orders&orderId=${esc(coupon.reservedOrderId)}">${L('查看占用订单','View reserved order')}</a>`:''}</p><p class="hint">${L('批次','Batch')}: ${esc(coupon.batchId)}</p><div class="actions">${coupon.state!=='redeemed'?`<button class="button" data-coupon-reveal="${coupon.id}">${L('查看 / 复制兑换码','Reveal / copy code')}</button>`:''}${coupon.state!=='redeemed'&&!coupon.disabledAt?`<button class="button danger" data-coupon-disable="${coupon.id}">${L('停用','Disable')}</button>`:''}</div></article>`).join('')||`<p class="muted">${L('暂无符合条件的优惠券。','No matching coupons.')}</p>`}</div><div class="pagination"><button class="button" data-coupon-page="-1" ${list.page<=1?'disabled':''}>${L('上一页','Previous')}</button><span>${list.page} · ${list.total} ${L('张','coupons')}</span><button class="button" data-coupon-page="1" ${list.page*list.pageSize>=list.total?'disabled':''}>${L('下一页','Next')}</button></div></section></div>`;
  content.querySelector('#coupon-filter').onsubmit=async event=>{event.preventDefault();state.couponFilters={};for(const [key,value] of new FormData(event.currentTarget))if(value.trim())state.couponFilters[key]=value.trim();state.couponPage=1;await refresh();};
  content.querySelectorAll('[data-coupon-page]').forEach(button=>button.onclick=async()=>{state.couponPage=(state.couponPage||1)+Number(button.dataset.couponPage);await refresh();});
  async function reveal(ids,button){button.disabled=true;try{await revealCoupons(ids,notify);}catch(error){notify(error.message,true);}finally{if(button.isConnected)button.disabled=false;}}
  content.querySelectorAll('[data-coupon-reveal]').forEach(button=>button.onclick=()=>reveal([button.dataset.couponReveal],button));
  content.querySelector('[data-coupon-reveal-page]').onclick=event=>reveal(list.items.filter(item=>item.state!=='redeemed').map(item=>item.id),event.currentTarget);
  content.querySelectorAll('[data-coupon-disable]').forEach(button=>button.onclick=()=>{
    const coupon=list.items.find(item=>item.id===button.dataset.couponDisable);let version=coupon.version;
    modal({title:L('停用优惠券','Disable coupon'),impact:L('停用不可撤销。已占用且未核销的订单会保留金额，并因券异常暂停打印和配送；请逐单处理。','Disabling is permanent. Reserved, unredeemed orders keep their prices and pause printing and delivery for individual handling.'),fields:reasonFields('coupon_disable'),onSubmit:async form=>{await mutation('/admin/coupons/'+coupon.id+'/disable',{expectedVersion:version,...reasonBody(form)});await refresh();notify(L('优惠券已停用','Coupon disabled'));},onConflict:async()=>{const latest=await request('/admin/coupons?'+query);const value=latest.items.find(item=>item.id===coupon.id);if(value)version=value.version;await refresh();}});
  });
  content.querySelector('[data-coupon-create]').onclick=()=>{
    const dialog=modal({title:L('生成优惠券','Create coupons'),impact:L('每张均为独立的 25 位兑换码。8.5 折表示支付 85%；满减只减一次，减免额必须小于门槛。生成后规则固定。','Each coupon has a unique 25-character code. An 8.5 discount means paying 85%. A threshold reduction applies once and must be below its threshold. Rules are fixed after creation.'),fields:`${select('type',L('类型','Type'),types.slice(1),'discount')}${input('quantity',L('数量（1–100）','Quantity (1–100)'),1,'type="number" required min="1" max="100" step="1"')}<div data-discount-fields>${input('discountTenths',L('折扣（0.1–9.9 折）','Discount (0.1–9.9 tenths)'),8,'type="number" min="0.1" max="9.9" step="0.1"')}${input('maxDiscount',L('最高优惠（元，可不填）','Maximum discount (CNY, optional)'),'','inputmode="decimal"')}</div>${input('minimum',L('最低打印费 / 满减门槛（元）','Minimum print fee / threshold (CNY)'),0,'required inputmode="decimal"')}<div data-threshold-fields hidden>${input('reduction',L('减免金额（元）','Reduction (CNY)'),'','inputmode="decimal"')}</div>${select('expiryMode',L('有效期','Validity'),[['default',L('创建起七天（默认）','Seven days from creation (default)')],['custom',L('指定到期时间（上海）','Custom expiry (Shanghai)')]],'default')}<div data-custom-expiry hidden>${input('expiresAt',L('到期时间（Asia/Shanghai）','Expires at (Asia/Shanghai)'),'','type="datetime-local"')}</div>`,onSubmit:async form=>{
      const type=form.get('type'),quantity=Number(form.get('quantity'));
      if(!Number.isInteger(quantity)||quantity<1||quantity>100)throw new Error(L('数量须为 1–100 的整数。','Quantity must be an integer from 1 to 100.'));
      const minimum=amount(form.get('minimum'),L('最低打印费','Minimum print fee'));
      const body={type,quantity,minPrintAmountFen:minimum};
      if(type==='discount'){
        const value=form.get('discountTenths');if(!/^(?:[0-9](?:\.[0-9])?)$/.test(value))throw new Error(L('折扣最多一位小数。','Use at most one decimal for the discount.'));
        body.payRatePercent=Math.round(Number(value)*10);
        if(body.payRatePercent<1||body.payRatePercent>99)throw new Error(L('折扣须在 0.1–9.9 折之间。','Discount must be between 0.1 and 9.9 tenths.'));
        body.maxDiscountFen=amount(form.get('maxDiscount'),L('最高优惠','Maximum discount'),true);
        if(body.maxDiscountFen===0)throw new Error(L('最高优惠须为正数或留空。','Maximum discount must be positive or empty.'));
      }else{
        body.reductionFen=amount(form.get('reduction'),L('减免金额','Reduction'));
        if(minimum<=0||body.reductionFen<=0||body.reductionFen>=minimum)throw new Error(L('减免额须为正数且小于满减门槛。','Reduction must be positive and below the threshold.'));
      }
      if(form.get('expiryMode')==='custom'){
        const value=form.get('expiresAt');if(!value)throw new Error(L('请选择到期时间。','Choose an expiry time.'));
        const date=new Date(value+':00+08:00');if(!Number.isFinite(+date)||+date<=Date.now())throw new Error(L('到期时间须在未来。','Expiry must be in the future.'));body.expiresAt=date.toISOString();
      }
      const result=await mutation('/admin/coupon-batches',body);state.couponFilters={batchId:result.batchId};state.couponPage=1;
      await refresh();notify(L('已生成，列表只显示遮罩码。请通过查看入口复制发放。','Created. The list shows masked codes. Use Reveal to copy codes privately.'));
    }});
    const form=dialog.querySelector('form');
    const update=()=>{const discount=form.elements.type.value==='discount';dialog.querySelector('[data-discount-fields]').hidden=!discount;dialog.querySelector('[data-threshold-fields]').hidden=discount;
      dialog.querySelectorAll('[data-discount-fields] input').forEach(input=>input.disabled=!discount);dialog.querySelectorAll('[data-threshold-fields] input').forEach(input=>input.disabled=discount);
      const custom=form.elements.expiryMode.value==='custom';dialog.querySelector('[data-custom-expiry]').hidden=!custom;form.elements.expiresAt.disabled=!custom;};
    form.elements.type.onchange=update;form.elements.expiryMode.onchange=update;update();
  };
}
