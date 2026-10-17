'use strict';
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { assertNoLinks } = require('./files/safety');
async function acquireRuntimeLock(dbPath) {
  const directory = path.dirname(dbPath), target = path.join(directory, 'campus-print.runtime.lock'), token = randomUUID();
  await assertNoLinks(directory, { missing: true }); await fs.mkdir(directory, { recursive: true }); await assertNoLinks(target, { missing: true });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = await fs.open(target, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const previous = JSON.parse(await fs.readFile(target, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid runtime lock; stop service and inspect it');
      try { process.kill(previous.pid, 0); throw new Error('This database is already owned by a running CampusPrint service'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await assertNoLinks(target); await fs.unlink(target);
    }
  }
  try { await descriptor.writeFile(JSON.stringify({ pid: process.pid, token })); await descriptor.sync(); } finally { await descriptor.close(); }
  return async () => {
    await assertNoLinks(target); const current = JSON.parse(await fs.readFile(target, 'utf8'));
    if (current.token === token) await fs.unlink(target);
  };
}
module.exports = { acquireRuntimeLock };
