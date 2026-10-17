'use strict';
const path = require('node:path');
const fs = require('node:fs');
const parser = require('@apidevtools/swagger-parser');
const yaml = require('js-yaml');
async function main() {
  const root = path.resolve(__dirname, '../..');
  for (const name of ['base.yaml', 'openapi.yaml']) await parser.validate(path.join(root, 'contracts', name));
  const base = yaml.load(fs.readFileSync(path.join(root, 'contracts/base.yaml'), 'utf8'));
  const documented = Object.entries(base.paths).flatMap(([route, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} /api${route}`));
  const { isolated } = require('../../tests/helpers/runtime'); const runtime = await isolated();
  try {
    const actual = runtime.routes.filter(row => !row.path.includes('/print/')).map(row => `${row.method} ${row.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
    for (const item of documented) if (!actual.includes(item)) throw new Error(`Unimplemented documented operation: ${item}`);
    console.log(JSON.stringify({ baseVersion: base.info.version, validated: ['base.yaml', 'openapi.yaml'], matchedFoundationOperations: documented.length }));
  } finally { await runtime.destroy(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
