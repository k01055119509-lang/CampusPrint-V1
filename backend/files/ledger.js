'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { UUID } = require('./safety');
function validTime(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
class RetentionLedger {
  constructor(root, db) { this.file = path.join(root, 'retention.jsonl'); this.db = db; this.facts = new Map(); this.events = new Set(); this.failure = null; }
  accept(event) {
    if (!UUID.test(event.eventId || '') || !UUID.test(event.fileId || '') || !['claim', 'expiry', 'revoked', 'purged'].includes(event.kind) || !validTime(event.recordedAt) || (event.kind === 'expiry' && !validTime(event.expiresAt)) || (event.kind === 'claim' && (typeof event.orderId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(event.orderId)))) throw new Error('Retention ledger is invalid; refuse file access');
    this.events.add(event.eventId);
    const previous = this.facts.get(event.fileId) || { orderId: null, expiresAt: null, revoked: false, purged: false };
    if (event.kind === 'claim') {
      if (previous.orderId && previous.orderId !== event.orderId) throw new Error('Retention ledger claim conflict; refuse file access');
      previous.orderId = event.orderId;
    }
    if (event.kind === 'expiry' && (!previous.expiresAt || event.expiresAt < previous.expiresAt)) previous.expiresAt = event.expiresAt;
    if (event.kind === 'revoked' || event.kind === 'purged') previous.revoked = true;
    if (event.kind === 'purged') previous.purged = true;
    this.facts.set(event.fileId, previous);
  }
  checkPath() {
    const absolute = path.resolve(this.file), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    let current = path.parse(absolute).root;
    for (const part of parts) {
      current = path.join(current, part); let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Unsafe retention ledger path');
    }
  }
  load() {
    this.checkPath();
    if (fs.existsSync(this.file)) {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Unsafe retention ledger');
      const content = fs.readFileSync(this.file, 'utf8');
      for (const line of content.split('\n')) if (line.trim()) this.accept(JSON.parse(line));
    }
    this.flush();
  }
  flush() {
    try {
      this.checkPath();
      for (const event of this.db.all('SELECT * FROM file_retention_outbox ORDER BY recordedAt,eventId')) {
        if (!this.events.has(event.eventId)) {
          if (fs.existsSync(this.file)) {
            const stat = fs.lstatSync(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Unsafe retention ledger');
          }
          const descriptor = fs.openSync(this.file, 'a', 0o600);
          try { fs.writeSync(descriptor, JSON.stringify(event) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
          this.accept(event);
        }
        this.db.run('DELETE FROM file_retention_outbox WHERE eventId=?', event.eventId);
      }
      this.failure = null;
    } catch (error) { this.failure = 'FILE_LEDGER_UNAVAILABLE'; throw error; }
  }
  replay(now) {
    this.db.tx(() => {
      for (const [fileId, fact] of this.facts) {
        if (fact.orderId) {
          this.db.run('UPDATE files SET claimedOrderId=?,expiresAt=CASE WHEN expiresAt=temporaryExpiresAt THEN NULL ELSE expiresAt END WHERE id=?', fact.orderId, fileId);
          this.db.run('UPDATE artifacts SET claimedOrderId=?,expiresAt=(SELECT expiresAt FROM files WHERE id=?) WHERE fileId=?', fact.orderId, fileId, fileId);
        }
        if (fact.expiresAt) {
          this.db.run('UPDATE files SET expiresAt=CASE WHEN expiresAt IS NULL OR expiresAt>? THEN ? ELSE expiresAt END WHERE id=?', fact.expiresAt, fact.expiresAt, fileId);
          this.db.run('UPDATE artifacts SET expiresAt=CASE WHEN expiresAt IS NULL OR expiresAt>? THEN ? ELSE expiresAt END WHERE fileId=?', fact.expiresAt, fact.expiresAt, fileId);
        }
        if (fact.revoked || (fact.expiresAt && fact.expiresAt <= now)) {
          this.db.run("UPDATE files SET status='expired',expiresAt=COALESCE(expiresAt,?) WHERE id=?", now, fileId);
          this.db.run("UPDATE preparations SET status='expired' WHERE fileId=?", fileId);
        }
      }
    });
  }
}
module.exports = { RetentionLedger, validTime };
