'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFDict } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const sharp = require('sharp');
async function main() {
  const root = path.resolve(__dirname, '../fixtures'); await fs.mkdir(root, { recursive: true });
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 100; n++) {
    const page = document.addPage(n === 2 ? [842, 595] : [595, 842]);
    page.drawText(`CAMPUS PRINT - PAGE ${String(n).padStart(3, '0')}`, { x: 36, y: page.getHeight() - 60, font, size: 24, color: rgb(.1, .2, .6) });
    page.drawText('Synthetic software test. No student data.', { x: 36, y: page.getHeight() - 90, font, size: 12 });
    page.drawText('Text sample 10 pt: ABCDEFG abcdefg 0123456789', { x: 36, y: page.getHeight() - 120, font, size: 10 });
    page.drawRectangle({ x: 15, y: 15, width: page.getWidth() - 30, height: page.getHeight() - 30, borderWidth: 1, borderColor: rgb(0, .4, .3) });
  }
  await fs.writeFile(path.join(root, 'source-100-pages.pdf'), await document.save());
  const surface = createCanvas(900, 1300), context = surface.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 900, 1300); context.fillStyle = '#27315c';
  context.font = '42px "Microsoft YaHei", sans-serif'; context.fillText('校园打印 · 软件验证样本', 50, 90);
  context.font = '24px "Microsoft YaHei", sans-serif';
  ['这是一份脱敏样本，没有真实学生资料。', 'A4 黑白输出，保留完整内容并按比例缩放。', '单面与双面按实际纸张计费。', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789 / 0.50 / 49.50'].forEach((text, index) => context.fillText(text, 50, 155 + index * 55));
  context.strokeStyle = '#b74b36'; context.lineWidth = 3; context.strokeRect(18, 18, 864, 1264);
  context.fillStyle = '#14776c'; context.fillRect(50, 650, 800, 100); context.fillStyle = 'white'; context.fillText('上下边界均须完整可见', 70, 712);
  const samplePng = surface.toBuffer('image/png'); await fs.writeFile(path.join(root, 'sample-chinese.png'), samplePng);
  const chinesePdf = await PDFDocument.create(), embedded = await chinesePdf.embedPng(samplePng);
  chinesePdf.addPage([595, 842]).drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
  await fs.writeFile(path.join(root, 'sample-chinese.pdf'), await chinesePdf.save());
  const rotated = createCanvas(600, 300), rotationContext = rotated.getContext('2d');
  rotationContext.fillStyle = '#fff'; rotationContext.fillRect(0, 0, 600, 300);
  rotationContext.fillStyle = '#1942bb'; rotationContext.fillRect(0, 0, 200, 100);
  rotationContext.fillStyle = '#181818'; rotationContext.font = '28px sans-serif'; rotationContext.fillText('EXIF ORIENTATION 6', 30, 180);
  await fs.writeFile(path.join(root, 'orientation-6.jpg'), await sharp(rotated.toBuffer('image/png')).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  // Owner/password protection is generated once with bundled pypdf, kept as a static fixture.
  const xfa = await PDFDocument.create(); xfa.addPage([595, 842]);
  xfa.catalog.set(PDFName.of('AcroForm'), xfa.context.obj({ XFA: 'unsupported' }));
  await fs.writeFile(path.join(root, 'unsupported-xfa.pdf'), await xfa.save());
  console.log('Synthetic fixtures written. Windows fonts are used only to draw fixture images, not by the application.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
