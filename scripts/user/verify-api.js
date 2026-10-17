'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const project=path.resolve(__dirname,'../..'),output=path.join(project,'tests/user/evidence');
fs.mkdirSync(output,{recursive:true});const stream=fs.createWriteStream(path.join(output,'api-tests.txt'));
const child=spawn(process.execPath,['--test','--test-concurrency=1','tests/user/api.test.js'],{cwd:project,stdio:['ignore','pipe','pipe']});
for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{stream.write(chunk);process.stdout.write(chunk);});
child.on('exit',code=>{stream.end();process.exitCode=code??1;});child.on('error',error=>{console.error(error);stream.end();process.exitCode=1;});
