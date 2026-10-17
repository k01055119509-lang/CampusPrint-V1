'use strict';
class ApiError extends Error {
  constructor(status, code, message, fields = {}) { super(message); Object.assign(this, { status, code, fields }); }
}
const invalid = (field, message = '字段无效') => { throw new ApiError(400, 'VALIDATION_ERROR', message, { [field]: message }); };
const missing = () => { throw new ApiError(404, 'NOT_FOUND', '资源不存在或不可见'); };
const conflict = (message = '版本或状态已改变，请刷新后重试') => { throw new ApiError(409, 'CONFLICT', message); };
module.exports = { ApiError, invalid, missing, conflict };
