import {paymentChoices,channelLabel,bindPayment,feedbackFields,bindFeedback} from '/shared/merchant.js';
// Advertisement implementation and placement are retained for a later release; this surface does not load it.
import {clearAdvertisements} from '/shared/advertisements.js';
import { request, csrf, upload, binaryUrl, releaseUrl, clearPrivateViews, setSurface } from '/shared/api.js';
import { normalizeCode, validCode, groupCode } from '/shared/codes.js';
import { initializeSettings, setLanguage } from '/shared/i18n.js';
import { t, failure, money, time, escape as e } from './text.js';
import * as views from './views.js';
import { bindDefaultReceipt } from './receipt-fields.js';
import { openAccountSecurity } from '/shared/account-security.js';

setSurface('student');
const content = document.querySelector('#content');
const s = {
  user:null, publicConfig:null, config:null, configError:null, announcement:null, announcementError:null, orderCodes:{query:null,compensation:null}, cancelBusy:null, cancelError:null, cancelNotice:null, epoch:0, route:'home', routeId:'', loading:false,
  files:[], draftOwner:null, address:{room:'',contact:'',notes:'',receiptMethod:'',receiptNote:''}, defaults:null, defaultsError:null,
  quote:null, quoteIntent:null, quoteBusy:false, quoteError:null, seen:new Set(), confirmedPreview:false, revision:0, quoteRevision:null,
  uploadBusy:false, orderBusy:false, orderIntent:null, actionIntents:new Map(),
  orders:null, order:null, orderTickets:null, tickets:null, ticketsError:null, viewError:null,
  filters:{q:'',status:'',page:1}, ticketPage:1, orderTicketPage:1,
  couponCode:'', paymentChannel:'', paymentBusy:false, paymentDraft:null, paymentError:'', supportOrderId:'', supportOrders:[], supportOrder:null
};
let viewSequence = 0, quoteSequence = 0, previewSequence = 0, quoteTimer, quoteExpiryTimer, orderExpiryTimer, preparationTimer;
let preview = null, authPromise = null, identityPromise = null, initial = true, actionDialogOpen = false, sessionTimer;
const fileTimers = new Map();
let channel = 'BroadcastChannel' in window ? new BroadcastChannel('campusprint.student.identity') : null;
const freshKey = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
const cancelled = () => Object.assign(new Error('Cancelled'), {code:'USER_CANCELLED'});
const uncertain = error => !error.status || error.status >= 500;
const owned = epoch => epoch === s.epoch && s.user?.role === 'user';

