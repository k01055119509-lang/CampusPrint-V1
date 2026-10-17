// Shared presentation of the merchant API. No account or order data is inferred.
export const M=(zh,en)=>document.documentElement.lang.startsWith('en')?en:zh;
export const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const feedbackTypes=[['print_quality','打印质量','Print quality'],['content_quantity','内容或份数不符','Content or copy count'],['delivery','配送问题','Delivery issue'],['payment_refund','付款或退款','Payment or refund'],['other','其他','Other']];
export function feedbackLabel(type){const value=feedbackTypes.find(v=>v[0]===type)||feedbackTypes.at(-1);return M(value[1],value[2]);}
export function channelLabel(channel){return channel==='wechat'?M('微信','WeChat'):channel==='alipay'?M('支付宝','Alipay'):M('历史收款码（渠道未归属）','Historical payment code (unassigned channel)');}
export function paymentChoices(payment){
  const items=(payment?.channels||[]).filter(item=>['wechat','alipay'].includes(item.channel)).map(item=>({...item,key:item.channel}));
  if(payment?.legacy?.configured)items.push({...payment.legacy,key:'other'});
  return items;
}
export function paymentPanel(payment,preferred=''){
  const choices=paymentChoices(payment),valid=choices.filter(item=>item.available&&item.imageUrl),current=valid.find(item=>item.key===preferred)||valid[0];
  return `<div class="payment-channels" data-payment-channels><label class="field"><span>${M('选择收款渠道','Choose a payment channel')}</span><select name="paymentChannel" ${current?'':'disabled'}>${current?'':`<option value="">${M('暂无可用收款码','No payment code available')}</option>`}${choices.map(item=>`<option value="${item.key}" ${item.key===current?.key?'selected':''} ${item.available&&item.imageUrl?'':'disabled'}>${escape(channelLabel(item.key))}${item.available?'':M(item.configured?'（图片不可读，请联系商户）':'（未配置）',item.configured?' (image unavailable; contact operator)':' (not configured)')}</option>`).join('')}</select></label>${current?`<button class="payment-zoom" type="button" data-payment-zoom aria-label="${M('放大查看完整收款码','Enlarge the complete payment code')}"><img id="payment-image" class="payment-image" src="${escape(current.imageUrl)}" alt="${escape(channelLabel(current.key))}"></button><p class="hint">${M('点击图片放大，请自行核对收款账户。','Select the image to enlarge it and verify the recipient.')}</p>`:`<h3>${choices.some(item=>item.configured)?M('收款图片暂不可用','Payment images are unavailable'):M('尚未配置收款信息','Payment information has not been configured')}</h3><p class="notice">${M('收款码尚未配置或图片不可读，请联系商户；订单与售后仍可查看。','Payment codes are not configured or cannot be read. Contact the operator; orders and support remain available.')}</p>`}<p class="status error" data-payment-error role="status"></p><p class="muted">${escape(payment?.instructions)}</p></div>`;
}
export function bindPayment(root,payment,onSelect){
  const host=root.querySelector('[data-payment-channels]');if(!host)return;
  const select=host.querySelector('[name=paymentChannel]');
  const bind=()=>{
    const image=host.querySelector('.payment-image'),zoom=host.querySelector('[data-payment-zoom]');
    if(!image)return;
    const failed=()=>{const option=select.selectedOptions[0];if(option)option.disabled=true;image.hidden=true;zoom.disabled=true;host.querySelector('[data-payment-error]').textContent=M('收款图片读取失败。请刷新收款信息或选择其他可用渠道。','Payment image could not be read. Refresh payment information or choose another available channel.');onSelect('');};
    image.addEventListener('error',failed,{once:true});if(image.complete&&!image.naturalWidth)failed();
    zoom.onclick=()=>{if(!image.naturalWidth)return;const dialog=document.createElement('dialog');dialog.className='dialog payment-image-dialog';dialog.setAttribute('aria-label',channelLabel(select.value));dialog.innerHTML=`<button type="button" class="button">${M('关闭','Close')}</button><img src="${escape(image.src)}" alt="${escape(image.alt)}">`;dialog.querySelector('button').onclick=()=>dialog.close();dialog.onclose=()=>{dialog.remove();if(zoom.isConnected)zoom.focus();};document.body.append(dialog);dialog.showModal();};
  };
  select.onchange=()=>{const selected=select.value;host.outerHTML=paymentPanel(payment,selected);onSelect(selected);bindPayment(root,payment,onSelect);};
  onSelect(select.disabled?'':select.value);bind();
}
export function feedbackFields({category='order'}={}){return `${category==='general'?'':`<label class="field"><span>${M('反馈类型（必选）','Feedback type (required)')}</span><select name="feedbackType" required><option value="">${M('请选择反馈类型','Select a feedback type')}</option>${feedbackTypes.map(([key,zh,en])=>`<option value="${key}">${escape(M(zh,en))}</option>`).join('')}</select></label>`}<label class="field"><span>${M('联系方式类型（选填）','Contact type (optional)')}</span><select name="contactType"><option value="">${M('不提供','Do not provide')}</option><option value="phone">${M('电话','Phone')}</option><option value="wechat">${M('微信号','WeChat ID')}</option></select></label><label class="field"><span>${M('联系方式（仅商户可见，选填）','Contact details (visible to the operator, optional)')}</span><input name="contactValue" maxlength="120" autocomplete="off"></label>`;}
export function bindFeedback(form){
  const type=form.elements.feedbackType,subject=form.elements.subject,contactType=form.elements.contactType,contact=form.elements.contactValue;let lastSubject='';
  if(type&&subject)type.onchange=()=>{if(!subject.value||subject.value===lastSubject){lastSubject=feedbackLabel(type.value);subject.value=lastSubject;}};
  const contactChanged=()=>{contact.required=!!contactType.value;contactType.required=!!contact.value.trim();contact.setCustomValidity(/[\x00-\x1f\x7f]/.test(contact.value)?M('联系方式不能含控制字符。','Contact details cannot contain control characters.'):'');};
  contactType.onchange=contactChanged;contact.oninput=contactChanged;contactChanged();
}
export function ticketMeta(ticket,{admin=false}={}){return `<p class="hint" data-ticket-type="${escape(ticket.feedbackType||'other')}" data-ticket-category="${ticket.category==='general'?'general':'order'}">${escape(ticket.category==='general'?M('一般反馈','General feedback'):feedbackLabel(ticket.feedbackType))}${ticket.contactProvided?' · '+M('已提供联系方式','Contact provided'):''}</p>${admin&&ticket.contactProvided?`<p class="ticket-contact">${ticket.contactType==='phone'?M('电话','Phone'):M('微信号','WeChat ID')}：${escape(ticket.contactValue)}</p>`:''}`;}
