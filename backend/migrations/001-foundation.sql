CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
 passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')),
 createdAt TEXT NOT NULL, lastLoginAt TEXT, lastActiveAt TEXT
) STRICT;
CREATE TABLE sessions (
 tokenHash TEXT PRIMARY KEY, userId TEXT REFERENCES users(id) ON DELETE CASCADE,
 csrfToken TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL,
 lastSeen TEXT NOT NULL, lastInteractionAt TEXT
) STRICT;
CREATE INDEX sessions_user ON sessions(userId,expiresAt);
CREATE TABLE rate_limits (bucketKey TEXT PRIMARY KEY,count INTEGER NOT NULL,resetAt TEXT NOT NULL) STRICT;
CREATE TABLE activity_days (userId TEXT NOT NULL REFERENCES users(id),day TEXT NOT NULL,PRIMARY KEY(userId,day)) STRICT;
CREATE TABLE activity_months (userId TEXT NOT NULL REFERENCES users(id),month TEXT NOT NULL,PRIMARY KEY(userId,month)) STRICT;
CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),message TEXT NOT NULL DEFAULT '',updatedAt TEXT) STRICT;
INSERT INTO maintenance(id) VALUES(1);
