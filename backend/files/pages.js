'use strict';
const { invalid } = require('../errors');
function validatePageNumbers(numbers, sourcePageCount, maxPages = 100) {
  if (!Number.isSafeInteger(sourcePageCount) || sourcePageCount < 1) invalid('pages', '源文件页数无效');
  if (!Array.isArray(numbers) || !numbers.length || numbers.length > maxPages) invalid('pages', `选页数量须为 1–${maxPages}`);
  const seen = new Set();
  for (const n of numbers) {
    if (!Number.isSafeInteger(n) || n < 1 || n > sourcePageCount) invalid('pages', '页码必须是源文件范围内的正整数');
    if (seen.has(n)) invalid('pages', '页码不可重复或交叉重复'); seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}
function parsePages(value, sourcePageCount, maxPages = 100) {
  if (value === 'all') {
    if (sourcePageCount > maxPages) invalid('pages', `本次最多准备 ${maxPages} 页，请选择部分页码`);
    return Array.from({ length: sourcePageCount }, (_, i) => i + 1);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) invalid('pages', '使用 all 或 1-3,5 形式的页码');
  const numbers = [];
  for (const part of value.split(',')) {
    const match = /^\s*([1-9]\d*)(?:\s*-\s*([1-9]\d*))?\s*$/.exec(part);
    if (!match) invalid('pages', '页码格式无效');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > sourcePageCount) invalid('pages', '页码范围无效或超出源文件');
    if (numbers.length + end - start + 1 > maxPages) invalid('pages', `本次最多准备 ${maxPages} 页`);
    for (let page = start; page <= end; page++) numbers.push(page);
  }
  return validatePageNumbers(numbers, sourcePageCount, maxPages);
}
module.exports = { parsePages, validatePageNumbers };
