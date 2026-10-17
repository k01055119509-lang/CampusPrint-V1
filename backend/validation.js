'use strict';
const { invalid } = require('./errors');
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
function object(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, '必须是对象');
  for (const key of Object.keys(value)) if (forbiddenKeys.has(key)) invalid(field, '不允许此属性名称');
  return value;
}
function keys(value, allowed, field = 'body') {
  object(value, field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key}`, '不支持此字段');
  return value;
}
function string(value, field, { min = 0, max = 500, trim = true, fallback } = {}) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'string') invalid(field, '必须是文本');
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || result.includes('\0')) invalid(field, `长度须为 ${min}–${max}，且不含空字符`);
  return result;
}
function choice(value, values, field) { if (!values.includes(value)) invalid(field, `允许值：${values.join(', ')}`); return value; }
function positiveInt(value, field) { if (!Number.isSafeInteger(value) || value < 1) invalid(field, '必须是正整数'); return value; }
function pagination(query) {
  const parse = (v, fallback, max, field) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) invalid(field, '必须是正整数');
    const n = Number(v); if (!Number.isSafeInteger(n) || n > max) invalid(field, `最大为 ${max}`); return n;
  };
  const page = parse(query.page, 1, 1000000, 'page');
  const pageSize = parse(query.pageSize, 20, 100, 'pageSize');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function username(value) {
  const result = string(value, 'username', { min: 3, max: 32 }).normalize('NFKC').toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(result)) invalid('username', '用户名为 3–32 位英文字母、数字或下划线；全角归一并忽略大小写');
  return result;
}
const passwordPattern = '^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,12}$';
function password(value, field = 'password') {
  const result = string(value, field, { min: 6, max: 12, trim: false });
  if (!new RegExp(passwordPattern).test(result)) invalid(field, '密码须为 6–12 位，且同时包含英文字母和数字，不含空格或符号');
  return result;
}
// Sign-in must keep accepting passwords created before the new setting rule.
function loginPassword(value, field = 'password') { return string(value, field, { min: 1, max: 128, trim: false }); }
module.exports = { object, keys, string, choice, positiveInt, pagination, username, password, loginPassword, passwordPattern, forbiddenKeys };
