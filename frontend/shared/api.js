import { t, errorText } from './i18n.js';
let surface = 'student';
const tokens = new Map(), urls = new Map(), csrfRequests = new Map();
export function setSurface(value) { if (!['student','admin'].includes(value)) throw new Error('Invalid request surface'); surface = value; }
export function clearPrivateViews(context = surface) {
  for (const [url, entry] of urls) if (entry.surface === context) { clearTimeout(entry.timer); URL.revokeObjectURL(url); urls.delete(url); }
  window.dispatchEvent(new CustomEvent('cp:clear-private-views', { detail: { surface: context } }));
}
function responseError(response, payload, context) {
  const error = Object.assign(new Error(errorText(payload?.error?.code, payload?.error?.message || t('network'))), { status: response.status, code: payload?.error?.code || 'NETWORK_ERROR', fields: payload?.error?.fields || {} });
  if (response.status === 401) { tokens.delete(context); clearPrivateViews(context); window.dispatchEvent(new CustomEvent('cp:auth-expired', { detail: { surface: context } })); }
  if (response.status === 410 && error.code === 'FILE_EXPIRED') { clearPrivateViews(context); error.message = t('fileExpired'); } return error;
}
export async function request(route, { method = 'GET', body, headers = {}, context = surface } = {}) {
  if (method !== 'GET' && !tokens.has(context)) await csrf(context);
  let response;
  try { response = await fetch('/api' + route, { method, cache: 'no-store', credentials: 'same-origin',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers, 'X-CP-Surface': context, ...(method === 'GET' ? {} : { 'X-CSRF-Token': tokens.get(context) }) },
    body: body === undefined ? undefined : JSON.stringify(body) }); } catch { throw Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'}); }
  const payload = await response.json();
  if (!response.ok || !payload.success) throw responseError(response, payload, context);
  if (response.headers.get('x-csrf-token')) tokens.set(context, response.headers.get('x-csrf-token'));
  return payload.data;
}
export async function csrf(context = surface) {
  if (!csrfRequests.has(context)) csrfRequests.set(context, request('/auth/csrf', { context }).then(result => { tokens.set(context, result.csrfToken); return result; }).finally(() => csrfRequests.delete(context)));
  return csrfRequests.get(context);
}
export async function uploadAsset(route,file,versionHeader,version){
  const context=surface;await csrf(context);const body=new FormData();body.append('file',file);
  let response;
  try{response=await fetch('/api'+route,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'X-CP-Surface':context,'X-CSRF-Token':tokens.get(context),[versionHeader]:String(version)},body});}
  catch{throw Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'});}
  const payload=await response.json();if(!response.ok||!payload.success)throw responseError(response,payload,context);
  if(response.headers.get('x-csrf-token'))tokens.set(context,response.headers.get('x-csrf-token'));
  return payload.data;
}
export function upload(file, onProgress = () => {}) {
  const context = surface;
  return csrf(context).then(() => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(), form = new FormData(); form.append('file', file);
    xhr.open('POST', '/api/files'); xhr.setRequestHeader('X-CP-Surface', context); xhr.setRequestHeader('X-CSRF-Token', tokens.get(context)); xhr.timeout = 130000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = xhr.ontimeout = () => reject(Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'}));
    xhr.onload = () => { let payload; try { payload = JSON.parse(xhr.responseText); } catch { reject(Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'})); return; }
      if (!payload.success) reject(responseError({ status: xhr.status }, payload, context)); else { const next = xhr.getResponseHeader('X-CSRF-Token'); if (next) tokens.set(context, next); resolve(payload.data); } };
    xhr.send(form);
  }));
}
export async function binaryUrl(route) {
  const context = surface;
  let response; try { response = await fetch('/api' + route, { cache: 'no-store', credentials: 'same-origin', headers: { 'X-CP-Surface': context } }); } catch { throw Object.assign(new Error(t('network')),{code:'NETWORK_ERROR'}); }
  if (!response.ok) throw responseError(response, await response.json(), context);
  const url = URL.createObjectURL(await response.blob()), expiresAt = response.headers.get('x-file-expires-at');
  let timer = null;
  if (expiresAt) {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) { URL.revokeObjectURL(url); throw new Error(t('fileExpired')); }
    timer = setTimeout(() => { releaseUrl(url); window.dispatchEvent(new CustomEvent('cp:file-expired', { detail: { url, surface: context } })); }, Math.min(remaining, 2147483647));
  }
  urls.set(url, { timer, surface: context }); return url;
}
export function releaseUrl(url) { if (url) { clearTimeout(urls.get(url)?.timer); URL.revokeObjectURL(url); urls.delete(url); } }
window.addEventListener('pagehide', () => clearPrivateViews());
export const api = { request, csrf, upload, binaryUrl, clearPrivateViews, setSurface };
