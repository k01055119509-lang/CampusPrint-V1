import { groupCode } from '/shared/codes.js';
import { t, money, time, escape as e, failure } from './text.js';

export function announcement(s) {
  if (s.announcementError) return `<section class="panel announcement" data-announcement><h2>${e(t('announcement'))}</h2><p class="hint" role="status">${e(t('announcementFailed'))}</p><button class="button small" type="button" data-action="reload-announcement">${e(t('retry'))}</button></section>`;
  const value=s.announcement;
  return value?.enabled&&value.content?.trim()?`<section class="panel announcement" data-announcement><h2>${e(t('announcement'))}</h2><p class="announcement-content">${e(value.content)}</p></section>`:'';
}

export function inlineCode(s,kind) {
  const value=s.orderCodes?.[kind],codeName=kind==='query'?'queryCode':'compensationCode';
  if(value?.phase==='ready') return `<label class="field private-inline-code"><span>${e(t(codeName))}</span><textarea rows="2" readonly autocomplete="off" spellcheck="false" data-private-code data-code-kind="${kind}">${e(groupCode(value.code,kind==='query'?4:5))}</textarea></label><div class="actions"><button class="button" type="button" data-action="copy-${kind}-code">${e(t('copyCode'))}</button></div>${value.copyFailed?`<p class="notice" role="status">${e(t('copyCodeFallback'))}</p>`:''}`;
  if(value?.phase==='loading')return `<p class="hint" role="status">${e(t('codeLoading'))}</p>`;
  if(value?.phase==='error')return `<p class="error" role="alert">${e(failure(value.error))}</p><button class="button" type="button" data-action="load-${kind}-code">${e(t('retryCode'))}</button>`;
  return `<button class="button" type="button" data-action="load-${kind}-code">${e(t(codeName))}</button>`;
}

export function cancellationStatus(s) {
  const order=s.order,meta=order.cancellation;
  if(!meta)return '';
  const returned=order.events?.some(event=>event.data?.originalCouponReleased);
  return `${order.lifecycle==='cancel_requested'?`<p class="notice" data-cancellation-status>${e(t('cancelSubmitted'))}</p>`:''}${order.lifecycle==='cancelled'?`<p class="notice" data-cancellation-status>${e(t(meta.origin==='merchant'?'merchantCancelled':'cancelledResult'))}</p>`:''}${returned?`<p class="hint" data-original-coupon-returned>${e(t('originalCouponReturned'))}</p>`:''}${meta.receiptRecorded?`<p class="hint" data-cancellation-blocked>${e(t('receiptBlocksCancel'))}</p>`:''}${s.cancelError?.orderId===order.id?`<p class="error" role="alert">${e(s.cancelError.message)}</p>`:''}`;
}

export function cancelButton(s) {
  const order=s.order,meta=order.cancellation,intent=s.actionIntents.get(order.id+':cancel');
  if(order.accessType==='recovered'||!intent&&(!order.allowedActions.includes('request_cancel')||!['direct','review'].includes(meta?.requestMode)))return '';
  const label=s.cancelBusy===order.id?'busy':intent?'retryCancel':meta.requestMode==='direct'?'cancelOrder':'requestCancel';
  return `<div class="actions"><button class="button" type="button" data-action="cancel-order" ${s.cancelBusy===order.id?'disabled':''}>${e(t(label))}</button></div>`;
}

export function compensation(s) {
  const value=s.order.compensation;
  if(!value)return '';
  const state=value.state==='redeemed'?'redeemed':value.disabled?'disabled':value.isExpired?'expired':value.state;
  return `<section class="compensation-record" data-compensation-state="${e(state)}"><h3>${e(t('compensation'))}</h3><p>${e(t('compensationRule',{cap:money(value.maxDiscountFen)}))}</p><p>${e(t('issuedAt'))}: ${e(time(value.issuedAt))}</p><p>${e(t('expiresAt'))}: ${e(time(value.expiresAt))}</p><p class="notice">${e(t('compensation_'+state))}</p>${value.canViewCode&&s.order.allowedActions.includes('view_compensation_code')?inlineCode(s,'compensation'):`<p class="hint">${e(t(s.order.accessType==='recovered'?'compensationRestricted':'compensationCodeUnavailable'))}</p>`}<p class="hint">${e(t('compensationHelp'))}</p></section>`;
}
