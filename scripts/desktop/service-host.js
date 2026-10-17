'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {startServer}=require('../../backend/server');
const {ensureRoot,assertNoLinks}=require('../../backend/files/safety');
async function main(){
  const runtime=await startServer(),directory=path.join(runtime.config.dataDir,'desktop-control');
  const instanceFile=path.join(directory,'instance.json'),stopFile=path.join(directory,'stop.json'),instanceId=randomUUID();
  let timer,closing=false;
  async function stop(){if(closing)return;closing=true;clearInterval(timer);await runtime.close();await assertNoLinks(instanceFile);const current=JSON.parse(await fs.readFile(instanceFile,'utf8'));if(current.instanceId===instanceId)await fs.unlink(instanceFile);try{await assertNoLinks(stopFile);await fs.unlink(stopFile);}catch(error){if(error.code!=='ENOENT')throw error;}console.log('校园打印本机服务已停止');}
  try{
    await ensureRoot(directory);await assertNoLinks(instanceFile,{missing:true});await assertNoLinks(stopFile,{missing:true});
    await fs.writeFile(instanceFile,JSON.stringify({pid:process.pid,instanceId,url:runtime.url,startedAt:new Date().toISOString()}));
    timer=setInterval(async()=>{if(closing)return;try{await assertNoLinks(stopFile);const request=JSON.parse(await fs.readFile(stopFile,'utf8'));if(request.instanceId===instanceId)await stop();}catch(error){if(error.code!=='ENOENT')console.error('本机停止请求失败：',error.code||error.name);}},1000);
    timer.unref();process.once('SIGINT',()=>stop().catch(error=>{console.error(error.message);process.exitCode=1;}));process.once('SIGTERM',()=>stop().catch(error=>{console.error(error.message);process.exitCode=1;}));
    console.log('校园打印本机服务已启动：'+runtime.url);
  }catch(error){await runtime.close();throw error;}
}
main().catch(error=>{console.error('启动失败：'+error.message);process.exitCode=1;});
