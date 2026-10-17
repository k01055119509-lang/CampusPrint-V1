'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const project=path.resolve(__dirname,'../..'),output=path.join(project,'tests/user/evidence');
const baseline=JSON.parse(fs.readFileSync(path.join(output,'boundaries-before.json'),'utf8').replace(/^\uFEFF/,''));
const entries=baseline.map(item=>({...item,currentSha256:createHash('sha256').update(fs.readFileSync(path.join(project,item.path))).digest('hex')}));
const changed=entries.filter(item=>item.sha256!==item.currentSha256);
const roots=['backend','contracts','config','frontend/shared','frontend/vendor','frontend/admin','scripts/backend','scripts/admin','tests/base','tests/files','tests/business','tests/admin','tests/helpers','tests/fixtures'];
const known=new Set(baseline.map(item=>item.path));
function walk(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(directory,item.name)):item.isFile()?[path.relative(project,path.join(directory,item.name)).replaceAll('\\','/')]:[]);}
const added=roots.flatMap(root=>walk(path.join(project,root))).filter(file=>!known.has(file));
fs.writeFileSync(path.join(output,'boundaries-after.json'),JSON.stringify({checkedAt:new Date().toISOString(),count:entries.length,changed,added,entries},null,2));
console.log(JSON.stringify({protectedFiles:entries.length,changed:changed.map(item=>item.path),added}));
process.exitCode=changed.length||added.length?1:0;
