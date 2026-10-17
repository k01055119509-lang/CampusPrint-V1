'use strict';
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { invalid } = require('../errors');
async function sendArtifact(req, res, opened, { attachment = false } = {}) {
  try {
    opened.checkAccess();
    res.set({ 'Content-Type': opened.mimeType, 'Content-Length': String(opened.byteSize), 'Cache-Control': 'no-store, private',
      'X-Artifact-SHA256': opened.sha256 });
    if (opened.productionSha256) res.set('X-Print-Artifact-SHA256', opened.productionSha256);
    if (opened.expiresAt) res.set('X-File-Expires-At', opened.expiresAt);
    if (attachment) res.attachment(opened.filename);
    const check = new Transform({ transform(chunk, encoding, callback) { try { opened.checkAccess(); callback(null, chunk); } catch (error) { callback(error); } } });
    await pipeline(opened.handle.createReadStream({ start: 0, autoClose: false }), check, res);
  } finally { await opened.handle.close(); }
}
module.exports = function registerFiles(context) {
  const { add, files, auth, config } = context;
  add('post', '/files', { role: 'user', multipart: true, transaction: false, status: 202, blocked: true }, (req, res) => {
    context.orders.accepting();
    auth.rate(`upload:${req.user.id}`, config.rateLimits.uploadUser, 60000, res); return files.upload(req);
  });
  add('get', '/files/:id', { role: 'session' }, req => files.getFile({ actor: req.user, fileId: req.params.id }));
  add('get', '/files/:id/preview', { role: 'session', raw: true }, async (req, res) => {
    const raw = req.query.page || '1'; if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) invalid('page', '页码须为正整数');
    for (const key of Object.keys(req.query)) if (key !== 'page') invalid(key, '不支持此查询参数');
    auth.rate(`preview:${req.user.id}`, config.rateLimits.previewUser, 60000, res);
    await sendArtifact(req, res, await files.sourcePreview({ actor: req.user, fileId: req.params.id, page: Number(raw) }));
  });
  add('delete', '/files/:id', { role: 'user', transaction: false, bodyKeys: [] }, req => files.deleteUpload({ userId: req.user.id, fileId: req.params.id }));
  add('get', '/admin/files/cleanup-status', { role: 'admin' }, () => files.cleanupStatus());
  add('post', '/admin/files/cleanup-run', { role: 'admin', transaction: false, bodyKeys: [] }, req => {
    if (Object.keys(req.query).length) invalid('query', '清理接口不接受路径或调时参数'); return files.purgeExpiredFiles();
  });
};
module.exports.sendArtifact = sendArtifact;
