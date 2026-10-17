'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { LIMITS } = require('../../backend/config');
const { passwordPattern } = require('../../backend/validation');
const { questions } = require('../../backend/routes/account-security');
const ROOT = path.resolve(__dirname, '../..');
const str = (extra = {}) => ({ type: 'string', ...extra }), integer = (extra = {}) => ({ type: 'integer', ...extra });
const time = () => str({ format: 'date-time', nullable: true });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const array = items => ({ type: 'array', items });
const success = schema => object({ success: { type: 'boolean', enum: [true] }, data: schema });
const content = schema => ({ 'application/json': { schema } });
const fileId = { name: 'id', in: 'path', required: true, schema: str({ format: 'uuid' }), description: '文件标识，不接受物理路径或文件名' };
const errorCodes = ['SECURITY_STATE_CHANGED','SECURITY_QUESTIONS_REQUIRED','SECURITY_ANSWERS_INCORRECT','CURRENT_PASSWORD_INCORRECT','AUTH_REQUIRED','FORBIDDEN','FORBIDDEN_ORIGIN','NOT_FOUND','VALIDATION_ERROR','CONFLICT','RATE_LIMITED','JSON_REQUIRED','MULTIPART_REQUIRED','PAYLOAD_TOO_LARGE','SERVICE_UNAVAILABLE','MAINTENANCE','INTERNAL_ERROR','INVALID_FILENAME','INVALID_MULTIPART','UPLOAD_INTERRUPTED','UPLOAD_TIMEOUT','UPLOAD_BUSY','FILE_EMPTY','FILE_UNSUPPORTED_FORMAT','FILE_FORMAT_MISMATCH','FILE_CORRUPT','FILE_ENCRYPTED','FILE_UNSUPPORTED_CONTENT','FILE_SIZE_LIMIT','FILE_PIXEL_LIMIT','FILE_PAGE_LIMIT','FILE_OUTPUT_LIMIT','FILE_STORAGE_QUOTA','FILE_STORAGE_UNAVAILABLE','FILE_STORAGE_MISSING','FILE_LEDGER_UNAVAILABLE','FILE_PROCESSING','FILE_PROCESS_FAILED','FILE_PROCESS_TIMEOUT','FILE_PROCESS_CRASH','FILE_PROCESS_RETRY_LIMIT','FILE_PROCESS_UNSUPPORTED','FILE_PROCESS_INVALID_RESULT','FILE_QUEUE_FULL','FILE_BUSY','FILE_ENGINE_STOPPING','FILE_INVALID_PAGES','FILE_EXPIRED','FILE_ALREADY_CLAIMED','FILE_ARTIFACT_MISMATCH','FILE_EXPIRY_IMMUTABLE','FILE_INTEGRITY_FAILED','PREPARATION_CONFLICT','UNSAFE_STORAGE_PATH'];
errorCodes.unshift('STUDENT_ACCOUNTS_DISABLED','ORDERS_PAUSED','ORDER_CANCELLATION_BLOCKED','PAYMENT_AMOUNT_MISMATCH','FINANCIAL_EXCEPTION_RECORDING_REMOVED','MERCHANT_CANCEL_REQUEST_REMOVED','ORDER_HIDDEN_FROM_MERCHANT');
const schemas = {
  Error: object({ success: { type: 'boolean', enum: [false] }, error: object({ code: str({ enum: errorCodes }), message: str(), fields: { type: 'object', additionalProperties: str() } }, ['code', 'message']) }),
  User: object({ id: str({ format: 'uuid' }), username: str({ pattern: '^[a-z0-9_]{3,32}$', nullable: true }), nickname: str({ minLength: 1, maxLength: 80 }), role: str({ enum: ['user', 'admin'] }), identityKind: str({ enum: ['guest','account'] }), createdAt: str({ format: 'date-time' }), lastLoginAt: time(), lastActiveAt: time(), online: { type: 'boolean' } }),
  Csrf: object({ csrfToken: str({ pattern: '^[a-f0-9]{64}$' }), expiresAt: str({ format: 'date-time' }) }),
  Login: object({ username: str({ minLength: 3, maxLength: 32 }), password: str({ minLength: 1, maxLength: 128, writeOnly: true, description: '登录保留旧密码兼容；新注册和改密使用 6–12 位字母数字规则' }) }),
  Registration: object({ username: str({ minLength: 3, maxLength: 32 }), password: str({ minLength: 6, maxLength: 12, pattern: passwordPattern, writeOnly: true }) }),
  SecurityQuestion: object({ id: str({ enum: questions.map(q=>q.id) }), zh: str(), en: str() }),
  SecurityState: object({ configured: {type:'boolean'}, version: integer({minimum:0}), questions: {...array(ref('SecurityQuestion')),maxItems:3}, availableQuestions: array(ref('SecurityQuestion')) }),
  SecurityAnswers: {...array(str({minLength:1,maxLength:120,writeOnly:true})),minItems:3,maxItems:3,description:'依返回的问题顺序填写全部三个答案；NFKC、首尾空格、连续空白和英文大小写归一；仅保存加盐 scrypt 哈希'},
  SecuritySetup: object({ expectedVersion: integer({minimum:0}), questions: {...array(object({questionId:str({enum:questions.map(q=>q.id)}),answer:str({minLength:1,maxLength:120,writeOnly:true})})),minItems:3,maxItems:3}, currentPassword:str({minLength:1,maxLength:128,writeOnly:true}), answers:ref('SecurityAnswers') },['expectedVersion','questions']),
  PasswordChange: object({expectedVersion:integer({minimum:1}),answers:ref('SecurityAnswers'),newPassword:str({minLength:6,maxLength:12,pattern:passwordPattern,writeOnly:true})}),
  FileError: { ...object({ code: str(), message: str() }), nullable: true },
  File: object({ id: str({ format: 'uuid' }), originalName: str({ maxLength: 180 }), mimeType: str({ enum: [...LIMITS.allowedMimeTypes] }), byteSize: integer({ minimum: 1 }), sourcePageCount: integer({ minimum: 1, maximum: LIMITS.maxSourcePages, nullable: true }), sourceSha256: str({ pattern: '^[a-f0-9]{64}$' }), status: str({ enum: ['processing', 'ready', 'failed', 'expired'] }), error: ref('FileError'), claimedOrderId: str({ nullable: true }), expiresAt: time(), uploadedAt: str({ format: 'date-time' }), fileAvailability: str({ enum: ['available', 'expired', 'deleted'] }), allowedActions: array(str({ enum: ['preview', 'delete'] })) }),
  Artifact: object({ artifactId: str({ format: 'uuid' }), fileId: str({ format: 'uuid' }), preparationId: str({ nullable: true }), pageCount: integer({ minimum: 1 }), sha256: str({ pattern: '^[a-f0-9]{64}$' }), byteSize: integer({ minimum: 1 }), mimeType: str(), paperSize: str({ enum: ['A4'] }), colorMode: str({ enum: ['black_white'] }), copiesInPdf: integer({ enum: [1] }), sourceSha256: str({ pattern: '^[a-f0-9]{64}$' }), pageNumbers: array(integer({ minimum: 1 })), expiresAt: time() }),
  CleanupRun: object({ runId: str({ format: 'uuid' }), startedAt: str({ format: 'date-time' }), examined: integer({ minimum: 0 }), purged: integer({ minimum: 0 }), failed: integer({ minimum: 0 }), deferred: integer({ minimum: 0 }), finishedAt: str({ format: 'date-time' }) }),
  StoredCleanupRun: { ...object({ id: str({ format: 'uuid' }), startedAt: str({ format: 'date-time' }), examined: integer({ minimum: 0 }), purged: integer({ minimum: 0 }), failed: integer({ minimum: 0 }), deferred: integer({ minimum: 0 }), finishedAt: time() }), nullable: true },
  CleanupStatus: object({ intervalMs: integer({ maximum: 300000 }), temporaryUploadHours: integer({ enum: [24] }), latestRun: ref('StoredCleanupRun'), pendingExpired: integer({ minimum: 0 }), failures: array(object({ fileId: str({ format: 'uuid' }), purgeAttempts: integer({ minimum: 1 }), code: str({ enum: ['FILE_DELETE_FAILED', 'UNSAFE_STORAGE_PATH'] }) })), temporaryCleanupFailures: array(object({ jobId: str({ format: 'uuid' }), code: str() })), ledgerError: str({ nullable: true }), processing: object({ running: integer({ minimum: 0 }), queued: integer({ minimum: 0 }), maxConcurrent: integer({ minimum: 1 }) }) }),
  UploadLimits: object(Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [key, Array.isArray(value) ? array(str()) : integer({ minimum: 1 })]))),
  PublicConfig: object({ product: object({ id: str({ enum: ['campus-print-v1'] }), name: str(), nameEn: str(), version: str() }), timezone: str({ enum: ['Asia/Shanghai'] }), maintenance: object({ enabled: { type: 'boolean' }, message: str(), updatedAt: time() }), auth: object({ usernameRule: str(), passwordMinLength: integer({ enum: [6] }), passwordMaxLength: integer({ enum: [12] }), passwordPattern: str({enum:[passwordPattern]}), roles: array(str({ enum: ['user', 'admin'] })) }), uploadLimits: ref('UploadLimits'), capabilities: object({ privateFiles: { type: 'boolean' }, orders: { type: 'boolean' } }) })
};
schemas.Identity = object({ ...schemas.User.properties, sessionExpiresAt: str({format:'date-time'}) });
Object.assign(schemas.PublicConfig.properties, { studentAccountsEnabled: {type:'boolean'}, guestSessionDays: integer({enum:[7]}) });
schemas.PublicConfig.required.push('studentAccountsEnabled','guestSessionDays');
const standardErrors = {
  400: '参数无效、损坏请求、页码语法或额外字段错误', 401: '未登录或会话失效', 403: '角色、CSRF 或来源校验失败',
  404: '资源不存在或属于他人；不泄露资源存在性', 409: '文件正在处理、已经认领或稳定任务标识冲突',
  408: '上传超时', 410: '文件到期/清理后禁止读取与再生成', 413: '文件、像素、页数、存储资源上限',
  415: '格式/声明不匹配、不支持格式或加密/XFA 等内容', 422: '文件损坏或处理失败',
  429: '请求、上传或处理队列限流', 500: '内部错误或存储路径检查失败', 503: '维护、文件存储或期限台账不可用'
};
const responses = Object.fromEntries(Object.entries(standardErrors).map(([status, description]) => [`Error${status}`, { description, content: content(ref('Error')), ...(status === '429' ? { headers: { 'Retry-After': { description: '至少等待的秒数', schema: str() } } } : {}) }]));
function endpoint(summary, { role = null, write = false, response, status = 200, body = null, errors = [], parameters, binary = false, description = '' } = {}) {
  return { summary, description, tags: [role === 'admin' ? 'Cleanup' : summary.includes('文件') || binary ? 'Files' : 'Foundation'],
    'x-roles': role ? role === 'session' ? ['user', 'admin'] : [role] : [],
    security: [], // Assigned per route/surface below.
    ...(parameters ? { parameters } : {}),
    ...(body ? { requestBody: { required: true, content: body } } : {}),
    responses: { [status]: binary ? { description: '权限及当前期限检查后的 PNG；Cache-Control: no-store, private', headers: { 'Cache-Control': { schema: str() }, 'X-Artifact-SHA256': { schema: str() }, 'X-File-Expires-At': { schema: str({ format: 'date-time' }) } }, content: { 'image/png': { schema: str({ format: 'binary' }) } } } : { description: '成功', content: content(success(response)), ...(summary.includes('登录') || summary.includes('注册') || summary.includes('修改密码') ? { headers: { 'X-CSRF-Token': { description: '登录/注册旋转后的 CSRF，后续写入须使用此值', schema: str() }, 'Set-Cookie': { schema: str(), description: '新的 HttpOnly 会话 cookie；生产名称 __Host-cp_session，Secure + SameSite=Lax' } } } : {}) },
      ...Object.fromEntries([...new Set([...errors, 500, ...(write ? [413, 415] : [])])].map(code => [code, { $ref: `#/components/responses/Error${code}` }])) }
  };
}
const authErrors = [400, 403, 409, 429], fileErrors = [401, 403, 404, 409, 410, 413, 422, 429, 503];
const paths = {
  '/auth/csrf': { get: endpoint('获取匿名或当前会话 CSRF', { response: ref('Csrf'), errors: [403, 429], description: '首次获取创建匿名 HttpOnly cookie。JSON 写请求和 multipart 上传均使用 X-CSRF-Token。' }) },
  '/auth/guest': { post: endpoint('初始化独立访客或复用当前学生身份', {write:true,response:ref('Identity'),body:content(object({})),errors:[400,403,429],description:'学生上下文，先取 CSRF。固定七天自访客创建起计，不续期。IP 限流持久化。返回 X-CSRF-Token。'}) },
  '/auth/register': { post: endpoint('注册普通用户并登录', { write: true, status: 201, response: ref('Identity'), body: content(ref('Registration')), errors: authErrors, description:'STUDENT_ACCOUNTS_ENABLED 默认 false；关闭返回 403 STUDENT_ACCOUNTS_DISABLED。' }) },
  '/auth/login': { post: endpoint('学生登录', { write: true, response: ref('Identity'), body: content(ref('Login')), errors: [...authErrors, 401], description:'账号关闭返回 403 STUDENT_ACCOUNTS_DISABLED。访客主体没有可登录密码。' }) },
  '/auth/admin-login': { post: endpoint('管理员独立登录', { write: true, response: ref('Identity'), body: content(ref('Login')), errors: [...authErrors, 401], description: '固定管理员上下文；CSRF 也须使用管理员上下文获取。普通账号不能从本接口登录。管理员由 admin:init 创建，没有默认密码。' }) },
  '/auth/me': { get: endpoint('当前身份与登录活跃信息', { role: 'session', response: ref('Identity'), errors: [401, 403] }) },
  '/auth/logout': { post: endpoint('退出并使会话失效', { role: 'session', write: true, body: content(object({})), response: object({ loggedOut: { type: 'boolean', enum: [true] } }), errors: [400, 401, 403, 429] }) },
  '/me/profile': { patch: endpoint('修改昵称', { role: 'session', write: true, body: content(object({ nickname: str({ minLength: 1, maxLength: 80 }) })), response: ref('Identity'), errors: [400, 401, 403, 429] }) },
  '/me/security-questions': {
    get: endpoint('获取当前账号的密保设置', { role:'session', response:ref('SecurityState'), errors:[401,403], description:'仅返回问题、配置状态、版本和可选问题；从不返回答案或答案哈希。' }),
    post: endpoint('一次设置或更换三个密保问题', { role:'session',write:true,body:content(ref('SecuritySetup')),response:ref('SecurityState'),errors:[400,401,403,409,429],description:'首次 expectedVersion=0，必须提供 currentPassword；更换必须提供全部三个原 answers。问题不可重复。账号连续验证失败五次后须等待十五分钟；同 IP 十五分钟最多三十次提交。' })
  },
  '/me/password': { post: endpoint('验证全部密保答案后修改密码', { role:'session',write:true,body:content(ref('PasswordChange')),response:object({passwordChanged:{type:'boolean',enum:[true]},otherSessionsRevoked:{type:'boolean',enum:[true]}}),errors:[400,401,403,409,429],description:'只对当前登录账号操作。无密保不可改密，三个答案须全对。新密码 6–12 位，仅允许英文字母和数字且二者都必须包含。成功撤销所有旧会话并为当前浏览器旋转 cookie 和 CSRF。' }) },
  '/public/config': { get: endpoint('公开基础配置和文件资源上限', { response: ref('PublicConfig'), errors: [403], description: 'capabilities 按实际模块返回；打印配置与收款状态以 /print/config 为准。' }) },
  '/files': { post: endpoint('上传一个私有文件', { role: 'user', write: true, status: 202, response: ref('File'), body: { 'multipart/form-data': { schema: object({ file: str({ format: 'binary' }) }) } }, errors: [400, 401, 403, 408, 409, 413, 415, 429, 503], description: '休息时在接收文件前返回 409 ORDERS_PAUSED；已接受上传可完成。一个 file 字段，无额外字段。multipart 不设置 JSON Content-Type，也不手工构造 boundary。202 表示完整接收后排队，不保证解析成功。查询 /files/{id}，失败给出 FILE_CORRUPT/FILE_ENCRYPTED/FILE_PAGE_LIMIT/FILE_PIXEL_LIMIT 等代码。' }) },
  '/files/{id}': {
    get: endpoint('所属文件状态与真实源页数', { role: 'session', response: ref('File'), parameters: [fileId], errors: [401, 403, 404], description: '普通用户仅访问自己的文件；管理员按履约访问。到期后元数据仍返回 200，status=expired，文件访问返回 410。' }),
    delete: endpoint('删除尚未绑定订单的临时文件', { role: 'user', write: true, response: object({ deleted: { type: 'boolean' }, status: str({ enum: ['expired'] }), fileId: str({ format: 'uuid' }) }), body: content(object({})), parameters: [fileId], errors: [400, 401, 403, 404, 409, 429, 503], description: '先禁止访问再物理删除；deleted=false 表示删除失败等待重试，不能据此重新开放文件。' })
  },
  '/files/{id}/preview': { get: endpoint('原文件某页的规范化按需预览', { role: 'session', binary: true, parameters: [fileId, { name: 'page', in: 'query', schema: integer({ minimum: 1, default: 1, maximum: 2000 }) }], errors: [400, ...fileErrors], description: '只生成所请求的页面。生产文件预览由 B 在报价/订单接口中调用 openArtifactForRead(purpose=preview)，不能用原文件预览代替最终生产预览。' }) },
  '/admin/files/cleanup-status': { get: endpoint('查看文件清理状态', { role: 'admin', response: ref('CleanupStatus'), errors: [401, 403] }) },
  '/admin/files/cleanup-run': { post: endpoint('按真实当前时间清理已到期文件', { role: 'admin', write: true, response: ref('CleanupRun'), body: content(object({})), errors: [400, 401, 403, 429, 503], description: '不接受路径、文件名、日期或生产调时参数。失败对象维持 expired，下一次扫描重试。' }) }
};
schemas.CleanupStatus.properties.backupCleanup = object({ examined: integer({minimum:0}), purged: integer({minimum:0}), failures: array(object({snapshotId:str(),fileId:str(),code:str()})) });
for (const [route, methods] of Object.entries(paths)) for (const [method, operation] of Object.entries(methods)) {
  const fixed = route.startsWith('/admin/') || route==='/auth/admin-login' ? 'admin' : ['/auth/guest','/auth/register','/auth/login'].includes(route) || (route==='/files'&&method==='post') || (route==='/files/{id}'&&method==='delete') ? 'student' : null;
  operation.parameters = [...(operation.parameters || []), {name:'X-CP-Surface',in:'header',schema:str({enum:fixed?[fixed]:['student','admin'],default:fixed||'student'}),description:'选择当前端的 Cookie/CSRF；不能作为授权凭证或回退到另一端。'}];
  const write = !['get','head'].includes(method), needed = write || operation['x-roles'].length;
  operation.security = needed ? (fixed?[fixed]:['student','admin']).map(surface=>({[surface==='admin'?'AdminSessionCookie':'StudentSessionCookie']:[],...(write?{CsrfToken:[]}:{})})) : [];
  operation['x-cp-surface'] = fixed || 'select';
  if (route==='/auth/guest') operation.responses[200].headers={ 'X-CSRF-Token':{schema:str(),description:'新访客旋转后的当前学生 CSRF；复用身份时不旋转。'},'Set-Cookie':{schema:str(),description:'新访客学生会话；复用当前身份不续期。'} };
  if (['/me/profile','/me/security-questions','/me/password'].includes(route)) {
    operation['x-identity-kinds']=['account']; operation.description += ' 访客拒绝；学生账号关闭时返回 403 STUDENT_ACCOUNTS_DISABLED，管理员仍可用。';
  }
  for (const response of Object.values(operation.responses)) if (response.headers?.['Set-Cookie']) response.headers['Set-Cookie'].description='该端独立 HttpOnly Cookie；生产使用 __Host- 前缀、Secure、SameSite=Lax。';
}
schemas.PublicConfig.properties.capabilities.properties.advertisements={type:'boolean'};
schemas.PublicConfig.properties.capabilities.required.push('advertisements');
const base = { openapi: '3.0.3', info: { title: 'CampusPrint Foundation API', version: '1.4.0', description: '双 Cookie/CSRF、固定七天访客与保留的账号功能；休息时拒绝新上传；广告能力默认关闭；UTC 时间，上海显示。经营业务见 print.yaml。' }, servers: [{ url: '/api' }], paths,
  components: { securitySchemes: { StudentSessionCookie: { type:'apiKey',in:'cookie',name:'cp_student_session',description:'生产 __Host-cp_student_session；访客或已开启学生账号会话。HttpOnly、SameSite=Lax、Path=/，生产 Secure。' }, AdminSessionCookie: {type:'apiKey',in:'cookie',name:'cp_admin_session',description:'生产 __Host-cp_admin_session；仅管理员。旧 cp_session / __Host-cp_session 只经数据库角色核验迁移管理员，保留原到期时间。'}, CsrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' } }, schemas, responses } };
fs.writeFileSync(path.join(ROOT, 'contracts/base.yaml'), yaml.dump(base, { lineWidth: 120, noRefs: true }));
const aggregate = { openapi: base.openapi, info: base.info, servers: base.servers,
  paths: Object.fromEntries(Object.keys(paths).map(key => [key, { $ref: `./base.yaml#/paths/${key.replaceAll('~', '~0').replaceAll('/', '~1')}` }])),
  components: { securitySchemes: base.components.securitySchemes } };
const existingAggregatePath = path.join(ROOT, 'contracts/openapi.yaml');
if (fs.existsSync(existingAggregatePath)) { const existing = yaml.load(fs.readFileSync(existingAggregatePath, 'utf8')); aggregate.paths = { ...existing.paths, ...aggregate.paths }; }
fs.writeFileSync(path.join(ROOT, 'contracts/openapi.yaml'), '# 聚合入口；保留已实现的基础与业务路径引用。\n' + yaml.dump(aggregate, { lineWidth: 120 }));
console.log('Foundation 1.4.0 contract written; existing business path references preserved.');
