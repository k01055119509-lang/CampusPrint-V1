'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startServer } = require('../../backend/server');
const { removeTree } = require('../../backend/files/safety');
const { configAt, PROJECT, Client, TEST_PASSWORD } = require('../helpers/runtime');
const h = require('../business/helpers');
const ROOT = path.join(__dirname,'.runtime');
const EVIDENCE = process.env.CP_VERIFICATION_DIR ? path.join(path.resolve(process.env.CP_VERIFICATION_DIR),'student') : path.join(PROJECT,'docs/verification/guest-pricing-coupons-v1.1.0/C/local-ui/student');
async function isolated(overrides = {}) {
  const name=randomUUID(),root=path.join(ROOT,name);await fs.mkdir(root,{recursive:true});
  const runtime=await startServer(configAt(root,overrides));
  return {...runtime,root,async destroy(){await runtime.close();await removeTree(ROOT,name);}};
}
module.exports = { isolated, EVIDENCE, PROJECT, Client, TEST_PASSWORD, h };
