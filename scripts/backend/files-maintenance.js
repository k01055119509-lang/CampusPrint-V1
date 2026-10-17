'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApp } = require('../../backend/app');
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['cleanup', 'manifest', 'reconcile'].includes(command)) throw new Error('支持 cleanup / manifest / reconcile；先停止同库服务');
  if (command === 'reconcile' && (args.length !== 1 || !path.isAbsolute(args[0]))) throw new Error('reconcile 需要最新权威期限清单的绝对路径');
  if (command !== 'reconcile' && args.length) throw new Error('此命令不接受路径、文件名或调时参数');
  const runtime = await createApp({ recoverFileJobs: false });
  try {
    const result = command === 'manifest' ? runtime.files.exportRetentionManifest() : command === 'cleanup' ? await runtime.files.purgeExpiredFiles()
      : await runtime.files.reconcileRestoredFiles({ latestManifest: JSON.parse(await fs.readFile(args[0], 'utf8')) });
    console.log(JSON.stringify(result, null, 2));
  } finally { await runtime.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
