'use strict';
// One untrusted document per short-lived process. No URL/document script evaluation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const canvas = require('@napi-rs/canvas');
const { PDFDocument, PDFName, PDFDict, PDFRawStream } = require('pdf-lib');
sharp.cache(false); sharp.concurrency(1);
global.DOMMatrix = canvas.DOMMatrix; global.Path2D = canvas.Path2D; global.ImageData = canvas.ImageData;
const noNetwork = () => { throw new Error('REMOTE_RESOURCE_DISABLED'); };
global.fetch = noNetwork;
for (const moduleName of ['node:http', 'node:https']) { const network = require(moduleName); network.request = noNetwork; network.get = noNetwork; }
const net = require('node:net'); net.connect = noNetwork; net.createConnection = noNetwork;
const warningFlags = new Set();
function decoderWarning(...values) {
  const message = values.filter(value => typeof value === 'string').join(' ');
  if (/exceeded maximum allowed size|image.*too large/i.test(message)) warningFlags.add('pixels');
  if (/unable to decode image|unable to load.*font|jpxerror|jbig2error/i.test(message)) warningFlags.add('unsupported');
}
// Suppress decoder diagnostics that might contain private document text or paths.
console.log = decoderWarning; console.warn = decoderWarning;
const A4 = [595.2755905511812, 841.8897637795277];
const fail = (code, message, status = 422) => { throw Object.assign(new Error(message), { publicCode: code, publicStatus: status }); };
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
let pdfjsPromise;
async function pdfjs() { return pdfjsPromise ||= import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href); }
async function loadPdf(input, limits) {
  const bytes = await fs.readFile(input);
  let document;
  try { document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true }); }
  catch (error) {
    fail('FILE_CORRUPT', 'PDF 无法完整读取，请重新导出 PDF 后上传');
  }
  // Parsing the encryption dictionary does not decrypt or render it. Reject before PDF.js or any image operation.
  if (document.isEncrypted) fail('FILE_ENCRYPTED', '不支持受密码保护的 PDF，请解除保护后上传', 415);
  const form = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (form?.has(PDFName.of('XFA'))) fail('FILE_UNSUPPORTED_CONTENT', '不支持动态 XFA 表单，请先导出为普通 PDF', 415);
  const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (names?.has(PDFName.of('EmbeddedFiles'))) fail('FILE_UNSUPPORTED_CONTENT', '不支持含内嵌附件的 PDF，请移除附件后上传', 415);
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const width = object.dict.get(PDFName.of('Width'))?.asNumber?.(), height = object.dict.get(PDFName.of('Height'))?.asNumber?.();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > limits.maxImagePixels) fail('FILE_PIXEL_LIMIT', 'PDF 内嵌图片超过像素上限，请压缩图片后上传', 413);
  }
  const lib = await pdfjs(), distRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const localAssets = name => path.join(distRoot, name).replaceAll(path.sep, '/') + '/';
  const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 1,
    isEvalSupported: false, useSystemFonts: false, disableFontFace: true, enableXfa: false,
    stopAtErrors: true, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, disableRange: true,
    maxImageSize: limits.maxImagePixels,
    cMapUrl: localAssets('cmaps'), standardFontDataUrl: localAssets('standard_fonts'),
    wasmUrl: localAssets('wasm'), iccUrl: localAssets('iccs')
  });
  let pdf;
  try { pdf = await task.promise; } catch (error) {
    await task.destroy();
    if (error.name === 'PasswordException') fail('FILE_ENCRYPTED', '不支持受密码保护的 PDF，请解除保护后上传', 415);
    fail('FILE_CORRUPT', 'PDF 无法读取，请重新导出 PDF 后上传');
  }
  if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) { await pdf.loadingTask.destroy(); fail('FILE_EMPTY', 'PDF 没有可打印内容页'); }
  if (pdf.numPages > limits.maxSourcePages) { await pdf.loadingTask.destroy(); fail('FILE_PAGE_LIMIT', '源 PDF 超过服务器公布的页数上限，请拆分文件', 413); }
  return pdf;
}
async function image(input, limits, output, { payment = false } = {}) {
  const pipeline = sharp(input, { limitInputPixels: limits.maxImagePixels, failOn: 'warning', sequentialRead: true });
  let metadata;
  try { metadata = await pipeline.metadata(); } catch (error) {
    if (/pixel limit/i.test(error.message)) fail('FILE_PIXEL_LIMIT', '图片超过像素上限，请缩小后上传', 413);
    fail('FILE_CORRUPT', '图片损坏或无法读取，请重新导出 JPG 或 PNG');
  }
  if (!['jpeg', 'png'].includes(metadata.format) || (metadata.pages || 1) !== 1) fail('FILE_UNSUPPORTED_CONTENT', '只支持静态 JPG/PNG 图片', 415);
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > limits.maxImagePixels) fail('FILE_PIXEL_LIMIT', '图片超过像素上限', 413);
  let converted = pipeline.autoOrient().flatten({ background: '#ffffff' });
  if (!payment) converted = converted.greyscale();
  if (payment) converted = converted.resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });
  const result = await converted.png().toBuffer({ resolveWithObject: true });
  await fs.writeFile(output, result.data, { flag: 'wx' });
  return { width: result.info.width, height: result.info.height, sha256: hash(result.data), byteSize: result.data.length };
}
async function renderPdfPage(pdf, number, limits, width = null) {
  const page = await pdf.getPage(number), initial = page.getViewport({ scale: 1 });
  if (!initial.width || !initial.height || !Number.isFinite(initial.width + initial.height)) fail('FILE_CORRUPT', 'PDF 页面尺寸无效');
  const margin = limits.marginMm / 25.4 * 72, scale = width ? width / initial.width : Math.min((A4[0] - margin * 2) / initial.width, (A4[1] - margin * 2) / initial.height) * limits.printDpi / 72;
  const viewport = page.getViewport({ scale }), w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
  if (w * h > limits.maxPagePixels || w < 1 || h < 1) fail('FILE_PIXEL_LIMIT', '页面渲染超过像素资源上限', 413);
  const surface = canvas.createCanvas(w, h), context = surface.getContext('2d');
  await page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)', annotationMode: 1 }).promise;
  if (warningFlags.has('pixels')) fail('FILE_PIXEL_LIMIT', '页面含超限图片，请压缩后重新上传', 413);
  if (warningFlags.has('unsupported')) fail('FILE_UNSUPPORTED_CONTENT', '页面含无法可靠显示的图片或字体，请重新导出 PDF', 415);
  const bytes = surface.toBuffer('image/png');
  surface.width = 1; surface.height = 1; page.cleanup();
  return bytes;
}
async function a4Image(bytes, limits) {
  const width = Math.round(A4[0] / 72 * limits.printDpi), height = Math.round(A4[1] / 72 * limits.printDpi);
  const margin = Math.round(limits.marginMm / 25.4 * limits.printDpi);
  const inner = await sharp(bytes, { limitInputPixels: limits.maxImagePixels }).greyscale().flatten({ background: '#fff' })
    .resize(width - margin * 2, height - margin * 2, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite([{ input: inner.data,
    left: Math.floor((width - inner.info.width) / 2), top: Math.floor((height - inner.info.height) / 2) }]).greyscale().png().toBuffer();
}
async function processJob(job) {
  const { operation, input, outputDir, limits } = job;
  await fs.mkdir(outputDir, { recursive: true });
  if (operation === 'payment_image') {
    const result = await image(input, limits, path.join(outputDir, 'payment.png'), { payment: true });
    return { ...result, name: 'payment.png', mimeType: 'image/png' };
  }
  if (operation === 'inspect' && job.mimeType !== 'application/pdf') {
    const result = await image(input, limits, path.join(outputDir, 'normalized.png'));
    return { sourcePageCount: 1, normalized: { ...result, name: 'normalized.png', mimeType: 'image/png' } };
  }
  let pdf;
  if (job.mimeType === 'application/pdf' || operation === 'production_preview') pdf = await loadPdf(input, limits);
  try {
    if (operation === 'inspect') {
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), box = page.getViewport({ scale: 1 });
        if (!Number.isFinite(box.width + box.height) || box.width <= 0 || box.height <= 0) fail('FILE_CORRUPT', 'PDF 中存在尺寸无效的页面');
        page.cleanup();
      }
      return { sourcePageCount: pdf.numPages };
    }
    if (operation === 'prepare') {
      const count = pdf ? pdf.numPages : 1;
      if (!job.pageNumbers?.length || job.pageNumbers.length > limits.maxPreparedPages || job.pageNumbers.some((p, i) => !Number.isSafeInteger(p) || p < 1 || p > count || (i && p <= job.pageNumbers[i - 1]))) fail('FILE_INVALID_PAGES', '选页无效或超出资源上限', 400);
      const result = await PDFDocument.create(); result.setProducer('CampusPrint A4 grayscale renderer'); result.setCreator('CampusPrint V1');
      let total = 0;
      for (const number of job.pageNumbers) {
        const bytes = pdf ? await renderPdfPage(pdf, number, limits) : await fs.readFile(input);
        const normalized = await a4Image(bytes, limits); total += normalized.length;
        if (total > limits.maxDerivedBytes) fail('FILE_OUTPUT_LIMIT', '生产文件超过资源上限，请减少选页或压缩文件', 413);
        const embedded = await result.embedPng(normalized);
        const page = result.addPage(A4); page.drawImage(embedded, { x: 0, y: 0, width: A4[0], height: A4[1] });
      }
      const bytes = await result.save({ useObjectStreams: true });
      if (bytes.length > limits.maxDerivedBytes) fail('FILE_OUTPUT_LIMIT', '生产文件超过资源上限', 413);
      await fs.writeFile(path.join(outputDir, 'print.pdf'), bytes, { flag: 'wx' });
      // Preview is intentionally rendered from the saved production PDF, never from the original.
      const production = await loadPdf(path.join(outputDir, 'print.pdf'), limits);
      try {
        const preview = await renderPdfPage(production, 1, limits, limits.previewWidthPx);
        await fs.writeFile(path.join(outputDir, 'preview-1.png'), preview, { flag: 'wx' });
        return { pageCount: job.pageNumbers.length, name: 'print.pdf', sha256: hash(bytes), byteSize: bytes.length,
          preview: { name: 'preview-1.png', sha256: hash(preview), byteSize: preview.length } };
      } finally { await production.loadingTask.destroy(); }
    }
    if (operation === 'source_preview' || operation === 'production_preview') {
      const number = job.page;
      if (!Number.isSafeInteger(number) || number < 1 || number > (pdf?.numPages || 1)) fail('FILE_INVALID_PAGES', '页码超出范围', 400);
      const raw = pdf ? await renderPdfPage(pdf, number, limits, operation === 'production_preview' ? limits.previewWidthPx : null) : await fs.readFile(input);
      const preview = operation === 'production_preview' ? raw : await sharp(await a4Image(raw, limits)).resize({ width: limits.previewWidthPx }).png().toBuffer();
      await fs.writeFile(path.join(outputDir, 'preview.png'), preview, { flag: 'wx' });
      return { name: 'preview.png', sha256: hash(preview), byteSize: preview.length };
    }
    fail('FILE_PROCESS_UNSUPPORTED', '文件处理类型未实现');
  } finally { if (pdf) await pdf.loadingTask.destroy(); }
}
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { input += data; if (input.length > 65536) process.exit(2); });
process.stdin.on('end', async () => {
  // Only compact, sanitized results reach the parent. Never return a decoder stack or path.
  try { const data = await processJob(JSON.parse(input)); process.stdout.write(JSON.stringify({ ok: true, data })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.publicCode || 'FILE_CORRUPT', status: error.publicStatus || 422,
    message: error.publicCode ? error.message : '文件处理失败，请重新导出为 PDF/JPG/PNG 后重试' })); }
});

