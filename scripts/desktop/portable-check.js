'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig, ROOT } = require('../../backend/config');
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('此便携包仅支持64位Windows（x64）。');
  const wanted = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
  if (process.versions.node !== wanted) throw Error('内置Node.js版本不匹配，请重新完整解压发行包。');
  const db = new DatabaseSync(':memory:');
  try { if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw Error('SQLite不可用'); } finally { db.close(); }
  require('@napi-rs/canvas').createCanvas(10, 10);
  await require('sharp')({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
  await import('pdfjs-dist/legacy/build/pdf.mjs');
  const config = loadConfig();
  console.log(JSON.stringify({ ok: true, productVersion: require('../../config/product.json').version,
    node: process.version, arch: process.arch, sqlite: true, canvas: true, sharp: true, pdfjs: true,
    configurationValid: true, dataDirectory: config.dataDir, adminCreated: false }));
}
main().catch(error => { console.error('运行环境检查失败：' + error.message); process.exitCode = 1; });