function tell(message, error = false) {
  const area = document.querySelector('#global-message');
  area.hidden = !message; area.textContent = message; area.classList.toggle('error',error);
}
function removePreview() {
  previewSequence++; releaseUrl(preview?.url); preview = null;
  document.querySelector('#preview-host')?.replaceChildren();
}
function resetPrivate() {
  s.epoch++; viewSequence++; quoteSequence++; s.orderCodes={query:null,compensation:null};s.cancelBusy=null;s.cancelError=null;s.cancelNotice=null;
  for (const timer of fileTimers.values()) clearTimeout(timer);
  fileTimers.clear(); clearTimeout(quoteTimer); clearTimeout(quoteExpiryTimer); clearTimeout(orderExpiryTimer); clearTimeout(sessionTimer); clearTimeout(preparationTimer);
  removePreview(); clearPrivateViews();
  document.querySelectorAll('dialog:not([data-auth])').forEach(dialog=>dialog.close());
  Object.assign(s,{user:null,files:[],draftOwner:null,address:{room:'',contact:'',notes:'',receiptMethod:'',receiptNote:''},defaults:null,defaultsError:null,
    quote:null,quoteIntent:null,quoteBusy:false,quoteError:null,seen:new Set(),confirmedPreview:false,revision:s.revision+1,quoteRevision:null,
    uploadBusy:false,orderBusy:false,orderIntent:null,orders:null,order:null,orderTickets:null,
    tickets:null,ticketsError:null,viewError:null,loading:false,filters:{q:'',status:'',page:1},ticketPage:1,orderTicketPage:1,
    couponCode:'',paymentBusy:false,paymentDraft:null,paymentError:'',supportOrderId:'',supportOrders:[],supportOrder:null});
  s.actionIntents.clear();
}
function adoptUser(user) {
  const next = user?.role === 'user' ? user : null, old = s.user?.id || s.draftOwner;
  if (old && old !== next?.id) { resetPrivate(); tell(t(next?'accountChanged':'sessionExpired'),true); }
  s.user = next;
  clearTimeout(sessionTimer);
  if (next) {
    s.draftOwner = next.id;
    if(next.sessionExpiresAt) sessionTimer=setTimeout(()=>{
      resetPrivate(); tell(t('guestExpired'),true); render();
    },Math.min(Math.max(0,Date.parse(next.sessionExpiresAt)-Date.now()),2147483647));
  }
  return next;
}
async function readIdentity() {
  if (identityPromise) return identityPromise;
  const epoch = s.epoch;
  identityPromise = (async()=>{
    try {
      let user;
      if(s.publicConfig?.studentAccountsEnabled === false&&!s.user) {
        await csrf();
        user=await request('/auth/guest',{method:'POST',body:{}});
      } else user=await request('/auth/me');
      if (epoch !== s.epoch) return s.user; return adoptUser(user);
    }
    catch(error) {
      if(error.status===401&&s.publicConfig?.studentAccountsEnabled===false){
        const freshEpoch=s.epoch;await csrf();
        const user=await request('/auth/guest',{method:'POST',body:{}});
        return freshEpoch===s.epoch?adoptUser(user):s.user;
      }
      if (error.status === 401) return adoptUser(null); throw error;
    }
  })();
  try { return await identityPromise; } finally { identityPromise = null; }
}
async function loadConfig() {
  try {
    s.publicConfig=await request('/public/config');
    const config=await request('/print/config');
    const changed=s.config&&(s.config.pricingVersion!==config.pricingVersion||s.config.acceptingOrders!==config.acceptingOrders||s.config.maintenance.enabled!==config.maintenance.enabled);
    if(changed)invalidateQuote(true);
    s.config=config; s.configError = null;
    if(changed)schedulePrepare();
  }
  catch(error) { s.configError = error; if (!s.config) s.config = null; }
}
async function loadAnnouncement() {
  const seq=viewSequence;
  try { const value=await request('/public/announcement');if(s.route!=='home'||seq!==viewSequence)return;s.announcement=value;s.announcementError=null; }
  catch(error) { if(s.route==='home'&&seq===viewSequence){s.announcement=null;s.announcementError=error;} }
  finally { if(s.route==='home'&&seq===viewSequence)render(); }
}
function addressFromDefaults(value) {
  return {room:value.room||'',contact:value.contact||'',notes:'',receiptMethod:value.receiptMethod||'',receiptNote:value.receiptNote||''};
}
async function loadDefaults() {
  if (!s.user) return;
  const epoch = s.epoch;
  try { const value = await request('/me/print-defaults'); if (!owned(epoch)) return;
    s.defaults = value; s.defaultsError = null;
    if (!s.address.room && !s.address.contact && !s.address.notes) s.address = {...s.address,...addressFromDefaults(value)};
  } catch(error) { if (owned(epoch)) s.defaultsError = error; }
}
function showDialog(title, description, html, onSubmit, {auth = false, first = null, readOnly = false} = {}) {
  const trigger = document.activeElement, dialog = document.createElement('dialog');
  dialog.className = 'dialog'; if (auth) dialog.dataset.auth = '';
  dialog.setAttribute('aria-labelledby','dialog-title');
  dialog.innerHTML = `<form><h2 id="dialog-title">${e(title)}</h2><p class="dialog-description">${e(description)}</p>${html}<p class="error" role="alert" aria-live="assertive"></p><div class="actions">${readOnly?'':`<button class="button" type="button" data-close>${e(t('cancel'))}</button>`}<button class="button primary" type="submit" data-submit>${e(t(readOnly?'close':auth?'login':'submit'))}</button></div></form>`;
  document.body.append(dialog);
  let busy = false, done = false, settle;
  const result = new Promise((resolve,reject)=>{settle={resolve,reject};});
  const form = dialog.querySelector('form');
  const setLocked = locked => { form.querySelectorAll('input,select,textarea,[data-mode],[data-password]').forEach(el=>el.disabled=locked); };
  form.onsubmit = async event=>{
    event.preventDefault(); if (busy) return; busy = true;
    const values = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[data-submit]'); submit.disabled = true;
    const original = submit.textContent; submit.textContent = t('busy');
    form.querySelector('[role=alert]').textContent = '';
    try {
      const value = await onSubmit(values,dialog,setLocked);
      if (value !== false && dialog.isConnected) { done = true; dialog.close(); settle.resolve(value); }
    } catch(error) { if (dialog.isConnected && error.code !== 'USER_CANCELLED') form.querySelector('[role=alert]').textContent = error.displayMessage || failure(error); }
    finally { busy = false; submit.disabled = false; submit.textContent = original; }
  };
  const close=form.querySelector('[data-close]');if(close)close.onclick = ()=>{ if (!busy) dialog.close(); };
  dialog.addEventListener('cancel',event=>{if (busy) event.preventDefault();});
  dialog.addEventListener('keydown',event=>{
    if(event.key !== 'Tab')return;
    const controls=[...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  dialog.addEventListener('close',()=>{ dialog.remove(); if (!done) settle.reject(cancelled());
    if (trigger?.isConnected) trigger.focus(); else content.focus({preventScroll:true});
  });
  dialog.showModal(); (first ? form.querySelector(first) : form.querySelector('input,textarea,select,[data-close]'))?.focus();
  return {dialog,form,result,setLocked};
}
function signIn() {
  if(!s.publicConfig)return loadConfig().then(()=>{if(!s.publicConfig)throw Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'});return signIn();});
  if(s.publicConfig?.studentAccountsEnabled === false)return readIdentity();
  if (authPromise) return authPromise;
  let registering = false;
  const auth = showDialog(t('login'),t('authContinue'),
    `${views.field('username','username','','required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_]{3,32}" autocomplete="username"')}${views.field('password','password','','required minlength="1" maxlength="128" autocomplete="current-password"','password')}<button type="button" class="button small" data-password>${e(t('showPassword'))}</button><p class="auth-rules">${e(t('authRules'))}</p><button class="button link-button auth-switch" type="button" data-mode>${e(t('toRegister'))}</button>`,
    async(values)=>{
      const epoch = s.epoch;
      await csrf();
      const body = {username:values.username,password:values.password};
      const user = await request(registering?'/auth/register':'/auth/login',{method:'POST',body});
      if (epoch !== s.epoch) throw cancelled();
      adoptUser(user); if (!s.user) throw Object.assign(new Error(t('error_FORBIDDEN')),{status:403,code:'FORBIDDEN'});
      await loadDefaults(); channel?.postMessage({type:'identity'}); return user;
    },{auth:true,first:'[name=username]'});
  const {dialog,form} = auth;
  form.querySelector('[data-mode]').onclick = ()=>{
    registering = !registering; dialog.querySelector('h2').textContent = t(registering?'register':'login');
    form.querySelector('[data-submit]').textContent = t(registering?'register':'login');
    form.querySelector('[data-mode]').textContent = t(registering?'toLogin':'toRegister');
    form.elements.password.autocomplete = registering?'new-password':'current-password';
    form.elements.password.minLength = registering ? 6 : 1;
    form.elements.password.maxLength = registering ? 12 : 128;
    if (registering) form.elements.password.pattern = '(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,12}'; else form.elements.password.removeAttribute('pattern');
    form.querySelector('.auth-rules').textContent = t(registering?'registrationRules':'authRules');
    form.querySelector('[role=alert]').textContent = '';
  };
  form.querySelector('[data-password]').onclick = ()=>{
    const password = form.elements.password; password.type = password.type === 'password'?'text':'password';
    form.querySelector('[data-password]').textContent = t(password.type === 'password'?'showPassword':'hidePassword');
  };
  authPromise = auth.result.finally(()=>{ authPromise = null; render(); });
  return authPromise;
}
async function ensureUser() {
  const user = await readIdentity();
  if (user) return user;
  if(s.publicConfig?.studentAccountsEnabled === false)throw new Error(t('guestRetry'));
  return signIn();
}
async function logout() {
  try { await request('/auth/logout',{method:'POST',body:{}}); resetPrivate(); channel?.postMessage({type:'identity'});
    await csrf(); tell(t('loggedOut')); render();
  } catch(error) { tell(failure(error),true); }
}
function routeFromHash() {
  const [route,id] = location.hash.slice(1).split('/');
  return {route:['home','print','orders','me','support'].includes(route)?route:'home',id:['orders','support'].includes(route)&&/^[a-f0-9-]{36}$/i.test(id||'')?id:''};
}
function updateShell() {
  document.title = `${t(s.route)} · ${t('brand')}`;
  document.querySelector('#brand-name').textContent = t('brand');
  document.querySelector('#skip-link').textContent = t('skip');
  document.querySelector('.student-nav').setAttribute('aria-label',t('navigation'));
  document.querySelectorAll('[data-view]').forEach(link=>{
    link.querySelector('span').textContent = t(link.dataset.view);
    if (link.dataset.view === s.route) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  document.querySelector('#student-account').textContent = s.user?.identityKind==='guest'?t('guestIdentity'):s.user?.nickname || (s.publicConfig?.studentAccountsEnabled===false?t('guestRetry'):t('account'));
  const chip = document.querySelector('#service-state');
  chip.textContent = !s.config?t('configLoading'):t(s.config.maintenance.enabled?'maintenance':s.config.acceptingOrders?'accepting':'paused');
  chip.classList.toggle('paused',!s.config?.acceptingOrders || !!s.config?.maintenance.enabled);
  document.querySelector('#student-footer').textContent = `${t('privacy')} ${t('retention')}`;
}
function render() {
  if (initial) return;
  clearAdvertisements();
  const active = document.activeElement, selection = {start:active?.selectionStart,end:active?.selectionEnd};
  let focusSelector = null;
  if (content.contains(active)) {
    if (active.id) focusSelector = '#'+CSS.escape(active.id);
    else if (active.name) { const parent = active.closest('[data-file-key]') || active.closest('form');
      focusSelector = (parent?.dataset.fileKey?`[data-file-key="${parent.dataset.fileKey}"] `:parent?.id?'#'+CSS.escape(parent.id)+' ':'')+`[name="${CSS.escape(active.name)}"]`;
    }
    else if(active.dataset.action)focusSelector=`[data-action="${CSS.escape(active.dataset.action)}"]`;
  }
  updateShell(); content.setAttribute('aria-busy',String(s.loading));
  content.innerHTML = s.route === 'home'?views.home(s):s.route === 'print'?views.print(s):s.route === 'me'?views.me(s):s.route==='support'?views.support(s):s.routeId?views.orderDetail(s):views.orderList(s);
  // Original advertisement positions: after the home hero and below print/order pages. No empty DOM slots.
  if(s.order&&s.route==='orders'&&s.routeId){
    bindPayment(content,s.order.payment,value=>{s.paymentChannel=value;const button=content.querySelector('[data-action=payment]');if(button)button.disabled=s.paymentBusy||!s.actionIntents.has(s.order.id+':payment')&&!value;});
    if(s.paymentBusy||s.actionIntents.has(s.order.id+':payment'))content.querySelector('[name=paymentChannel]')?.setAttribute('disabled','');
  }
  bindDefaultReceipt(content.querySelector('#defaults-form'));
  renderPreview();
  if (focusSelector) { const next=content.querySelector(focusSelector); if (next && !next.disabled) { next.focus({preventScroll:true}); try{next.setSelectionRange(selection.start,selection.end);}catch{} } }
}
async function loadView({identity = true} = {}) {
  const seq = ++viewSequence, epoch = s.epoch, route = s.route, id = s.routeId;
  s.viewError = null; s.loading = true; render();
  try {
    if (identity) {
      await readIdentity();
      if (epoch !== s.epoch) { render(); return; }
      if (seq !== viewSequence) return;
    }
    if (route === 'home') {
      void loadAnnouncement();
      await loadConfig();
    } else if (route === 'me' && s.user) {
      await loadDefaults();
    } else if (route === 'support' && s.user) {
      const orders=await request('/me/orders?page=1&pageSize=100');
      if(!owned(epoch)||seq!==viewSequence)return;
      s.supportOrders=orders;
      s.supportOrderId=id||'';s.supportOrder=null;s.tickets=null;s.ticketsError=null;
      if(id){const order=await request('/me/orders/'+id);if(!owned(epoch)||seq!==viewSequence)return;s.supportOrder=order;}
      await loadTickets(false,s.ticketPage);
    } else if (route === 'orders' && s.user) {
      if (id) {
        const order = await request('/me/orders/'+id); if (!owned(epoch)||seq!==viewSequence) return;
        s.order = order; syncOrderCodes(); await loadConfig(); if(!owned(epoch)||seq!==viewSequence)return; scheduleOrderExpiry(order);
        await loadTickets(true,s.orderTicketPage,id);
        if (!views.filesAvailable(order)) removePreview();
      } else {
        const query = new URLSearchParams({page:String(s.filters.page),pageSize:'10'});
        if (s.filters.q) query.set('q',s.filters.q); if (s.filters.status) query.set('fulfillmentStage',s.filters.status);
        const orders=await request('/me/orders?'+query); if (!owned(epoch)||seq!==viewSequence) return; s.orders=orders;
      }
    } else if (route === 'print') {await loadConfig();if(seq===viewSequence&&owned(epoch)){for(const row of s.files)if(row.file?.status==='processing')pollFile(row,epoch);uploadSelected();schedulePrepare();}}
  } catch(error) { if (epoch===s.epoch&&seq===viewSequence) s.viewError=error; }
  finally { if (epoch===s.epoch&&seq===viewSequence) {s.loading=false; render();} }
}
async function navigate() {
  const next = routeFromHash();
  if(next.route==='support'&&(s.route!=='support'||next.id!==s.routeId))s.ticketPage=1;
  if(s.route==='print'&&(next.route!=='print'||next.id!==s.routeId)){invalidateQuote();for(const timer of fileTimers.values())clearTimeout(timer);fileTimers.clear();}
  if (next.route!==s.route || next.id!==s.routeId) { removePreview(); clearTimeout(orderExpiryTimer); s.order=null; s.orderTickets=null; s.orderTicketPage=1; s.orderCodes={query:null,compensation:null};s.cancelError=null; }
  s.route=next.route; s.routeId=next.id; await loadView();
  if (!document.querySelector('dialog[open]')) { content.focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'}); }
}
async function loadTickets(forOrder = false, page = 1, orderId = s.supportOrderId || s.routeId) {
  const epoch = s.epoch, id = orderId, route=s.route, seq=viewSequence;
  if (!s.user) return;
  const query = new URLSearchParams({page:String(page),pageSize:'10'});
  if(!forOrder&&s.route==='support'&&s.routeId)query.set('orderId',s.routeId);
  try { const value=await request(forOrder?'/me/orders/'+id+'/tickets?'+query:'/me/tickets?'+query); if(!owned(epoch)||route!==s.route||seq!==viewSequence|| (forOrder&&s.supportOrderId!==id&&s.routeId!==id)) return;
    if(forOrder)s.orderTickets=value;else s.tickets=value;s.ticketsError=null;
  }catch(error){if(owned(epoch)&&route===s.route&&seq===viewSequence){if(forOrder){s.orderTickets=null;s.ticketsError=error;}else s.ticketsError=error;}}
}
async function refreshOrder({full = false} = {}) {
  if(!s.user||s.route!=='orders'||!s.routeId)return;
  const epoch=s.epoch,id=s.routeId;
  try {
    const value=await request('/me/orders/'+id);
    if(!owned(epoch)||s.route!=='orders'||s.routeId!==id)return;
    const changed=full||!s.order||s.order.version!==value.version||s.order.fileAvailability!==value.fileAvailability||JSON.stringify(s.order.compensation)!==JSON.stringify(value.compensation);
    s.order=value; syncOrderCodes(); scheduleOrderExpiry(value);
    if(!views.filesAvailable(value))removePreview();
    if(changed){await loadConfig();render();}
  }catch(error){if(owned(epoch))tell(failure(error),true);}
}
function scheduleOrderExpiry(order) {
  clearTimeout(orderExpiryTimer);
  if (!order.filesExpireAt || !views.filesAvailable(order)) return;
  orderExpiryTimer=setTimeout(()=>{
    if(s.order?.id!==order.id)return;
    s.order.fileAvailability='expired'; removePreview(); tell(t('fileExpired')); render(); refreshOrder();
  },Math.min(Math.max(0,Date.parse(order.filesExpireAt)-Date.now()),2147483647));
}
function invalidateQuote(message = false) {
  s.revision++; quoteSequence++; clearTimeout(preparationTimer); clearTimeout(quoteTimer); clearTimeout(quoteExpiryTimer);
  s.quote=null;s.quoteRevision=null;s.quoteIntent=null;s.quoteError=null;s.quoteBusy=false;s.seen.clear();s.confirmedPreview=false;
  if(preview?.context==='quote')removePreview();
  if(message)tell(t('paramsChanged'));
}
function printable() {
  const count=views.selectionCount(s.files);
  return s.route==='print'&&s.config?.acceptingOrders&&!s.config?.maintenance.enabled&&!s.orderIntent&&!s.orderBusy&&s.files.length&&s.files.every(row=>row.file?.status==='ready'&&!row.error)&&Number.isInteger(count)&&count>=1&&count<=99;
}
function schedulePrepare(delay=350) {
  clearTimeout(preparationTimer);
  if(!printable()||s.quoteBusy||s.quoteRevision===s.revision||s.quoteError)return;
  preparationTimer=setTimeout(()=>prepare(),delay);
}
function selectFiles(selected) {
  if(s.orderIntent||s.orderBusy||!s.config?.acceptingOrders||s.config?.maintenance.enabled)return;
  for(const file of selected){
    if(s.files.length>=(s.config?.maxQuoteItems||20)){tell(t('limitCount',{count:s.config?.maxQuoteItems||20,temporary:s.config?.uploadLimits.maxTemporaryFilesPerUser||20}),true);break;}
    const row={key:freshKey(),name:file.name,size:file.size,local:file,file:null,pages:'all',copies:s.defaults?.copies||1,duplex:s.defaults?.duplex||false,phase:'local',progress:0,error:null};
    const extension=file.name.split('.').pop().toLowerCase();
    if(!['pdf','jpg','jpeg','png'].includes(extension)){row.error={status:415,code:'FILE_UNSUPPORTED_FORMAT'};row.validationError=true;}
    else if(!file.size){row.error={status:400,code:'FILE_EMPTY'};row.validationError=true;}
    else if(s.config&&file.size>s.config.uploadLimits.maxFileBytes){row.error={status:413,code:'FILE_SIZE_LIMIT'};row.validationError=true;}
    s.files.push(row);
  }
  invalidateQuote();render();uploadSelected();
}
async function uploadSelected(onlyKey=null) {
  if(s.uploadBusy||s.orderIntent||s.orderBusy||s.route!=='print'||!s.config?.acceptingOrders||s.config?.maintenance.enabled)return;
  if(onlyKey){const row=s.files.find(value=>value.key===onlyKey);if(row&&!row.validationError){row.error=null;row.phase='local';}}
  if(!s.files.some(row=>row.local&&!row.file&&!row.validationError&&!row.error))return;
  s.uploadBusy=true;render();const epoch=s.epoch;
  try{
    await ensureUser();if(!owned(epoch))return;
    for(const row of s.files)if(row.local&&row.error?.code==='AUTH_REQUIRED'){row.error=null;row.phase='local';}
    while(owned(epoch)&&s.route==='print'&&s.config?.acceptingOrders&&!s.config?.maintenance.enabled){
      const row=s.files.find(value=>value.local&&!value.file&&!value.validationError&&!value.error&&value.phase!=='uploading');if(!row)break;
      row.phase='uploading';row.progress=0;render();
      try{
        const source=await upload(row.local,value=>{if(owned(epoch)&&s.files.includes(row)){row.progress=value;if(s.route==='print')render();}});
        if(!owned(epoch))return;
        if(!s.files.includes(row)){request('/files/'+source.id,{method:'DELETE',body:{}}).catch(()=>{});continue;}
        row.file=source;row.phase=source.status;row.local=null;
        if(s.route==='print'){render();pollFile(row,epoch);}
      }catch(error){if(owned(epoch)&&s.files.includes(row)){row.phase='error';row.error=error;if(error.code==='ORDERS_PAUSED')await loadConfig();if(s.route==='print')render();if(uncertain(error))tell(t('uploadUncertain'),true);}}
    }
  }catch(error){if(epoch===s.epoch){for(const row of s.files)if(row.local&&!row.file&&!row.validationError&&!row.error)row.error=error.code==='USER_CANCELLED'?{code:'AUTH_REQUIRED',status:401}:error;if(error.code!=='USER_CANCELLED')tell(failure(error),true);}}
  finally{if(epoch===s.epoch){s.uploadBusy=false;if(s.route==='print'){render();schedulePrepare();}}}
}
async function pollFile(row,epoch=s.epoch) {
  clearTimeout(fileTimers.get(row.key));
  if(!row?.file||!owned(epoch)||!s.files.includes(row)||s.route!=='print')return;
  try{
    const source=await request('/files/'+row.file.id);
    if(!owned(epoch)||!s.files.includes(row)||s.route!=='print')return;
    row.file=source;row.phase=source.status;row.error=source.error;
    if(source.status!=='processing'&&source.status!=='ready')invalidateQuote();
    render();
    if(source.status==='processing')fileTimers.set(row.key,setTimeout(()=>pollFile(row,epoch),1000));
    else if(source.status==='ready')schedulePrepare();
  }catch(error){if(owned(epoch)&&s.files.includes(row)&&s.route==='print'){row.error=error;invalidateQuote();render();}}
}
async function removeFile(row) {
  if(!row||s.orderIntent||s.orderBusy)return;
  const epoch=s.epoch,index=s.files.indexOf(row);clearTimeout(fileTimers.get(row.key));fileTimers.delete(row.key);
  s.files=s.files.filter(value=>value!==row);invalidateQuote();render();schedulePrepare();
  try{if(row.file){await ensureUser();if(!owned(epoch))return;await request('/files/'+row.file.id,{method:'DELETE',body:{}});}}
  catch(error){if(owned(epoch)){s.files.splice(index,0,row);invalidateQuote();render();tell(failure(error),true);}}
}
async function prepare() {
  clearTimeout(preparationTimer);
  if(!printable()||s.quoteBusy)return;
  if(s.quote&&(s.quote.status==='failed'||!s.quote.valid&&s.quote.status!=='processing'))s.quoteIntent=null;
  const epoch=s.epoch,revision=s.revision,seq=++quoteSequence;
  const current=()=>owned(epoch)&&s.route==='print'&&revision===s.revision&&seq===quoteSequence;
  s.quoteBusy=true;s.quoteError=null;render();
  try{
    await ensureUser();if(!current())return;
    await loadConfig();if(!current())return;
    if(s.configError)throw s.configError;
    if(!s.config?.acceptingOrders||s.config?.maintenance.enabled)throw {status:409,code:s.config?.maintenance.enabled?'MAINTENANCE':'ORDERS_PAUSED'};
    const code=normalizeCode(s.couponCode);
    if(code&&!validCode(code,25))throw Object.assign(new Error(t('couponFormat')),{code:'COUPON_FORMAT'});
    const body={items:s.files.map(row=>({fileId:row.file.id,pages:row.pages.trim(),copies:Number(row.copies),duplex:row.duplex})),...(code?{couponCode:code}:{})};
    if(!s.quoteIntent||s.quoteIntent.revision!==revision)s.quoteIntent={revision,body,key:freshKey()};
    const intent=s.quoteIntent;s.quote=null;s.quoteRevision=revision;s.seen.clear();s.confirmedPreview=false;
    const quote=await request('/print/quotes',{method:'POST',body:intent.body,headers:{'Idempotency-Key':intent.key}});
    if(!current())return;s.quote=quote;await pollQuote(quote.id,epoch,seq,revision);
  }catch(error){if(current()){s.quoteError=error;s.quote=null;s.quoteRevision=null;s.seen.clear();s.confirmedPreview=false;if(!uncertain(error))s.quoteIntent=null;tell(failure(error),true);if(error.status===410)await Promise.all(s.files.map(row=>pollFile(row,epoch)));}}
  finally{if(current()){s.quoteBusy=false;render();}}
}
async function pollQuote(id,epoch=s.epoch,seq=quoteSequence,revision=s.revision) {
  clearTimeout(quoteTimer);
  const current=()=>owned(epoch)&&s.route==='print'&&seq===quoteSequence&&revision===s.revision;
  try{
    const quote=await request('/print/quotes/'+id);if(!current())return;
    s.quote=quote;s.quoteRevision=revision;s.quoteError=null;
    if(quote.status==='ready'&&quote.valid)tell('');
    if(!quote.valid){s.confirmedPreview=false;s.seen.clear();if(preview?.context==='quote')removePreview();}
    render();
    if(quote.status==='processing'&&(!quote.invalidReason||quote.invalidReason==='QUOTE_PROCESSING'))quoteTimer=setTimeout(()=>pollQuote(id,epoch,seq,revision),1000);
    else if(quote.status==='ready'&&quote.valid){
      clearTimeout(quoteExpiryTimer);quoteExpiryTimer=setTimeout(()=>{if(current()&&s.quote?.id===id&&!s.orderIntent){s.quote.valid=false;s.confirmedPreview=false;s.seen.clear();removePreview();tell(t('quoteExpired'),true);render();}},Math.min(Math.max(0,Date.parse(quote.expiresAt)-Date.now()),2147483647));
    }
  }catch(error){if(current()){s.quoteError=error;s.confirmedPreview=false;s.seen.clear();tell(failure(error),true);render();}}
}
async function createOrder() {
  if(s.orderBusy)return;
  s.orderBusy=true;render();let activeEpoch=s.epoch;
  try{
    await ensureUser();const epoch=s.epoch;activeEpoch=epoch;
    if(!s.orderIntent){
      if(!s.quote?.valid||s.quote.status!=='ready'||s.quoteRevision!==s.revision||!s.confirmedPreview||!s.quote.items.every(item=>s.seen.has(item.itemId)))return;
      const quoteId=s.quote.id,revision=s.revision,address={...s.address};
      const quote=await request('/print/quotes/'+s.quote.id);
      if(!owned(epoch)||s.route!=='print'||s.revision!==revision||s.quote?.id!==quoteId)return;
      if(!quote.valid||quote.fingerprint!==s.quote.fingerprint){s.quote=quote;s.confirmedPreview=false;s.seen.clear();removePreview();tell(quote.invalidReason?failure({code:quote.invalidReason,message:t('quoteExpired')}):t('quoteExpired'),true);render();return;}
      if(!address.room.trim()||!['handover','contact_first','doorstep','other'].includes(address.receiptMethod)||address.receiptMethod==='contact_first'&&!address.contact.trim()||address.receiptMethod==='other'&&!address.receiptNote.trim()){tell(t('receiptMissing'),true);return;}
      const deliveryAddress={buildingId:s.config.building.id,room:address.room.trim(),contact:address.contact.trim(),receiptMethod:address.receiptMethod,receiptNote:address.receiptNote.trim()};
      s.orderIntent={key:freshKey(),owner:s.user.id,revision,body:{quoteId:quote.id,quoteFingerprint:quote.fingerprint,deliveryAddress,confirmedPreview:true}};
    }
    const intent=s.orderIntent;
    if(intent.owner!==s.user.id)return;
    s.orderBusy=true;render();
    try{
      const result=await request('/orders',{method:'POST',body:intent.body,headers:{'Idempotency-Key':intent.key}});
      if(!owned(epoch))return;
      s.orderIntent=null;removePreview();clearTimeout(quoteTimer);clearTimeout(quoteExpiryTimer);
      s.files=[];s.quote=null;s.quoteRevision=null;s.quoteIntent=null;s.couponCode='';s.seen.clear();s.confirmedPreview=false;
      s.address={...s.address,receiptMethod:s.defaults?.receiptMethod||'',receiptNote:s.defaults?.receiptNote||''};
      if(!owned(epoch))return;
      s.orderBusy=false;tell(t('orderCreated'));location.hash='orders/'+result.id;
    }catch(error){if(owned(epoch)){if(!uncertain(error))s.orderIntent=null;
      if(['QUOTE_EXPIRED','QUOTE_ALREADY_USED','QUOTE_CONFIRMATION_MISMATCH','QUOTE_PRICING_CHANGED','COUPON_INVALID','COUPON_UNAVAILABLE','COUPON_THRESHOLD_NOT_MET','COUPON_ZERO_TOTAL','FILE_EXPIRED'].includes(error.code)){if(s.quote)s.quote.valid=false;s.confirmedPreview=false;s.seen.clear();removePreview();}
      if(['ORDERS_PAUSED','MAINTENANCE'].includes(error.code)){s.confirmedPreview=false;s.seen.clear();await loadConfig();}
      tell(uncertain(error)?t('uncertain'):failure(error),true);}}
    finally{if(owned(epoch)){s.orderBusy=false;render();}}
  }catch(error){if(error.code!=='USER_CANCELLED')tell(failure(error),true);}
  finally{if(activeEpoch===s.epoch){s.orderBusy=false;render();}}
}
function renderPreview() {
  const host=document.querySelector('#preview-host');if(!host||!preview)return;
  const p=preview;
  const active=document.activeElement;
  const focus=host.contains(active)?active.name?`[name="${CSS.escape(active.name)}"]`:active.dataset.action?`[data-action="${CSS.escape(active.dataset.action)}"]`:null:null;
  host.innerHTML=`<section class="preview-panel" aria-labelledby="preview-title"><div class="preview-heading"><div><h2 id="preview-title">${e(t('previewTitle'))}</h2><p>${e(p.item.originalName)}</p></div>${views.button('close-preview','close','class="button small"')}</div><p class="hint">${e(t('previewRules'))}</p><form id="preview-form" class="preview-controls">${views.field('page','productionPage',p.page,`required min="1" max="${p.item.selectedPageCount}" step="1"${p.loading?' disabled':''}`,'number')}<button class="button" type="submit"${p.loading?' disabled':''}>${e(t('viewPage'))}</button>${views.button('preview-prev','previousPage',p.page<=1||p.loading?'disabled':'')}${views.button('preview-next','nextPage',p.page>=p.item.selectedPageCount||p.loading?'disabled':'')}${views.button('zoom-preview','zoom','class="button small"')}</form><p class="preview-page-readout">${e(t('previewReadout',{page:p.page,total:p.item.selectedPageCount,source:p.item.pageNumbers[p.page-1]}))}</p><div class="preview-surface">${p.url?`<img class="production-preview${p.zoom?' zoom':''}" id="production-preview" src="${e(p.url)}" alt="${e(p.item.originalName)} · ${e(t('productionPage'))} ${p.page}">`:`<p class="preview-status${p.error?' error':''}" role="status">${p.error?e(failure(p.error)):e(t('previewLoading'))}</p>${p.error?views.button('retry-preview','retry'):''}`}</div></section>`;
  if(focus)host.querySelector(focus)?.focus({preventScroll:true});
}
async function showPreview(context,itemId,page=1) {
  const epoch=s.epoch,revision=s.revision;let attemptSequence=null,parentId=null;
  try{
    await ensureUser();if(!owned(epoch))return;
    const parent=context==='quote'?s.quote:s.order;
    parentId=parent?.id;
    if(context==='order'&&(parent?.accessType==='recovered'||!parent?.allowedActions.includes('preview')))return;
    if(!parent|| (context==='quote'&&!parent.valid) || (context==='order'&&!views.filesAvailable(parent)))throw Object.assign(new Error(t('fileExpired')),{status:410});
    const item=parent.items.find(value=>value.itemId===itemId);
    if(!item||!Number.isInteger(page)||page<1||page>item.selectedPageCount)return;
    const zoom=preview?.zoom||false;removePreview();const seq=previewSequence;attemptSequence=seq;
    preview={context,id:parent.id,item,page,loading:true,url:null,error:null,zoom};renderPreview();
    const host=document.querySelector('#preview-host');host?.scrollIntoView({block:'start',behavior:'instant'});
    host?.querySelector('[name=page]')?.focus({preventScroll:true});
    const route=context==='quote'?`/print/quotes/${parent.id}`:`/me/orders/${parent.id}`;
    const url=await binaryUrl(`${route}/items/${itemId}/preview?page=${page}`);
    if(!owned(epoch)||seq!==previewSequence||preview?.id!==parent.id){releaseUrl(url);return;}
    // Do not confirm a stale quote or an expired order even when the response arrived late.
    if(context==='quote'&&(!s.quote?.valid||s.quote.id!==parent.id)||context==='order'&&!views.filesAvailable(s.order)){releaseUrl(url);removePreview();return;}
    preview.url=url;preview.loading=false;renderPreview();
    const image=document.querySelector('#production-preview');
    const markViewed=()=>{if(context==='quote'&&owned(epoch)&&s.quote?.id===parent.id&&s.quote.valid){s.seen.add(itemId);updateConfirmation();document.querySelector('#quote-summary').innerHTML=views.quoteSummary(s);}};
    image?.addEventListener('load',markViewed,{once:true});
    image?.addEventListener('error',()=>{if(seq===previewSequence){releaseUrl(preview?.url);preview.url=null;preview.error={status:422,message:t('previewUnavailable')};renderPreview();}},{once:true});
    if(image?.complete&&image.naturalWidth)markViewed();
  }catch(error){
    const sameParent=context==='quote'?s.route==='print'&&s.quote?.id===parentId&&revision===s.revision:s.route==='orders'&&s.order?.id===parentId;
    // A real 410 clears private URLs before rejecting; it still belongs to this order/revision.
    if(!owned(epoch)||!sameParent||error.status!==410&&attemptSequence!==null&&attemptSequence!==previewSequence)return;
    if(preview){preview.loading=false;preview.error=error;renderPreview();}
    if(error.status===410){removePreview();if(context==='order'){if(s.order)s.order.fileAvailability='expired';await refreshOrder({full:true});}else{invalidateQuote();render();}tell(t('fileExpired'),true);}
    else if(error.code!=='USER_CANCELLED')tell(failure(error),true);
  }
}
function updateConfirmation() {
  const form=document.querySelector('#confirm-order');if(!form)return;
  const ready=s.quote?.status==='ready'&&s.quote.valid;
  const all=ready&&s.quote.items.every(item=>s.seen.has(item.itemId));
  form.elements.confirmedPreview.disabled=!all;
  document.querySelector('#preview-required')?.toggleAttribute('hidden',!!all);
  form.querySelector('#create-order').disabled=s.orderBusy||(!s.orderIntent&&(!ready||s.quoteRevision!==s.revision||!all||!s.confirmedPreview||!s.config?.acceptingOrders||s.config?.maintenance.enabled));
}
async function downloadItem(itemId,button) {
  const epoch=s.epoch,order=s.order;button.disabled=true;
  let url;
  try{await ensureUser();if(!owned(epoch)||!order||order.accessType==='recovered'||!order.allowedActions.includes('download')||!views.filesAvailable(order))return;
    url=await binaryUrl(`/me/orders/${order.id}/items/${itemId}/file`);
    if(!owned(epoch)||!views.filesAvailable(order)){releaseUrl(url);return;}
    const item=order.items.find(value=>value.itemId===itemId),anchor=document.createElement('a');anchor.href=url;anchor.download=item.originalName.replace(/\.[^.]+$/,'')+'-print.pdf';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>releaseUrl(url),1000);
  }catch(error){releaseUrl(url);tell(failure(error),true);if(error.status===410&&owned(epoch)){removePreview();s.order.fileAvailability='expired';render();await refreshOrder({full:true});}}
  finally{if(button.isConnected)button.disabled=false;}
}
async function submitPayment() {
  if(s.paymentBusy||!s.order)return;
  const epoch=s.epoch,order=s.order,mapKey=order.id+':payment';
  let intent=s.actionIntents.get(mapKey);
  if(!intent&&(!order.allowedActions.includes('submit_payment')||!s.paymentChannel))return;
  if(!intent){const draft=s.paymentDraft?.orderId===order.id?s.paymentDraft:{reference:'',note:''};intent={key:freshKey(),body:{expectedVersion:order.version,channel:s.paymentChannel,reference:draft.reference.trim(),note:draft.note.trim()}};s.actionIntents.set(mapKey,intent);}
  s.paymentBusy=true;s.paymentError='';tell('');render();
  try{
    await ensureUser();if(!owned(epoch))return;
    await request('/me/orders/'+order.id+'/payment-submissions',{method:'POST',body:intent.body,headers:{'Idempotency-Key':intent.key}});
    const updated=await request('/me/orders/'+order.id);
    if(!owned(epoch))return;s.actionIntents.delete(mapKey);
    if(s.route==='orders'&&s.routeId===order.id){s.order=updated;scheduleOrderExpiry(updated);s.paymentDraft=null;s.paymentError='';tell('');}
  }catch(error){if(owned(epoch)){
    if(uncertain(error)){s.paymentError=t('actionUncertain');}
    else{s.actionIntents.delete(mapKey);s.paymentError=failure(error);await refreshOrder({full:true});}
  }}finally{if(owned(epoch)){s.paymentBusy=false;render();}}
}
async function openFeedback() {
  if(actionDialogOpen)return;actionDialogOpen=true;
  try{
    await ensureUser();const epoch=s.epoch,defaultOrder=s.supportOrder||s.order,previous=s.actionIntents.get('feedback');
    const orders=s.supportOrders?.items||[];
    let category=previous?.category||(defaultOrder?'order':'general');
    const bodyFields=kind=>{
      if(kind==='general')return feedbackFields({category:'general'})+views.textarea('message','ticketMessage','','required maxlength="4000"');
      const options=defaultOrder&&!orders.some(value=>value.id===defaultOrder.id)?[defaultOrder,...orders]:orders;
      return '<label class="field"><span>'+e(t('supportOrder'))+'</span><select name="orderId" required><option value="">'+e(t('selectOrder'))+'</option>'+options.filter(order=>order.allowedActions.includes('create_ticket')).map(order=>'<option value="'+e(order.id)+'" '+(order.id===defaultOrder?.id?'selected':'')+'>'+e(order.orderNo)+'</option>').join('')+'</select></label>'+feedbackFields()+views.field('subject','ticketSubject','','required maxlength="120"')+views.textarea('message','ticketMessage','','required maxlength="4000"');
    };
    const html='<label class="field"><span>'+e(t('supportCategory'))+'</span><select name="category"><option value="order" '+(category==='order'?'selected':'')+'>'+e(t('orderFeedback'))+'</option><option value="general" '+(category==='general'?'selected':'')+'>'+e(t('generalFeedback'))+'</option></select></label><div data-feedback-fields>'+bodyFields(category)+'</div>';
    const modal=showDialog(t('newFeedback'),t('feedbackLifetime'),html,async(values,dialog,setLocked)=>{
      if(!owned(epoch))throw cancelled();
      let intent=s.actionIntents.get('feedback');
      if(!intent){const contact=values.contactType||values.contactValue?{contactType:values.contactType,contactValue:values.contactValue}:{};
        const general=values.category==='general',body=general?{message:values.message,...contact}:{subject:values.subject,message:values.message,feedbackType:values.feedbackType,...contact};
        intent={key:freshKey(),category:values.category,orderId:general?null:values.orderId,body,path:general?'/me/feedback':'/me/orders/'+values.orderId+'/tickets'};s.actionIntents.set('feedback',intent);}
      try{
        await request(intent.path,{method:'POST',body:intent.body,headers:{'Idempotency-Key':intent.key}});
        if(!owned(epoch))throw cancelled();s.actionIntents.delete('feedback');
        s.ticketPage=1;
        if(intent.category==='general'&&s.routeId){location.hash='support';}else await loadView({identity:false});
        tell(t('feedbackCreated'));return true;
      }catch(error){if(!owned(epoch))throw cancelled();if(uncertain(error)){setLocked(true);error.displayMessage=t('feedbackUncertain');}else{s.actionIntents.delete('feedback');setLocked(false);}throw error;}
    });
    bindFeedback(modal.form);
    const drafts={};
    modal.form.elements.category.onchange=()=>{drafts[category]=Object.fromEntries(new FormData(modal.form));category=modal.form.elements.category.value;modal.form.querySelector('[data-feedback-fields]').innerHTML=bodyFields(category);for(const[name,value]of Object.entries(drafts[category]||{}))if(modal.form.elements[name]&&name!=='category')modal.form.elements[name].value=value;bindFeedback(modal.form);};
    if(previous){modal.form.elements.category.value=previous.category;for(const[name,value]of Object.entries({...previous.body,orderId:previous.orderId}))if(modal.form.elements[name])modal.form.elements[name].value=value;modal.setLocked(true);modal.form.querySelector('[role=alert]').textContent=t('feedbackUncertain');}
    modal.result.finally(()=>{actionDialogOpen=false;}).catch(()=>{});
  }catch(error){actionDialogOpen=false;if(error.code!=='USER_CANCELLED')tell(failure(error),true);}
}
async function showTicketDetail(id,button) {
  if(actionDialogOpen)return;actionDialogOpen=true;const epoch=s.epoch,seq=viewSequence;button.disabled=true;
  try{
    const ticket=await request('/me/tickets/'+id);if(!owned(epoch)||seq!==viewSequence)return;
    const modal=showDialog(t('ticketDetail'),t('ticket_'+ticket.status),views.ticketCards({items:[ticket]},{detail:true}),()=>true,{readOnly:true,first:'[data-submit]'});
    await modal.result;
  }catch(error){if(owned(epoch)&&seq===viewSequence&&error.code!=='USER_CANCELLED')tell(failure(error),true);}
  finally{actionDialogOpen=false;if(button.isConnected)button.disabled=false;}
}
async function orderAction(kind) {
  if(kind==='payment')return submitPayment();
  if(kind==='ticket')return openFeedback();
  if(kind!=='cancel'||!s.order||s.cancelBusy===s.order.id)return;
  const epoch=s.epoch,order=s.order,mapKey=order.id+':cancel';
  let intent=s.actionIntents.get(mapKey);
  if(order.accessType==='recovered'||!intent&&(!order.allowedActions.includes('request_cancel')||!['direct','review'].includes(order.cancellation?.requestMode)))return;
  if(!intent){intent={key:freshKey(),body:{expectedVersion:order.version}};s.actionIntents.set(mapKey,intent);}
  s.cancelBusy=order.id;s.cancelError=null;tell('');render();
  try {
    await ensureUser();if(!owned(epoch))return;
    await request('/me/orders/'+order.id+'/cancel-requests',{method:'POST',body:intent.body,headers:{'Idempotency-Key':intent.key}});
    const updated=await request('/me/orders/'+order.id);
    if(!owned(epoch))return;s.actionIntents.delete(mapKey);
    if(s.route!=='orders'||s.routeId!==order.id)return;
    s.order=updated;
    if(updated.lifecycle==='cancelled'){
      s.cancelNotice={orderId:order.id,couponReturned:updated.events?.some(event=>event.data?.originalCouponReleased)};
      s.filters={q:'',status:'',page:1};location.hash='orders';
    }else{syncOrderCodes();tell(t('cancelSubmitted'));}
  }catch(error){if(owned(epoch)&&s.route==='orders'&&s.routeId===order.id){
    if(uncertain(error))s.cancelError={orderId:order.id,message:t('actionUncertain')};
    else{s.actionIntents.delete(mapKey);s.cancelError={orderId:order.id,message:failure(error)};await refreshOrder({full:true});}
  }}finally{if(owned(epoch)){s.cancelBusy=null;render();}}
}
async function saveProfile(form,kind) {
  const epoch=s.epoch,owner=s.user?.id,values=Object.fromEntries(new FormData(form)),button=form.querySelector('[type=submit]');
  if(button.disabled)return;button.disabled=true;tell('');
  try{
    await ensureUser();if(!owned(epoch)||owner!==s.user.id)return;
    const value=kind==='nickname'
      ?await request('/me/profile',{method:'PATCH',body:{nickname:values.nickname}})
      :await request('/me/print-defaults',{method:'PATCH',body:{buildingId:s.config?.building.id||'local-dorm',room:values.room,contact:values.contact,receiptMethod:values.receiptMethod||null,receiptNote:values.receiptMethod==='other'?values.receiptNote.trim():'',copies:Number(values.copies),duplex:values.duplex==='true'}});
    if(!owned(epoch))return;if(kind==='nickname')s.user=value;else{s.defaults=value;if(!s.files.length&&!s.orderIntent&&!s.orderBusy)s.address={...s.address,...addressFromDefaults(value)};}tell(t('saved'));render();
  }catch(error){tell(failure(error),true);}finally{if(button.isConnected)button.disabled=false;}
}

content.addEventListener('input',event=>{
  const input=event.target,row=s.files.find(value=>value.key===input.closest('[data-file-key]')?.dataset.fileKey);
  if(input.name==='couponCode'&&!s.orderIntent&&!s.orderBusy){s.couponCode=input.value;invalidateQuote(true);render();schedulePrepare();return;}
  if(row&&['pages','copies','duplex'].includes(input.name)&&!s.orderIntent&&!s.orderBusy){row[input.name]=input.name==='duplex'?input.value==='true':input.value;invalidateQuote(true);render();schedulePrepare();return;}
  if(['paymentReference','paymentNote'].includes(input.name)&&!s.paymentBusy&&!s.actionIntents.has(s.order?.id+':payment')){if(s.paymentDraft?.orderId!==s.order?.id)s.paymentDraft={orderId:s.order?.id,reference:'',note:''};s.paymentDraft[input.name==='paymentReference'?'reference':'note']=input.value;}
  if(input.closest('#confirm-order')){
    if(['room','contact','receiptNote'].includes(input.name))s.address[input.name]=input.value;
    if(input.name==='receiptMethod'){s.address.receiptMethod=input.value;render();}
    if(input.name==='confirmedPreview'){s.confirmedPreview=input.checked;updateConfirmation();}
  }
});
content.addEventListener('change',event=>{
  const control=event.target;
  if(control.id==='student-files')selectFiles([...control.files]);
  if(control.id==='theme-control'){document.documentElement.dataset.theme=control.value;localStorage.setItem('campusprint.theme',control.value);}
  if(control.id==='language-control')setLanguage(control.value);
  if(control.name==='supportOrder'){s.supportOrderId=control.value;s.orderTicketPage=1;location.hash='support/'+control.value;}
});
content.addEventListener('submit',event=>{
  event.preventDefault();const form=event.target;
  if(form.id==='confirm-order')createOrder();
  else if(form.id==='preview-form')showPreview(preview.context,preview.item.itemId,Number(form.elements.page.value));
  else if(form.id==='order-filter'){s.filters={q:form.elements.q.value.trim(),status:form.elements.status.value,page:1};loadView();}
  else if(form.id==='nickname-form')saveProfile(form,'nickname');
  else if(form.id==='defaults-form')saveProfile(form,'defaults');
  else if(form.id==='recover-form')recoverOrder(form);
});
content.addEventListener('click',async event=>{
  const orderButton=event.target.closest('[data-order]');if(orderButton){location.hash='orders/'+orderButton.dataset.order;return;}
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action,row=s.files.find(value=>value.key===button.closest('[data-file-key]')?.dataset.fileKey);
  if(action==='login'){try{await signIn();await loadView({identity:false});}catch(error){tell(failure(error),true);} }
  else if(action==='logout')logout();
  else if(action==='account-security'&&s.user?.identityKind!=='guest'&&s.publicConfig?.studentAccountsEnabled)openAccountSecurity(s.user);
  else if(action==='load-query-code')loadOrderCode('query');
  else if(action==='load-compensation-code')loadOrderCode('compensation');
  else if(action==='copy-query-code')copyOrderCode('query');
  else if(action==='copy-compensation-code')copyOrderCode('compensation');
  else if(action==='reload-announcement')loadAnnouncement();
  else if(action==='remove-coupon'&&!s.orderIntent){s.couponCode='';invalidateQuote(true);render();schedulePrepare();}
  else if(action==='support-orders-page'){s.ticketPage=Number(button.dataset.page);loadView();}
  else if(action==='upload')uploadSelected();
  else if(action==='retry-upload')uploadSelected(row?.key);
  else if(action==='check-file')pollFile(row);
  else if(action==='remove-file')removeFile(row);
  else if(action==='prepare')prepare();
  else if(action==='reload-view')loadView();
  else if(action==='reload-config'){await loadConfig();render();uploadSelected();schedulePrepare();}
  else if(action==='orders-page'){s.filters.page=Number(button.dataset.page);loadView();}
  else if(action==='tickets-page'){s.ticketPage=Number(button.dataset.page);await loadTickets(false,s.ticketPage);render();}
  else if(action==='order-tickets-page'){s.orderTicketPage=Number(button.dataset.page);await loadTickets(true,s.orderTicketPage);render();}
  else if(action==='reload-tickets'){await loadTickets(false,s.ticketPage);render();}
  else if(action==='quote-preview')showPreview('quote',button.dataset.item);
  else if(action==='order-preview')showPreview('order',button.dataset.item);
  else if(action==='close-preview'){const old=preview;removePreview();if(old)document.querySelector(`[data-action="${old.context==='quote'?'quote-preview':'order-preview'}"][data-item="${old.item.itemId}"]`)?.focus();}
  else if(action==='preview-prev'||action==='preview-next')showPreview(preview.context,preview.item.itemId,preview.page+(action==='preview-next'?1:-1));
  else if(action==='retry-preview')showPreview(preview.context,preview.item.itemId,preview.page);
  else if(action==='zoom-preview'){preview.zoom=!preview.zoom;renderPreview();}
  else if(action==='download')downloadItem(button.dataset.item,button);
  else if(action==='payment')orderAction('payment');
  else if(action==='cancel-order')orderAction('cancel');
  else if(action==='ticket')orderAction('ticket');
  else if(action==='feedback')openFeedback();
  else if(action==='ticket-detail')showTicketDetail(button.dataset.ticket,button);
  else if(action==='use-defaults'&&s.defaults){s.address={...s.address,...addressFromDefaults(s.defaults)};render();}
  else if(action==='new-order'){if(s.orderIntent){event.preventDefault();location.hash='print';tell(t('uncertain'),true);return;}invalidateQuote();s.files=[];render();}
});
document.querySelector('#student-account').onclick=async()=>{if(s.user){location.hash='me';return;}try{await signIn();await loadView({identity:false});}catch(error){tell(failure(error),true);}};
document.querySelector('#skip-link').onclick=event=>{event.preventDefault();content.focus({preventScroll:true});content.scrollIntoView({block:'start',behavior:'instant'});};
window.addEventListener('hashchange',navigate);
window.addEventListener('cp:language',()=>{tell('');render();});
window.addEventListener('cp:clear-private-views',event=>{if(event.detail?.surface&&event.detail.surface!=='student')return;removePreview();s.orderCodes={query:null,compensation:null};render();});
window.addEventListener('cp:auth-expired',event=>{if(event.detail?.surface&&event.detail.surface!=='student')return;if(s.user){const guest=s.user.identityKind==='guest';resetPrivate();tell(t(guest?'guestExpired':'sessionExpired'),true);render();}});
window.addEventListener('cp:file-expired',()=>{if(s.order){s.order.fileAvailability='expired';render();refreshOrder();}else if(s.quote){invalidateQuote();render();}tell(t('fileExpired'));});
async function identityChanged(){resetPrivate();tell(t('accountChanged'));render();await loadView();}
channel?.addEventListener('message',identityChanged);
window.addEventListener('pagehide',()=>{resetPrivate();render();channel?.close();channel=null;});
window.addEventListener('pageshow',event=>{if(event.persisted){channel='BroadcastChannel' in window?new BroadcastChannel('campusprint.student.identity'):null;channel?.addEventListener('message',identityChanged);navigate();}});
document.addEventListener('visibilitychange',async()=>{if(!document.hidden){if(s.order&&!views.filesAvailable(s.order)){removePreview();s.order.fileAvailability='expired';render();}try{await readIdentity();await loadConfig();render();schedulePrepare();}catch{}await refreshOrder();}});
setInterval(async()=>{if(document.hidden||initial||authPromise)return;try{await readIdentity();await refreshOrder();}catch{}},15000);

async function recoverOrder(form){
  const button=form.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;
  try{
    await ensureUser();const code=normalizeCode(form.elements.queryCode.value);
    if(!validCode(code,32))throw Object.assign(new Error(t('queryFormat')),{code:'QUERY_FORMAT'});
    const order=await request('/orders/recover',{method:'POST',body:{queryCode:code}});
    form.elements.queryCode.value='';tell(t('orderRecovered'));location.hash='orders/'+order.id;
  }catch(error){tell(failure(error),true);}finally{if(button.isConnected)button.disabled=false;}
}
function canReadOrderCode(kind) {
  if(!s.user||s.route!=='orders'||!s.order||s.order.id!==s.routeId||s.order.accessType==='recovered')return false;
  return kind==='query'?s.order.allowedActions.includes('view_query_code'):s.order.compensation?.canViewCode&&s.order.allowedActions.includes('view_compensation_code');
}
function syncOrderCodes() {
  for(const kind of ['query','compensation']){
    if(!canReadOrderCode(kind))s.orderCodes[kind]=null;
    else if(kind==='compensation'&&s.orderCodes[kind]?.couponId!==s.order.compensation.couponId)s.orderCodes[kind]=null;
  }
  if(canReadOrderCode('query')&&!s.orderCodes.query)void loadOrderCode('query');
}
async function loadOrderCode(kind) {
  if(!canReadOrderCode(kind)||s.orderCodes[kind]?.phase==='loading')return;
  const epoch=s.epoch,id=s.order.id,entry={orderId:id,phase:'loading',code:'',error:null,couponId:s.order.compensation?.couponId};
  s.orderCodes[kind]=entry;render();
  const current=()=>owned(epoch)&&s.route==='orders'&&s.routeId===id&&s.order?.id===id&&s.orderCodes[kind]===entry&&canReadOrderCode(kind);
  try {
    const value=await request('/me/orders/'+id+'/'+(kind==='query'?'query-code':'compensation-code'));
    if(!current())return;
    const code=kind==='query'?value.queryCode:value.code;
    if(!validCode(code,kind==='query'?32:25)||value.orderId&&value.orderId!==id||kind==='compensation'&&value.couponId!==entry.couponId){
      throw Object.assign(new Error(t('compensationCodeUnavailable')),{status:409});
    }
    entry.phase='ready';entry.code=code;
  }catch(error){if(current()){entry.phase='error';entry.error=error;}}
  finally{if(current())render();}
}
async function copyOrderCode(kind) {
  const entry=s.orderCodes[kind];if(!canReadOrderCode(kind)||entry?.phase!=='ready')return;
  try { await navigator.clipboard.writeText(groupCode(entry.code,kind==='query'?4:5));if(s.orderCodes[kind]===entry)tell(t('copied')); }
  catch { if(s.orderCodes[kind]!==entry||!canReadOrderCode(kind))return;entry.copyFailed=true;render();const input=content.querySelector('[data-code-kind="'+kind+'"]');input?.focus();input?.select(); }
}
initializeSettings();
await loadConfig();
try{await readIdentity();}catch(error){s.viewError=error;}
if(s.user)await loadDefaults();
const route=routeFromHash();s.route=route.route;s.routeId=route.id;initial=false;render();await loadView({identity:false});
