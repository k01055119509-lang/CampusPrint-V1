'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { hashPassword, hashToken } = require('../../backend/auth');
const { configAt, PROJECT, TEST_PASSWORD } = require('./runtime');
// Build the real pre-102 schema, including migration checksums, without starting new application code.
async function legacyFixture(root, { clock = () => new Date() } = {}) {
  const config = configAt(root); await fs.mkdir(path.dirname(config.dbPath), { recursive: true });
  const passwordHash = await hashPassword(TEST_PASSWORD), db = new DatabaseSync(config.dbPath);
  const createdAt = new Date(clock().getTime() - 3600000).toISOString(), expiresAt = new Date(clock().getTime() + 86400000).toISOString();
  const users = {}, sessions = {}, orderId = randomUUID(), quoteId = randomUUID(), itemId = randomUUID(), fileId = randomUUID();
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,appliedAt TEXT NOT NULL) STRICT');
    for (const name of ['001-foundation.sql','002-files.sql','003-retention-claims.sql','100-orders.sql','101-account-security.sql']) {
      const sql = await fs.readFile(path.join(PROJECT, 'backend/migrations', name), 'utf8'); db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name, createHash('sha256').update(sql).digest('hex'), createdAt);
    }
    for (const [kind,role] of [['student','user'],['admin','admin']]) {
      const id = randomUUID(), username = 'legacy_' + kind;
      db.prepare('INSERT INTO users(id,username,nickname,passwordHash,role,createdAt) VALUES(?,?,?,?,?,?)').run(id, username, '旧版测试身份', passwordHash, role, createdAt);
      users[kind] = { id, username, role };
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions(tokenHash,userId,csrfToken,createdAt,expiresAt,lastSeen) VALUES(?,?,?,?,?,?)').run(hashToken(token), id, csrf, createdAt, expiresAt, createdAt);
      sessions[kind] = { token, csrf, tokenHash: hashToken(token), expiresAt };
    }
    const totals = { contentPages:52,sheetCount:26,unitSheetPriceFen:50,printAmountFen:1300,deliveryFeeFen:0,totalAmountFen:1300,currency:'CNY' };
    const items = [{ itemId, fileId, originalName:'legacy-fixture.pdf', sourceSha256:'a'.repeat(64), sourcePageCount:52, pageNumbers:Array.from({length:52},(_,i)=>i+1), selectedPageCount:52,copies:1,duplex:true,contentPages:52,sheetCount:26,amountFen:1300,paperSize:'A4',colorMode:'black_white',copiesInPdf:1,printArtifactId:randomUUID(),printArtifactSha256:'b'.repeat(64) }];
    const address = { buildingId:'local-dorm',buildingLabel:'本栋宿舍',room:'legacy-test',contact:'',notes:'' };
    db.prepare("INSERT INTO print_quotes(id,userId,status,itemsJson,totalsJson,createdAt,preparationDeadline,readyAt,expiresAt,fingerprint,claimedOrderId) VALUES(?,?,'ready',?,?,?,?,?,?,?,?)").run(quoteId,users.student.id,JSON.stringify(items),JSON.stringify(totals),createdAt,expiresAt,createdAt,expiresAt,'c'.repeat(64),orderId);
    db.prepare('INSERT INTO print_orders(id,orderNo,userId,quoteId,createdAt,updatedAt,itemsJson,totalsJson,addressJson,totalAmountFen,contentPages,sheetCount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(orderId,'CP-LEGACY-TEST',users.student.id,quoteId,createdAt,createdAt,JSON.stringify(items),JSON.stringify(totals),JSON.stringify(address),1300,52,26);
    return { config, users, sessions, orderId, quoteId, totals, itemsJson:JSON.stringify(items),totalsJson:JSON.stringify(totals),addressJson:JSON.stringify(address),createdAt };
  } finally { db.close(); }
}
module.exports = { legacyFixture };
