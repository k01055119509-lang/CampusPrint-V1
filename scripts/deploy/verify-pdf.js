'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const {ROOT}=require('../../backend/config');
async function main(){
  const evidenceRoot=process.env.CP_VERIFICATION_DIR||path.join(ROOT,'docs/verification/guest-pricing-coupons-v1.1.0/C/local-pdf'),root=path.join(evidenceRoot,'samples'),pdfs=[],images=[];let warnings=false;
  for(const [name,prefix]of [['selected-pages-production.pdf','selected'],['oriented-image-production.pdf','oriented']]){
    const file=path.join(root,name),rendered=spawnSync('pdftoppm',['-r','100','-png',file,path.join(root,prefix)],{encoding:'utf8',windowsHide:true});if(rendered.error||rendered.status!==0)throw Error(rendered.error?.message||rendered.stderr);warnings||=rendered.stderr.includes('nameToUnicode');pdfs.push({file:name,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
  }
  for(const name of(await fs.readdir(root)).filter(name=>/^(selected|oriented)-\d+\.png$/.test(name))){const {data,info}=await sharp(path.join(root,name)).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});let coloredPixels=0;for(let i=0;i<data.length;i+=info.channels)if(data[i]!==data[i+1]||data[i]!==data[i+2])coloredPixels++;if(coloredPixels)throw Error(name+': unexpected color pixels');images.push({name,width:info.width,height:info.height,coloredPixels});}
  const report={kind:'C-independent-Poppler-raster-QA',at:new Date().toISOString(),pdfs,images,visualInspectionRequired:true,popplerNameToUnicodeWarnings:warnings,realPrinting:false};
  await fs.writeFile(path.join(evidenceRoot,'pdf-qa.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pdfs:pdfs.length,images:images.length,unexpectedColoredPixels:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
