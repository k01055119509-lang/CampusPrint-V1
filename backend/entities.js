'use strict';
function user(row, activity) {
  return { id: row.id, username: row.identityKind === 'guest' ? null : row.username, nickname: row.nickname, role: row.role, identityKind: row.identityKind,
    createdAt: row.createdAt, lastLoginAt: row.lastLoginAt, lastActiveAt: row.lastActiveAt,
    online: activity ? activity.online(row.id) : undefined };
}
module.exports = { user };
