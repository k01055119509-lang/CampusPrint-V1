'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {ROOT,inside}=require('../../backend/config');
const {removeTree,UUID}=require('../../backend/files/safety');
(async()=>{const report=JSON.parse(await fs.readFile(process.argv[2],'utf8')),directory=path.resolve(report.extractedDirectory),testRoot=path.join(ROOT,'tmp/tests'),relative=path.relative(testRoot,directory),name=relative.split(path.sep)[0],root=path.resolve(testRoot,name);if(!inside(testRoot,directory)||!UUID.test(name)||path.dirname(root)!==testRoot)throw Error('Refuse cleanup outside a UUID isolated test root');await removeTree(testRoot,name);})().catch(error=>{console.error(error);process.exitCode=1;});
