'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const h=require('./helpers');
const {PROJECT}=require('../helpers/runtime');
async function image(admin,route,{version,kind='payment',bytes,name='software-test.png',mime='image/png',headers={}}={}) {
  const body=new FormData();body.append('file',new Blob([bytes || await h.fixture('sample-chinese.png')],{type:mime}),name);
  if(version===undefined)version=h.data(await admin.request('GET',kind==='payment'?'/api/admin/settings':'/api/admin/advertisements')).version;
  return admin.request('POST',route,body,{form:true,headers:{[kind==='payment'?'X-Settings-Version':'X-Advertisements-Version']:String(version),...headers}});
}
async function evidence(name,data) {
  const root=process.env.CP_VERIFICATION_DIR?path.resolve(process.env.CP_VERIFICATION_DIR):path.join(PROJECT,'tmp/merchant-evidence');
  await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,name+'.json'),JSON.stringify(data,null,2));
}
module.exports={image,evidence};
