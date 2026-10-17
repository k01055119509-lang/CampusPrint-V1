'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
function openDatabase(file) {
  if (file !== ':memory:') {
    const absolute = path.resolve(file), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    let current = path.parse(absolute).root;
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Database path must not use links');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const raw = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  let depth = 0, afterCommit = [];
  const db = { raw,
    get: (sql, ...args) => raw.prepare(sql).get(...args),
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    get inTransaction() { return depth > 0; },
    afterCommit(fn) { if (depth) afterCommit.push(fn); else fn(); },
    tx(fn) {
      const nested = depth > 0, savepoint = `nested_${depth}`, callbacksStart = afterCommit.length;
      raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'); depth++;
      let result;
      try {
        result = fn(); if (result?.then) throw new Error('Transactions must be synchronous; perform rendering outside db.tx');
        raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      } catch (error) {
        raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        afterCommit.length = callbacksStart; throw error;
      } finally { depth--; }
      if (!nested) { const callbacks = afterCommit; afterCommit = []; for (const callback of callbacks) callback(); }
      return result;
    }, close: () => raw.close()
  };
  try {
    raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, appliedAt TEXT NOT NULL) STRICT');
    const dir = path.join(__dirname, 'migrations');
    for (const name of fs.readdirSync(dir).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8'), checksum = createHash('sha256').update(sql).digest('hex');
      db.tx(() => {
        const done = db.get('SELECT checksum FROM schema_migrations WHERE version=?', name);
        if (done) { if (done.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`); return; }
        raw.exec(sql); db.run('INSERT INTO schema_migrations VALUES(?,?,?)', name, checksum, new Date().toISOString());
      });
    }
    return db;
  } catch (error) { raw.close(); throw error; }
}
module.exports = { openDatabase };
