CREATE TABLE files (
 id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id), originalName TEXT NOT NULL,
 mimeType TEXT NOT NULL, byteSize INTEGER NOT NULL CHECK(byteSize>0), sourceSha256 TEXT NOT NULL,
 sourcePageCount INTEGER, status TEXT NOT NULL CHECK(status IN ('processing','ready','failed','expired')),
 errorCode TEXT, errorMessage TEXT, claimedOrderId TEXT, expiresAt TEXT,
 uploadedAt TEXT NOT NULL, temporaryExpiresAt TEXT NOT NULL,
 purgedAt TEXT, purgeAttempts INTEGER NOT NULL DEFAULT 0, purgeErrorCode TEXT
) STRICT;
CREATE INDEX files_due ON files(expiresAt,status);
CREATE INDEX files_owner ON files(ownerId,uploadedAt);
CREATE INDEX files_order ON files(claimedOrderId);
CREATE TABLE preparations (
 preparationId TEXT PRIMARY KEY, fileId TEXT NOT NULL REFERENCES files(id), ownerId TEXT NOT NULL REFERENCES users(id),
 pageNumbersJson TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('processing','ready','failed','expired')),
 artifactId TEXT, errorCode TEXT,errorMessage TEXT, createdAt TEXT NOT NULL
) STRICT;
CREATE TABLE artifacts (
 artifactId TEXT PRIMARY KEY,fileId TEXT NOT NULL REFERENCES files(id),preparationId TEXT REFERENCES preparations(preparationId),
 kind TEXT NOT NULL CHECK(kind IN ('original','production','source_preview','production_preview','normalized')),
 relativePath TEXT NOT NULL UNIQUE,mimeType TEXT NOT NULL,pageCount INTEGER NOT NULL,
 sha256 TEXT NOT NULL,byteSize INTEGER NOT NULL,paperSize TEXT,colorMode TEXT,copiesInPdf INTEGER,
 sourcePage INTEGER,productionPage INTEGER,createdAt TEXT NOT NULL,
 claimedOrderId TEXT,expiresAt TEXT,UNIQUE(fileId,kind,preparationId,sourcePage,productionPage)
) STRICT;
CREATE INDEX artifacts_file ON artifacts(fileId);
CREATE TABLE file_jobs (
 id TEXT PRIMARY KEY,fileId TEXT REFERENCES files(id),type TEXT NOT NULL,requestKey TEXT UNIQUE,
 argsJson TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,errorCode TEXT,errorMessage TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
) STRICT;
CREATE INDEX file_jobs_pending ON file_jobs(status,createdAt);
CREATE TABLE file_leases (
 leaseId TEXT PRIMARY KEY,fileId TEXT NOT NULL REFERENCES files(id),kind TEXT NOT NULL,expiresAt TEXT NOT NULL
) STRICT;
CREATE INDEX file_leases_file ON file_leases(fileId,expiresAt);
CREATE TABLE file_retention_outbox (
 eventId TEXT PRIMARY KEY,kind TEXT NOT NULL,fileId TEXT NOT NULL,expiresAt TEXT,recordedAt TEXT NOT NULL
) STRICT;
CREATE TABLE file_cleanup_runs (
 id TEXT PRIMARY KEY,startedAt TEXT NOT NULL,finishedAt TEXT,examined INTEGER NOT NULL DEFAULT 0,
 purged INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,deferred INTEGER NOT NULL DEFAULT 0
) STRICT;
