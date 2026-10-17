'use strict';
const { LIMITS } = require('./config');
const shanghaiKeys = date => {
  const local = new Date(date.getTime() + 8 * 3600000).toISOString();
  return { day: local.slice(0, 10), month: local.slice(0, 7) };
};
function createActivity(db, config) {
  function record(req) {
    if (!req.user || !req.session) return;
    const time = config.clock().toISOString();
    if (Date.parse(time) - Date.parse(req.session.lastSeen) < LIMITS.activityThrottleMs && req.user.lastActiveAt) return;
    const { day, month } = shanghaiKeys(config.clock());
    db.run('UPDATE sessions SET lastSeen=? WHERE tokenHash=?', time, req.session.tokenHash);
    db.run('UPDATE users SET lastActiveAt=? WHERE id=?', time, req.user.id);
    if (req.user.role === 'user') {
      db.run('INSERT OR IGNORE INTO activity_days VALUES(?,?)', req.user.id, day);
      db.run('INSERT OR IGNORE INTO activity_months VALUES(?,?)', req.user.id, month);
    }
  }
  function online(userId) {
    const time = config.clock().toISOString(), cutoff = new Date(config.clock().getTime() - 300000).toISOString();
    return !!db.get('SELECT 1 FROM sessions WHERE userId=? AND expiresAt>? AND lastSeen>=? LIMIT 1', userId, time, cutoff);
  }
  return { record, online };
}
module.exports = { createActivity, shanghaiKeys };
