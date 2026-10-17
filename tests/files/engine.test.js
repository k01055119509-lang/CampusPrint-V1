'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { PDFDocument, PDFName, rgb } = require('pdf-lib');
const { createHash } = require('node:crypto');
const { isolated, Client, PROJECT } = require('../helpers/runtime');
const { parsePages, validatePageNumbers } = require('../../backend/files/pages');
const fixture = name => fs.readFile(path.join(PROJECT, 'tests/fixtures', name));
async function uploadReady(runtime, client, buffer, name = 'source.pdf', type = 'application/pdf') {
  const result = await client.upload(buffer, name, type); assert.equal(result.status, 202, JSON.stringify(result.body));
  await runtime.files.waitForIdle(); return (await client.request('GET', `/api/files/${result.body.data.id}`)).body.data;
}
async function bytes(opened) { try { return await opened.handle.readFile(); } finally { await opened.handle.close(); } }
test('真实文件处理、选页产物与权限', async t => {
  const runtime = await isolated(); t.after(() => runtime.destroy());
  const student = new Client(runtime), other = new Client(runtime), admin = new Client(runtime);
  await student.guest(); await other.guest(); await admin.admin();
  let source, artifact;
  await t.test('100 页源文件只解析页数；选择 1、2、100 页按原顺序输出 A4', async () => {
    source = await uploadReady(runtime, student, await fixture('source-100-pages.pdf'));
    assert.equal(source.status, 'ready'); assert.equal(source.sourcePageCount, 100);
    assert.equal(runtime.db.get("SELECT COUNT(*) AS n FROM artifacts WHERE fileId=? AND kind LIKE '%preview'", source.id).n, 0);
    artifact = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [100, 2, 1], preparationId: 'ordered-three-pages' });
    assert.deepEqual(artifact.pageNumbers, [1, 2, 100]); assert.equal(artifact.pageCount, 3); assert.equal(artifact.copiesInPdf, 1);
    const output = await bytes(await runtime.files.openArtifactForRead({ actor: student.user, artifactId: artifact.artifactId }));
    assert.equal(createHash('sha256').update(output).digest('hex'), artifact.sha256);
    const document = await PDFDocument.load(output); assert.equal(document.getPageCount(), 3);
    for (const page of document.getPages()) { assert(Math.abs(page.getWidth() - 595.2756) < .01); assert(Math.abs(page.getHeight() - 841.8898) < .01); }
    assert.equal(document.catalog.get(PDFName.of('OpenAction')), undefined);
    const repeated = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [1, 2, 100], preparationId: 'ordered-three-pages' });
    assert.equal(repeated.artifactId, artifact.artifactId); assert.equal(repeated.sha256, artifact.sha256);
    await assert.rejects(runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [1], preparationId: 'ordered-three-pages' }), error => error.code === 'PREPARATION_CONFLICT');
    await assert.rejects(runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [101], preparationId: 'out-of-range' }), error => error.status === 400);
  });
  await t.test('原文件按需预览、派生预览的哈希绑定与灰度', async () => {
    const response = await student.request('GET', `/api/files/${source.id}/preview?page=100`, undefined, { raw: true });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(runtime.db.get("SELECT COUNT(*) AS n FROM artifacts WHERE fileId=? AND kind='source_preview'", source.id).n, 1);
    const opened = await runtime.files.openArtifactForRead({ actor: student.user, artifactId: artifact.artifactId, purpose: 'preview', page: 2 });
    assert.equal(opened.productionSha256, artifact.sha256); const preview = await bytes(opened);
    const { data, info } = await sharp(preview).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1200);
    let nonwhite = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (info.channels >= 3) assert(Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) <= 1);
      if (data[i] < 245) nonwhite++;
    }
    assert(nonwhite > 10000);
    const cached = await runtime.files.openArtifactForRead({ actor: student.user, artifactId: artifact.artifactId, purpose: 'preview', page: 2 });
    assert.equal(createHash('sha256').update(await bytes(cached)).digest('hex'), createHash('sha256').update(preview).digest('hex'));
  });
  await t.test('他人文件 404，匿名文件 401，管理员履约可读，静态目录不可泄露', async () => {
    assert.equal((await other.request('GET', `/api/files/${source.id}`)).status, 404);
    assert.equal((await other.request('GET', `/api/files/${source.id}/preview`)).status, 404);
    const guest = new Client(runtime); assert.equal((await guest.request('GET', `/api/files/${source.id}`)).status, 401);
    await assert.rejects(runtime.files.openArtifactForRead({ actor: other.user, artifactId: artifact.artifactId }), error => error.status === 404);
    assert((await bytes(await runtime.files.openArtifactForRead({ actor: admin.user, artifactId: artifact.artifactId }))).length > 1000);
    assert.equal((await guest.request('GET', `/var/student-files/${source.id}/original.bin`)).status, 404);
    assert.equal((await student.request('GET', '/api/files/..%5c..%5csecret')).status, 404);
    assert.equal((await student.upload(await fixture('sample-chinese.png'), 'a.png', 'image/png', { 'X-CSRF-Token': 'wrong' })).status, 403);
  });
  await t.test('EXIF 方向、PNG 与中文 PDF 均可生成生产文件', async () => {
    const oriented = await uploadReady(runtime, student, await fixture('orientation-6.jpg'), 'orientation.jpg', 'image/jpeg');
    assert.equal(oriented.status, 'ready'); assert.equal(oriented.sourcePageCount, 1);
    const row = runtime.db.get("SELECT relativePath FROM artifacts WHERE fileId=? AND kind='normalized'", oriented.id);
    const metadata = await sharp(path.join(runtime.config.fileRoot, row.relativePath)).metadata(); assert.equal(metadata.width, 300); assert.equal(metadata.height, 600); assert.equal(metadata.orientation, undefined);
    for (const [name, mime] of [['sample-chinese.png', 'image/png'], ['sample-chinese.pdf', 'application/pdf']]) {
      const file = await uploadReady(runtime, student, await fixture(name), name, mime); assert.equal(file.status, 'ready');
      const production = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: file.id, pageNumbers: [1], preparationId: name });
      const output = await bytes(await runtime.files.openArtifactForRead({ actor: student.user, artifactId: production.artifactId }));
      assert.equal((await PDFDocument.load(output)).getPageCount(), 1);
      if (name.endsWith('.pdf')) {
        const evidence = path.join(process.env.CP_VERIFICATION_DIR || path.join(PROJECT, 'docs/verification/A'), 'samples'); await fs.mkdir(evidence, { recursive: true });
        await fs.writeFile(path.join(evidence, 'chinese-a4-gray.pdf'), output);
        await fs.writeFile(path.join(evidence, 'chinese-production-preview.png'), await bytes(await runtime.files.openArtifactForRead({ actor: student.user, artifactId: production.artifactId, purpose: 'preview' })));
      }
    }
  });
});
test('页码语法拒绝零、重复、交叉、空范围、越界和任意重排', () => {
  assert.deepEqual(parsePages('3,1-2', 100), [1, 2, 3]); assert.deepEqual(parsePages('all', 3), [1, 2, 3]);
  for (const pages of ['', '0', '-1', '1,,2', '3-1', '1-3,3', '1-3,2-4', '101', '1.5', '1-', '1-1000000']) assert.throws(() => parsePages(pages, 100));
  assert.throws(() => validatePageNumbers([1, 1], 100)); assert.throws(() => validatePageNumbers([1.5], 100));
  assert.throws(() => parsePages('all', 2000)); assert.deepEqual(parsePages('100,2000', 2000), [100, 2000]);
});
test('格式、损坏、加密、XFA 和空文件明确拒绝', async t => {
  const runtime = await isolated(); t.after(() => runtime.destroy()); const student = new Client(runtime); await student.guest();
  assert.equal((await student.upload(Buffer.from('PK-not-a-PDF'), 'word.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).status, 415);
  assert.equal((await student.upload(await fixture('sample-chinese.png'), 'fake.pdf', 'application/pdf')).status, 415);
  assert.equal((await student.upload(Buffer.alloc(0))).status, 400);
  for (const [buffer, name, mime, code] of [
    [Buffer.from('%PDF-1.7\nnot a document'), 'corrupt.pdf', 'application/pdf', 'FILE_CORRUPT'],
    [await fixture('encrypted.pdf'), 'encrypted.pdf', 'application/pdf', 'FILE_ENCRYPTED'],
    [await fixture('unsupported-xfa.pdf'), 'xfa.pdf', 'application/pdf', 'FILE_UNSUPPORTED_CONTENT'],
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), 'corrupt.png', 'image/png', 'FILE_CORRUPT']
  ]) {
    const file = await uploadReady(runtime, student, buffer, name, mime); assert.equal(file.status, 'failed'); assert.equal(file.error.code, code);
    assert(!JSON.stringify(file).includes(runtime.root));
  }
});
test('文件大小、源页数、图片像素和处理时间上限', async t => {
  const runtime = await isolated({ limits: { maxFileBytes: 4096, maxSourcePages: 2, maxImagePixels: 10000 } }); t.after(() => runtime.destroy());
  const student = new Client(runtime); await student.guest();
  assert.equal((await student.upload(Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(5000)]))).status, 413);
  assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM files').n, 0); assert.deepEqual(await fs.readdir(runtime.config.tempRoot), []);
  const many = await PDFDocument.create(); for (let i = 0; i < 3; i++) many.addPage([595, 842]);
  const pages = await uploadReady(runtime, student, await many.save()); assert.equal(pages.error.code, 'FILE_PAGE_LIMIT');
  const png = await sharp({ create: { width: 101, height: 101, channels: 3, background: '#fff' } }).png().toBuffer();
  const pixels = await uploadReady(runtime, student, png, 'pixels.png', 'image/png'); assert.equal(pixels.error.code, 'FILE_PIXEL_LIMIT');
  const timed = await isolated({ limits: { inspectionTimeoutMs: 1 } }); t.after(() => timed.destroy()); const timedUser = new Client(timed); await timedUser.guest();
  const file = await uploadReady(timed, timedUser, await fixture('sample-chinese.pdf')); assert.equal(file.error.code, 'FILE_PROCESS_TIMEOUT');
  assert.equal(timed.db.get('SELECT attempts FROM file_jobs').attempts, 1);
});
test('处理并发、进程异常有限重试和队列保护', async t => {
  const runtime = await isolated({ limits: { maxJobsInFlight: 1, maxQueuedJobs: 1 } }); t.after(() => runtime.destroy()); const student = new Client(runtime); await student.guest();
  const source = await uploadReady(runtime, student, await fixture('source-100-pages.pdf'));
  const original = runtime.files.pool.execute.bind(runtime.files.pool); let first = true;
  runtime.files.pool.execute = item => { const result = original(item); if (first) { first = false; setImmediate(() => item.child?.kill('SIGKILL')); } return result; };
  const recovering = runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [1], preparationId: 'retry-once' });
  const beginning = performance.now(); assert.equal((await student.request('GET', '/api/auth/me')).status, 200); assert(performance.now() - beginning < 1500);
  await recovering; assert.equal(runtime.db.get("SELECT attempts FROM file_jobs WHERE requestKey='prepare:retry-once'").attempts, 2);
  runtime.files.pool.execute = original;
  const firstJob = runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [1, 2], preparationId: 'parallel-1' });
  const secondJob = runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [99, 100], preparationId: 'parallel-2' });
  await assert.rejects(runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [3], preparationId: 'queue-overflow' }), error => error.code === 'FILE_QUEUE_FULL');
  const outputs = await Promise.all([firstJob, secondJob]); assert.equal(outputs.length, 2); assert.equal(runtime.files.pool.status().running <= 1, true);
  runtime.files.pool.execute = item => { const result = original(item); setImmediate(() => item.child?.kill('SIGKILL')); return result; };
  await assert.rejects(runtime.files.preparePrintItem({ userId: student.user.id, fileId: source.id, pageNumbers: [1], preparationId: 'retry-exhausted' }), error => error.code === 'FILE_PROCESS_CRASH');
  assert.equal(runtime.db.get("SELECT attempts FROM file_jobs WHERE requestKey='prepare:retry-exhausted'").attempts, 2);
  assert.equal(runtime.db.get("SELECT status FROM preparations WHERE preparationId='retry-exhausted'").status, 'failed');
  assert.equal((await student.request('GET', '/api/auth/me')).status, 200);
});
module.exports = { uploadReady, bytes, fixture };
