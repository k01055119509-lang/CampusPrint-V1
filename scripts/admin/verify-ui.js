'use strict';
const { spawnSync }=require('node:child_process');
const path=require('node:path');
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','tests/admin/browser.test.js'],{cwd:path.resolve(__dirname,'../..'),stdio:'inherit'});
process.exitCode=result.status??1;
