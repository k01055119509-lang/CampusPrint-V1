const messages = {
  zh: {
    brand:'校园打印', account:'登录 / 注册', logout:'退出', nickname:'昵称', username:'用户名', password:'密码', passwordRule:'密码为 6–12 位，须同时包含英文字母和数字，不含空格或符号。',
    login:'登录', register:'注册', adminLogin:'管理员登录', cancel:'取消', save:'保存', theme:'外观', light:'浅色', dark:'深色', language:'语言',
    title:'把文件准备好，再放心打印', subtitle:'A4 黑白 · 仅配送本栋宿舍', price:'0.50 元/张', pricing:'单、双面按实际纸张计费；整单内容页数含份数，限 1–99 页。',
    paymentEmpty:'尚未配置收款信息', phase:'工程基础阶段：文件上传和预览可用，报价与订单页面由后续任务接入。',
    filesTitle:'文件上传与预览', file:'选择 PDF / JPG / PNG', upload:'上传文件', progress:'上传中', processing:'正在读取文件，请稍候…',
    ready:'文件已就绪', preview:'查看预览', page:'源文件页码', remove:'删除临时文件', removed:'文件已清理', noFile:'请选择一个文件。',
    retention:'未下单的临时上传保留 24 小时；已完成订单的文件在确认送达七天后清理，订单记录保留。',
    limits:'单文件最多 40 MiB；PDF 源文件最多 2000 页；图片最多 4000 万像素。', adminEntry:'经营端入口', userEntry:'学生端入口',
    adminTitle:'经营端基础入口', adminPhase:'账号与文件清理工具已接入。经营指标、订单履约和收款配置等待任务 B 接入。',
    cleanup:'查看清理状态', runCleanup:'清理已到期文件', cleanupResult:'清理结果', loginNeeded:'请先登录后继续。',
    fileExpired:'文件已过期，请重新上传后下新单。', network:'网络请求失败，请检查连接后重试。', busy:'正在处理…',
    passwordShow:'显示密码', passwordHide:'隐藏密码', profile:'修改昵称', profileTitle:'账号昵称',
    statusSummary:'处理状态', pages:'源页数', private:'私有文件只通过身份校验接口读取。', selectAgain:'请重新选择文件后上传。'
  },
  en: {
    brand:'Campus Print', account:'Sign in / Register', logout:'Sign out', nickname:'Nickname', username:'Username', password:'Password', passwordRule:'Use 6–12 letters and digits with at least one of each, without spaces or symbols.',
    login:'Sign in', register:'Register', adminLogin:'Administrator sign in', cancel:'Cancel', save:'Save', theme:'Appearance', light:'Light', dark:'Dark', language:'Language',
    title:'Prepare your files for a clear print', subtitle:'A4 grayscale · Delivery within this dormitory only', price:'CNY 0.50 / sheet', pricing:'Single and double sided prints are billed by sheets used. Each order allows 1–99 content pages, including copies.',
    paymentEmpty:'Payment information has not been configured', phase:'Foundation stage: upload and preview are available. Quotes and order pages will be added in later tasks.',
    filesTitle:'Upload and preview', file:'Choose PDF / JPG / PNG', upload:'Upload file', progress:'Uploading', processing:'Reading your file. Please wait…',
    ready:'File is ready', preview:'View preview', page:'Source page number', remove:'Delete temporary upload', removed:'File has been cleared', noFile:'Choose a file first.',
    retention:'Temporary uploads are kept for 24 hours. Completed order files are cleared seven days after confirmed delivery; order records remain.',
    limits:'Up to 40 MiB per file, 2000 source PDF pages, and 40 million image pixels.', adminEntry:'Administrator entry', userEntry:'Student entry',
    adminTitle:'Administrator foundation entry', adminPhase:'Account and file cleanup tools are ready. Dashboard, order fulfillment and payment settings will be added by task B.',
    cleanup:'View cleanup status', runCleanup:'Clear expired files', cleanupResult:'Cleanup result', loginNeeded:'Sign in to continue.',
    fileExpired:'This file has expired. Upload it again for a new order.', network:'The network request failed. Check your connection and try again.', busy:'Working…',
    passwordShow:'Show password', passwordHide:'Hide password', profile:'Edit nickname', profileTitle:'Account nickname',
    statusSummary:'Processing status', pages:'Source pages', private:'Private files are read through authenticated endpoints only.', selectAgain:'Choose the file again and upload it.'
  }
};
let language = localStorage.getItem('campusprint.language') === 'en' ? 'en' : 'zh';
export const t = key => messages[language][key] || key;
const englishErrors = {
  ORDER_CANCELLATION_BLOCKED:'This order cannot be cancelled. Refresh to see its current status.',
  PAYMENT_AMOUNT_MISMATCH:'The received amount does not match this order. Return the payment declaration for review.',
  FINANCIAL_EXCEPTION_RECORDING_REMOVED:'Recording financial exceptions is no longer available. Return the payment declaration for review.',
  MERCHANT_CANCEL_REQUEST_REMOVED:'Merchant cancellation now uses a single confirmation. Refresh and use Cancel order.',
  ORDER_HIDDEN_FROM_MERCHANT:'This order is no longer shown in the merchant order list.',
  VERSION_CONFLICT:'This order or setting has changed. Refresh before trying again.',
  SECURITY_ANSWERS_INCORRECT:'The security answers are incorrect. Check all three answers.', CURRENT_PASSWORD_INCORRECT:'The current password is incorrect.', SECURITY_STATE_CHANGED:'Account security has changed. Close and reopen account security.', SECURITY_QUESTIONS_REQUIRED:'Set three security questions before changing your password.',
  AUTH_REQUIRED:'Please sign in again. Check your username and password.', FORBIDDEN:'This account cannot perform this action.', FORBIDDEN_ORIGIN:'This request origin is not allowed.',
  VALIDATION_ERROR:'Check the entered values and try again.', NOT_FOUND:'This resource is unavailable.', CONFLICT:'The resource has changed. Refresh and try again.',
  RATE_LIMITED:'Too many requests. Wait a moment and try again.', MULTIPART_REQUIRED:'Choose a file and upload it using the form.', JSON_REQUIRED:'The request format is invalid.',
  FILE_UNSUPPORTED_FORMAT:'Only PDF, JPG and PNG are supported. Convert other formats to PDF first.', FILE_FORMAT_MISMATCH:'The file contents do not match its extension or type.',
  FILE_EMPTY:'Choose a nonempty file.', FILE_CORRUPT:'This file is damaged or unreadable. Export it again and retry.', FILE_ENCRYPTED:'Password protected PDFs are unsupported. Remove the protection first.',
  FILE_UNSUPPORTED_CONTENT:'This file contains unsupported content. Export it as a standard PDF first.', FILE_PIXEL_LIMIT:'The image exceeds the pixel limit. Resize it first.',
  FILE_PAGE_LIMIT:'The source PDF exceeds the page limit. Split it first.', FILE_SIZE_LIMIT:'The file exceeds the size limit.', FILE_OUTPUT_LIMIT:'The output exceeds the resource limit. Choose fewer pages.',
  FILE_STORAGE_QUOTA:'The server file storage limit has been reached. Clear temporary uploads or try again later.', FILE_QUEUE_FULL:'The processing queue is full. Try again later.',
  FILE_PROCESSING:'This file is still processing. Check its status shortly.', FILE_PROCESS_TIMEOUT:'File processing timed out. Simplify the file and retry.', FILE_PROCESS_CRASH:'File processing failed. Try again later.',
  FILE_EXPIRED:'This file has expired. Upload it again for a new order.', FILE_ALREADY_CLAIMED:'This upload already belongs to an order. Upload it again for a new order.',
  UPLOAD_INTERRUPTED:'The upload was interrupted. Select the file again and retry.', UPLOAD_TIMEOUT:'The upload timed out. Try again.', INVALID_MULTIPART:'Upload exactly one file.',
  INVALID_FILENAME:'Use a safe filename of no more than 180 characters.', FILE_LEDGER_UNAVAILABLE:'File access is temporarily paused. Try again later.',
  FILE_INTEGRITY_FAILED:'File verification failed. Contact the operator.', FILE_STORAGE_UNAVAILABLE:'File storage is temporarily unavailable. Try again later.', MAINTENANCE:'The service is under maintenance. Try again later.'
};
export function errorText(code, fallback) { return language === 'en' ? englishErrors[code] || 'The request could not be completed. Please try again.' : fallback; }
export function translate(root = document) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.title = t('brand');
}
export function setLanguage(value) { language = value === 'en' ? 'en' : 'zh'; localStorage.setItem('campusprint.language', language); translate(); window.dispatchEvent(new Event('cp:language')); }
export function initializeSettings() {
  const theme = localStorage.getItem('campusprint.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  const themes = document.querySelectorAll('[data-theme-control]'); themes.forEach(control => { control.value = theme; control.addEventListener('change', () => { document.documentElement.dataset.theme = control.value; localStorage.setItem('campusprint.theme', control.value); }); });
  document.querySelectorAll('[data-language-control]').forEach(control => { control.value = language; control.addEventListener('change', () => setLanguage(control.value)); }); translate();
}
