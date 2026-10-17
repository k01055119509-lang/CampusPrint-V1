'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'../..');
async function main(){
  const output=path.resolve(process.argv[2]),db=new DatabaseSync(path.join(ROOT,'var/db/campus-print.sqlite'),{readOnly:true}),old=new DatabaseSync(path.join(ROOT,'var/managed-backups/a80af315-f116-4b6d-b19c-d84dab311178/database.sqlite'),{readOnly:true});let report;
  try{
    const accountChanges=[];for(const prior of old.prepare('SELECT * FROM users').all()){const current=db.prepare('SELECT * FROM users WHERE id=?').get(prior.id);accountChanges.push({role:prior.role,exists:!!current,changedColumns:current?Object.keys(prior).filter(key=>prior[key]!==current[key]):[]});}
    report={at:new Date().toISOString(),readOnly:true,migrations:db.prepare('SELECT version,appliedAt FROM schema_migrations ORDER BY version').all(),accounts:{before:old.prepare('SELECT count(*) n FROM users').get().n,now:db.prepare('SELECT count(*) n FROM users').get().n,changes:accountChanges},sessions:{before:old.prepare('SELECT count(*) n FROM sessions').get().n,now:db.prepare('SELECT count(*) n FROM sessions').get().n},cleanup:db.prepare('SELECT startedAt,finishedAt FROM file_cleanup_runs ORDER BY startedAt DESC LIMIT 3').all()};
  }finally{db.close();old.close();}
  try{const instance=JSON.parse(await fs.readFile(path.join(ROOT,'var/desktop-control/instance.json'),'utf8'));let live=true;try{process.kill(instance.pid,0);}catch{live=false;}report.instance={pid:instance.pid,url:instance.url,startedAt:instance.startedAt,pidExists:live};}catch{report.instance=null;}
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'formal-drift.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
