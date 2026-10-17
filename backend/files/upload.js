'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const Busboy = require('busboy');
const { ApiError } = require('../errors');
const { safePath, removeTree } = require('./safety');
function filename(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f/\\:]/.test(value) || value.length > 180) throw new ApiError(400, 'INVALID_FILENAME', '文件名须为不超过 180 字符的安全名称');
  return value.trim().normalize('NFC');
}
function sniff(header) {
  if (header.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  throw new ApiError(415, 'FILE_UNSUPPORTED_FORMAT', '只支持真实的 PDF/JPG/PNG 文件；其他格式请先转为 PDF');
}
async function receiveUpload(req, config, { payment = false, activeUploads } = {}) {
  if (!req.is('multipart/form-data')) throw new ApiError(415, 'MULTIPART_REQUIRED', '上传须使用 multipart/form-data，字段名为 file');
  const maxBytes = payment ? config.limits.paymentImageMaxBytes : config.limits.maxFileBytes;
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes + 8192)) throw new ApiError(413, 'FILE_SIZE_LIMIT', '上传文件超过服务器公布的大小上限');
  const uploadId = randomUUID(), tempName = `upload-${uploadId}`;
  const directory = await safePath(config.tempRoot, tempName, { missing: true });
  activeUploads?.add(tempName);
  try { await fsp.mkdir(directory); } catch { activeUploads?.delete(tempName); throw new ApiError(503, 'FILE_STORAGE_UNAVAILABLE', '无法暂存文件，请稍后重试'); }
  let originalName, declaredMime, byteSize = 0, fileCount = 0, writePromise, parser, complete = false;
  const digest = createHash('sha256');
  const cleanup = async () => { try { await removeTree(config.tempRoot, tempName); } finally { activeUploads?.delete(tempName); } };
  try {
    const rawPath = path.join(directory, 'original.bin');
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer); req.off('aborted', aborted); req.off('error', aborted);
        if (error) { req.unpipe(parser); parser?.destroy(); req.resume(); reject(error); } else resolve();
      };
      const aborted = () => finish(new ApiError(400, 'UPLOAD_INTERRUPTED', '上传中断，请重新选择文件上传'));
      const timer = setTimeout(() => finish(new ApiError(408, 'UPLOAD_TIMEOUT', '上传超时，请重试')), config.limits.uploadTimeoutMs);
      req.once('aborted', aborted); req.once('error', aborted);
      try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', preservePath: true, limits: { files: 1, fileSize: maxBytes, fields: 0, parts: 2, headerPairs: 100 } }); }
      catch { return finish(new ApiError(400, 'INVALID_MULTIPART', '上传格式或 boundary 无效')); }
      parser.on('file', (field, stream, info) => {
        fileCount++;
        try {
          if (field !== 'file') throw new ApiError(400, 'INVALID_MULTIPART', '只允许一个名为 file 的上传字段');
          originalName = filename(info.filename); declaredMime = info.mimeType;
        } catch (error) { stream.resume(); finish(error); return; }
        stream.on('limit', () => finish(new ApiError(413, 'FILE_SIZE_LIMIT', '文件超过大小上限')));
        const counter = new Transform({ transform(chunk, encoding, callback) { byteSize += chunk.length; digest.update(chunk); callback(null, chunk); } });
        writePromise = pipeline(stream, counter, fs.createWriteStream(rawPath, { flags: 'wx', mode: 0o600 })).catch(error => { finish(error instanceof ApiError ? error : new ApiError(400, 'UPLOAD_INTERRUPTED', '上传中断或无法暂存，请重试')); });
      });
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => finish(new ApiError(400, 'INVALID_MULTIPART', '只允许一个 file 文件，不接受额外字段')));
      parser.once('error', () => finish(new ApiError(400, 'UPLOAD_INTERRUPTED', '上传未完整接收，请重试')));
      parser.once('close', async () => { await writePromise; if (!settled) finish(fileCount !== 1 || !byteSize ? new ApiError(400, 'FILE_EMPTY', '请选择一个非空文件') : null); });
      req.pipe(parser);
    });
    await writePromise;
    if (byteSize > maxBytes) throw new ApiError(413, 'FILE_SIZE_LIMIT', '文件超过大小上限');
    const handle = await fsp.open(rawPath, 'r'), header = Buffer.alloc(32);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const mimeType = sniff(header), extension = path.extname(originalName).slice(1).toLowerCase();
    const extensions = mimeType === 'application/pdf' ? ['pdf'] : mimeType === 'image/png' ? ['png'] : ['jpg', 'jpeg'];
    if (!extensions.includes(extension) || (declaredMime !== mimeType && declaredMime !== 'application/octet-stream')) throw new ApiError(415, 'FILE_FORMAT_MISMATCH', '文件扩展名、声明类型与真实内容不一致');
    if (payment && mimeType === 'application/pdf') throw new ApiError(415, 'FILE_UNSUPPORTED_FORMAT', '收款图片只支持 JPG/PNG');
    complete = true;
    return { uploadId, tempName, originalName, mimeType, byteSize, sha256: digest.digest('hex'), cleanup };
  } finally {
    if (!complete) { if (writePromise) await writePromise; await cleanup(); }
  }
}
module.exports = { receiveUpload, sniff, filename };
