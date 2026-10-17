'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { ROOT } = require('../../backend/config');
const { assertNoLinks, ensureRoot } = require('../../backend/files/safety');
const { copyTree } = require('../../backend/files/backups');
const VERSION = require('../../package.json').version;
const allowed = ['backend', 'config', 'contracts', 'frontend', 'scripts/backend/init-db.js', 'scripts/backend/init-admin.js', 'scripts/backend/files-maintenance.js', 'scripts/deploy/backup.js', 'scripts/desktop',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/licenses', 'docs/V1.4.0-学生使用说明.md', 'docs/V1.4.0-经营者使用说明.md', 'docs/V1.4.0-部署与维护说明.md', 'docs/V1.4.0-简明使用说明.html', 'docs/V1.4.0验收报告.md', 'docs/学生使用说明.md', 'docs/经营者使用说明.md', 'docs/校园打印-简明使用说明.html', 'docs/部署与维护说明.md', 'docs/真实环境试用与纸张验收清单.md', 'scripts/deploy/Caddyfile.example', 'scripts/deploy/campus-print.service.example', '.env.example', '.node-version'];
async function inventory(root, relative = '') {
  const rows = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name); await assertNoLinks(path.join(root, name));
    if (entry.isDirectory()) rows.push(...await inventory(root, name));
    else rows.push({ path: name.replaceAll('\\', '/'), bytes: (await fs.stat(path.join(root, name))).size, sha256: createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex') });
  }
  return rows;
}
async function buildPackage(destination = path.join(ROOT, 'dist', 'CampusPrint-V'+VERSION+'-'+randomUUID().slice(0,8))) {
  if (!path.isAbsolute(destination)) throw new Error('Absolute package destination required');
  await ensureRoot(path.dirname(destination)); await fs.mkdir(destination); // Never overwrite a prior delivery.
  for (const relative of allowed) {
    const source = path.join(ROOT, relative);
    try { await fs.stat(source); } catch (error) { if (error.code === 'ENOENT' && relative.startsWith('docs/')) continue; throw error; }
    await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true }); await copyTree(source, path.join(destination, relative));
  }
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies; pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([key]) => ['start','db:init','admin:init','files:cleanup','files:manifest','files:reconcile','backup:create','backup:authority','backup:restore'].includes(key)));
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8')); delete lock.packages[''].devDependencies;
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(pkg, null, 2)+'\n');
  await fs.writeFile(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2)+'\n');
  const files = await inventory(destination);
  if (files.some(row => /(^|\/)(var|tmp|tests|assets-inbox|node_modules|\.env)(\/|$)|\.(sqlite|db)$/i.test(row.path))) throw new Error('Private runtime data found in package');
  await fs.writeFile(path.join(destination, 'package-manifest.json'), JSON.stringify({ product:'campus-print-v1',version:VERSION,createdAt:new Date().toISOString(),files,privateDataIncluded:false,initialPaymentConfigured:false },null,2));
  return { directory: destination, files: files.length };
}
if (require.main === module) buildPackage(process.argv[2] ? path.resolve(process.argv[2]) : undefined).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPackage, inventory };
