'use strict';
// Opt-in observation only; keeps the original result and error for every call.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
if(process.env.CP_STORAGE_TRACE){
  const trace=path.resolve(process.env.CP_STORAGE_TRACE),testRoot=path.resolve(__dirname,'../../tmp/tests');
  for(const operation of ['open','copyFile','rename','unlink','rm','mkdir','writeFile','readFile']){
    const original=fsp[operation];
    fsp[operation]=async function(...args){try{return await original.apply(this,args);}catch(error){
      if(['EBUSY','EPERM','EACCES'].includes(error.code)&&typeof args[0]==='string'&&path.resolve(args[0]).startsWith(testRoot+path.sep)){
        fs.appendFileSync(trace,JSON.stringify({at:new Date().toISOString(),operation,code:error.code,syscall:error.syscall,path:path.relative(testRoot,String(error.path||args[0])),destination:error.dest?path.relative(testRoot,error.dest):undefined,stack:error.stack})+'\n');
      }throw error;
    }};
  }
}
