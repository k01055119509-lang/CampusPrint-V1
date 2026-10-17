'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {ROOT,sha}=require('../admin/audit-cancellation-local');
async function main(){
  const output=path.resolve(process.argv[2]),archive=JSON.parse(await fs.readFile(path.join(output,'release-archive.json'),'utf8')),directory=path.resolve(process.argv[3]),manifest=JSON.parse(await fs.readFile(path.join(directory,'package-manifest.json'),'utf8'));
  assert.equal(sha(await fs.readFile(archive.archive)),archive.sha256);assert.equal(manifest.version,'1.4.0');
  for(const row of manifest.files){const bytes=await fs.readFile(path.join(directory,row.path));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);if(!['package.json','package-lock.json'].includes(row.path))assert.equal(sha(await fs.readFile(path.join(ROOT,row.path))),row.sha256,'Release differs from source: '+row.path);}
  const pkg=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8'));delete pkg.devDependencies;pkg.scripts=Object.fromEntries(Object.entries(pkg.scripts).filter(([key])=>['start','db:init','admin:init','files:cleanup','files:manifest','files:reconcile','backup:create','backup:authority','backup:restore'].includes(key)));
  const lock=JSON.parse(await fs.readFile(path.join(ROOT,'package-lock.json'),'utf8'));delete lock.packages[''].devDependencies;
  for(const [name,value]of [['package.json',pkg],['package-lock.json',lock]])assert.equal(await fs.readFile(path.join(directory,name),'utf8'),JSON.stringify(value,null,2)+'\n');
  assert(!manifest.files.some(row=>/(^|\/)(var|tmp|tests|assets-inbox|node_modules|\.env)(\/|$)|\.(sqlite|db)$/i.test(row.path)));
  for(const file of ['backend/migrations/106-cancellation-notice.sql','backend/orders/cancellation.js','frontend/admin/announcement.js','frontend/admin/compensation.js','frontend/user/cancellation-views.js','docs/V1.4.0验收报告.md'])assert(manifest.files.some(row=>row.path===file),'Required release member missing: '+file);
  const archives=[];for(const file of (await fs.readdir(path.join(ROOT,'dist'))).filter(name=>name.endsWith('.zip'))){const bytes=await fs.readFile(path.join(ROOT,'dist',file));archives.push({file,bytes:bytes.length,sha256:sha(bytes)});}
  assert.equal(archives.find(row=>row.file==='CampusPrint-V1.3.0-20261015-C.zip')?.sha256,'8239c4c98f4f0bf2cd0cf1e5d105c04979773fd792f294b95b29dbb877550be8');
  const report={at:new Date().toISOString(),passed:true,version:'1.4.0',archive:archive.archive,archiveSha256:archive.sha256,archiveBytes:(await fs.stat(archive.archive)).size,manifestFiles:manifest.files.length,zipMembers:manifest.files.length+1,allSourceMembersMatch:true,privateDataIncluded:false,archives};await fs.writeFile(path.join(output,'release-gate.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,archiveBytes:report.archiveBytes,manifestFiles:manifest.files.length,archiveSha256:archive.sha256}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
