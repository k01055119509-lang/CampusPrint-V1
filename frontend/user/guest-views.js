import { defaultReceiptFields } from './receipt-fields.js';
import {channelLabel} from '/shared/merchant.js';
import { t, money, time, escape as e, failure } from './text.js';

const l = (key, values) => e(t(key, values));
const button = (action, key, extra = '') => `<button class="button" type="button" data-action="${action}" ${extra}>${l(key)}</button>`;
export function recoveryPanel() {
  return `<section class="panel recovery-panel"><h2>${l('recoverOrder')}</h2><p class="hint">${l('recoverHelp')}</p><form id="recover-form" autocomplete="off"><label class="field"><span>${l('queryCode')}</span><input name="queryCode" required maxlength="100" spellcheck="false" autocapitalize="characters" autocomplete="off" placeholder="${l('queryPlaceholder')}"></label><button class="button" type="submit">${l('recoverOrder')}</button></form><p class="hint">${l('lostQueryHelp')}</p></section>`;
}
export function amounts(value) {
  return `<div class="totals-metrics"><div class="metric"><span>${l('contentPages')}</span><strong data-content-pages>${value.contentPages}</strong></div><div class="metric"><span>${l('sheets')}</span><strong data-sheet-count>${value.sheetCount}</strong></div></div><div class="money-lines"><div class="money-line"><span>${l('printFee')}</span><span>${e(money(value.printAmountFen))}</span></div><div class="money-line"><span>${l('discountFee')}</span><span>−${e(money(value.discountAmountFen ?? 0))}</span></div><div class="money-line"><span>${l('deliveryFee')}</span><span>${e(money(value.deliveryFeeFen))}</span></div><div class="money-line total"><span>${l('total')}</span><strong data-total-fen="${value.totalAmountFen}">${e(money(value.totalAmountFen))}</strong></div></div>`;
}
export function couponInput(s, locked) {
  return `<div class="coupon-input"><label class="field"><span>${l('couponCode')}</span><input name="couponCode" value="${e(s.couponCode)}" maxlength="100" spellcheck="false" autocapitalize="characters" autocomplete="off" ${locked?'disabled':''}></label><p class="hint">${l('couponHelp')}</p>${s.couponCode?button('remove-coupon','removeCoupon',locked?'disabled':''):''}</div>`;
}
export function couponSnapshot(coupon) {
  return coupon?`<p class="notice">${l('couponApplied')} · ${e(coupon.maskedCode)} · ${l(coupon.type==='discount'?'discountCoupon':'thresholdCoupon')}</p>`:'';
}
export function couponException(order) {
  const exception=order.couponException;if(!exception)return '';
  return `<section class="panel"><h2>${l('couponException')}</h2><p class="${exception.hold?'notice error':'hint'}">${l(exception.hold?'couponOnHold':'couponHandled')}</p><p>${(exception.reasons||[]).map(reason=>l('couponReason_'+reason)).join(' · ')}</p><p class="hint">${l('detectedAt')}: ${e(time(exception.detectedAt))}</p><p>${l('couponAmountKept')}</p></section>`;
}
export function paymentTimes(order) {
  return `${order.payment.lastSubmittedChannel?`<p class="hint">${l('channel')}: ${e(channelLabel(order.payment.lastSubmittedChannel))}</p>`:''}${order.payment.confirmedChannel?`<p class="hint">${l('paymentConfirmedAt')} · ${e(channelLabel(order.payment.confirmedChannel))}</p>`:''}<div class="detail-row"><span>${l('paymentSubmittedAt')}</span><strong>${e(order.payment.lastSubmittedAt?time(order.payment.lastSubmittedAt):t('notSubmitted'))}</strong></div><div class="detail-row"><span>${l('paymentConfirmedAt')}</span><strong>${e(order.payment.confirmedAt?time(order.payment.confirmedAt):t('notConfirmed'))}</strong></div>`;
}
export function guestProfile(s, settings) {
  const pref=s.defaults||{room:'',contact:'',notes:'',copies:1,duplex:false};
  return `<div class="page-heading"><h1>${l('me')}</h1></div><div class="profile-layout"><div class="column-stack"><section class="panel"><h2>${l('guestIdentity')}</h2><p>${l('guestHelp')}</p><p class="hint">${l('guestExpiresAt')}: ${e(time(s.user.sessionExpiresAt))}</p><div class="actions">${s.publicConfig?.studentAccountsEnabled?button('login','account'):''}<a class="button" href="#orders">${l('orders')}</a><a class="button" href="#support">${l('support')}</a></div></section>${recoveryPanel()}<section class="panel"><h2>${l('defaults')}</h2><p class="hint">${l('defaultsHelp')}</p><form id="defaults-form">${[['room','savedRoom',40]].map(([name,key,max])=>`<label class="field"><span>${l(key)}</span><input name="${name}" value="${e(pref[name])}" maxlength="${max}" autocomplete="off"></label>`).join('')}${defaultReceiptFields(pref)}<label class="field"><span>${l('copies')}</span><input name="copies" type="number" required min="1" max="99" step="1" value="${pref.copies}"></label><label class="field"><span>${l('sidedness')}</span><select name="duplex"><option value="false" ${!pref.duplex?'selected':''}>${l('single')}</option><option value="true" ${pref.duplex?'selected':''}>${l('duplex')}</option></select></label><button class="button" type="submit">${l('savePreferences')}</button></form></section></div><div class="column-stack"><section class="panel"><h2>${l('appearance')}</h2>${settings}</section><section class="panel"><h2>${l('help')}</h2><p>${l('pricing')}</p><p>${l('retention')}</p><p>${l('lostQueryHelp')}</p></section></div></div>`;
}
export function support(s, ticketCards, pagination) {
  return `<div class="page-heading"><div><h1>${l('support')}</h1><p class="hint">${l('supportHelp')}</p></div><button class="button primary" type="button" data-action="feedback">${l('newFeedback')}</button></div><div class="stack"><p class="notice">${l('feedbackLifetime')}</p>${s.supportOrder?`<section class="panel"><h2>${e(s.supportOrder.orderNo)}</h2><div class="actions"><a class="button" href="#orders/${e(s.supportOrder.id)}">${l('orderProgress')}</a><a class="button" href="#support">${l('supportAll')}</a></div></section>`:''}<section class="panel"><h2>${l(s.supportOrder?'orderTickets':'supportAll')}</h2>${s.ticketsError?`<p class="error" role="alert">${e(failure(s.ticketsError))}</p><button class="button" type="button" data-action="reload-tickets">${l('retry')}</button>`:ticketCards(s.tickets)}${s.tickets&&pagination(s.tickets,'tickets-page')}</section></div>`;
}
