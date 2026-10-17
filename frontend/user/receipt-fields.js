import { t, escape as e } from './text.js';

export const receiptMethods = ['handover','contact_first','doorstep','other'];
export function defaultReceiptFields(pref) {
  const method = pref.receiptMethod || '';
  return `<label class="field"><span>${e(t('defaultReceiptMethod'))}</span><select name="receiptMethod"><option value="">${e(t('noDefaultReceipt'))}</option>${receiptMethods.map(code=>`<option value="${code}" ${method===code?'selected':''}>${e(t('receipt_'+code))}</option>`).join('')}</select></label><label class="field"><span data-default-contact-label>${e(t(method==='contact_first'?'requiredContact':'contact'))}</span><input name="contact" value="${e(pref.contact)}" maxlength="120" autocomplete="off" ${method==='contact_first'?'required':''}></label><label class="field" data-default-receipt-note ${method==='other'?'':'hidden'}><span>${e(t('requiredReceiptNote'))}</span><textarea name="receiptNote" maxlength="500" ${method==='other'?'required':''}>${e(pref.receiptNote)}</textarea></label>${pref.notes?`<div class="legacy-default-note"><strong>${e(t('legacyDefaultNote'))}</strong><p>${e(pref.notes)}</p><p class="hint">${e(t('legacyDefaultHelp'))}</p></div>`:''}`;
}

export function bindDefaultReceipt(form) {
  if (!form) return;
  form.elements.receiptMethod.onchange = () => {
    const method=form.elements.receiptMethod.value;
    form.elements.contact.required=method==='contact_first';
    form.querySelector('[data-default-contact-label]').textContent=t(method==='contact_first'?'requiredContact':'contact');
    form.querySelector('[data-default-receipt-note]').hidden=method!=='other';
    form.elements.receiptNote.required=method==='other';
  };
}
