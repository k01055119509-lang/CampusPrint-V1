'use strict';
const readline=require('node:readline');
const { Writable }=require('node:stream');
const { loadConfig }=require('../../backend/config');
const { openDatabase }=require('../../backend/db');
const { createAdmin }=require('../../backend/auth');
async function main() {
  // No password in arguments or source. Interactive input is hidden; automation may use process environment.
  const args=process.argv.slice(2);let username=process.env.CP_ADMIN_USERNAME,password=process.env.CP_ADMIN_PASSWORD;
  if(args.length){if(args.length!==2||args[0]!=='--username')throw new Error('仅支持 --username 参数；密码请使用隐藏输入或 CP_ADMIN_PASSWORD 环境变量');username=args[1];}
  delete process.env.CP_ADMIN_PASSWORD;
  if(!username||!password){
    if(!process.stdin.isTTY)throw new Error('非交互初始化需要 CP_ADMIN_USERNAME / CP_ADMIN_PASSWORD 环境变量');
    let muted=false;
    const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
    const rl=readline.createInterface({input:process.stdin,output,terminal:true});
    const ask=(label,secret=false)=>new Promise(resolve=>{process.stdout.write(label);muted=secret;rl.question('',answer=>{muted=false;if(secret)process.stdout.write('\n');resolve(answer);});});
    try {username=username||await ask('管理员用户名：');password=password||await ask('管理员密码（6–12 位英文字母和数字，须同时包含两者，输入隐藏）：',true);
      const confirm=await ask('重复密码：',true);if(password!==confirm)throw new Error('两次密码不一致');}
    finally{rl.close();}
  }
  const config=loadConfig(),db=openDatabase(config.dbPath);
  try{const admin=await createAdmin(db,config,{username,password});console.log(`管理员已创建：${admin.username}。请使用 /admin/ 的独立登录入口。`);}
  finally{password=undefined;db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

