'use strict';
// Build a clean, self-contained Windows x64 distribution. Never copy a live data root.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ROOT, inside } = require('../../backend/config');
const { buildPackage, inventory } = require('./package');
const VERSION = require('../../package.json').version;
function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build on Windows x64 with the locked runtime');
  const nodeVersion = (await fs.readFile(path.join(ROOT, '.node-version'), 'utf8')).trim();
  const expected = 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56';
  if (nodeVersion !== '24.16.0' || process.versions.node !== nodeVersion) throw Error('Portable runtime provenance needs updating for this version');
  const name = process.argv[2] || `CampusPrint-V${VERSION}-Windows-x64-Portable-20261016`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error('Use a simple release folder name');
  const destination = path.join(ROOT, 'dist', name), archive = destination + '.zip';
  if (await fs.stat(archive).then(() => true, () => false)) throw Error('Archive already exists; never overwrite a delivery');
  const output = path.resolve(process.env.CP_VERIFICATION_DIR || path.join(ROOT, 'docs/verification/portable-v1.4.0/build-20261016'));
  await fs.mkdir(output, { recursive: true });
  const cached = path.join(ROOT, 'tmp/portable-build-downloads'), nodeZip = path.join(cached, `node-v${nodeVersion}-win-x64.zip`);
  const sums = await fs.readFile(path.join(cached, 'SHASUMS256.txt'), 'utf8');
  if (!sums.includes(expected + '  ' + path.basename(nodeZip))) throw Error('Official checksum file does not match');
  const hash = createHash('sha256').update(await fs.readFile(nodeZip)).digest('hex');
  if (hash !== expected) throw Error('Official Node archive digest mismatch');
  const oldArchives = [];
  for (const file of (await fs.readdir(path.join(ROOT, 'dist'))).filter(f => f.endsWith('.zip'))) {
    oldArchives.push({ file, sha256: createHash('sha256').update(await fs.readFile(path.join(ROOT, 'dist', file))).digest('hex') });
  }
  await buildPackage(destination);
  const runtime = path.join(destination, 'runtime'); await fs.mkdir(runtime);
  const ps = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const extractor = path.join(output, 'extract-runtime.ps1');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await fs.writeFile(extractor, '\uFEFF' + `$ErrorActionPreference='Stop'\r\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\r\n$z=[IO.Compression.ZipFile]::OpenRead(${quote(nodeZip)})\r\ntry { foreach($n in @('node.exe','LICENSE')) { $e=$z.GetEntry('node-v${nodeVersion}-win-x64/'+$n); if($null -eq $e) { throw 'Runtime member missing' }; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,(Join-Path ${quote(runtime)} $n),$false) } } finally { $z.Dispose() }\r\n`);
  const extracted = await run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', extractor], ROOT);
  if (extracted.code !== 0) throw Error('Runtime extraction failed: ' + extracted.output);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const installed = await run(path.join(runtime, 'node.exe'), [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], destination);
  await fs.writeFile(path.join(output, 'install.log'), installed.output);
  if (installed.code !== 0) throw Error('Clean production dependency installation failed');
  const deps = JSON.parse(await fs.readFile(path.join(destination, 'node_modules/.package-lock.json'), 'utf8'));
  if (Object.values(deps.packages).some(row => row.dev)) throw Error('Development dependencies leaked into portable package');
  const actions = [
    ['01-首次设置.cmd', 'setup'], ['02-启动用户端.cmd', 'user'], ['03-启动经营后台.cmd', 'admin'],
    ['04-停止服务.cmd', 'stop'], ['05-检查运行环境.cmd', 'check']
  ];
  for (const [file, action] of actions) {
    const command = `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset "portable_extra="\r\nif "%CP_PORTABLE_SKIP_BROWSER%"=="1" set "portable_extra=-SkipBrowser"\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\desktop\\portable.ps1" -Action ${action} %portable_extra%\r\nset "portable_exit=%ERRORLEVEL%"\r\nif not "%CP_PORTABLE_NO_PAUSE%"=="1" pause\r\nexit /b %portable_exit%\r\n`;
    await fs.writeFile(path.join(destination, file), command, 'utf8');
  }
  const guide = await fs.readFile(path.join(ROOT, 'docs/Windows便携版使用说明.md'), 'utf8');
  await fs.writeFile(path.join(destination, '00-使用说明.md'), '\uFEFF' + guide);
  await fs.writeFile(path.join(destination, 'README.md'), guide);
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>校园打印便携版使用说明</title><style>body{max-width:920px;margin:36px auto;padding:0 20px;background:#f7fafb;color:#173041;font:16px/1.8 "Microsoft YaHei",sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #d8e4e8;border-radius:12px;padding:24px;font:inherit}</style><pre>' + guide.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre></html>';
  await fs.writeFile(path.join(destination, '00-先读使用说明.html'), html);
  const notices = path.join(destination, 'THIRD_PARTY_NOTICES.md');
  await fs.appendFile(notices, `\n## Windows便携运行环境\n\n内置未经修改的官方Node.js ${nodeVersion} Windows x64 node.exe；完整许可证（含其第三方声明）位于runtime/LICENSE。来源：https://nodejs.org/dist/v${nodeVersion}/ 。本版运行依赖通过锁文件全新安装，许可和原生文件随node_modules保留；无开发依赖。\n`);
  for (const relative of ['scripts/desktop/portable.ps1']) {
    const file = path.join(destination, relative), text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    await fs.writeFile(file, '\uFEFF' + text.replace(/\r?\n/g, '\r\n'));
  }
  const rows = (await inventory(destination)).filter(r => r.path !== 'package-manifest.json');
  if (rows.some(r => /(^|\/)(var|tmp|tests|assets-inbox|\.env)(\/|$)|\.(sqlite|db)$/i.test(r.path))) throw Error('Private data in portable distribution');
  if (rows.some(r => !inside(destination, path.resolve(destination, r.path)))) throw Error('Invalid inventory path');
  const manifest = { product: 'campus-print-v1', version: VERSION, variant: 'windows-x64-offline-portable', createdAt: new Date().toISOString(), nodeVersion, runtimeSource: `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`, runtimeArchiveSha256: expected, files: rows, privateDataIncluded: false, initialPaymentConfigured: false, defaultAdminIncluded: false, networkInstallRequired: false };
  await fs.writeFile(path.join(destination, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const zipScript = path.join(output, 'create-archive.ps1');
  await fs.writeFile(zipScript, '\uFEFF' + `$ErrorActionPreference='Stop'\r\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\r\n[IO.Compression.ZipFile]::CreateFromDirectory(${quote(destination)},${quote(archive)},[IO.Compression.CompressionLevel]::Optimal,$true)\r\n`);
  const zipped = await run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', zipScript], ROOT);
  if (zipped.code !== 0) throw Error('Archive creation failed: ' + zipped.output);
  const archiveHash = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(archive + '.sha256', archiveHash + '  ' + path.basename(archive) + '\r\n');
  const report = { at: new Date().toISOString(), directory: destination, archive, bytes: (await fs.stat(archive)).size, sha256: archiveHash, files: rows.length, productionPackages: Object.keys(deps.packages).length, installedExit: installed.code, nodeVersion, officialRuntimeArchiveSha256: expected, oldArchives, privateDataIncluded: false };
  await fs.writeFile(path.join(output, 'build.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
