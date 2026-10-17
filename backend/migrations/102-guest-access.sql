ALTER TABLE users ADD COLUMN identityKind TEXT NOT NULL DEFAULT 'account'
 CHECK(identityKind IN ('account','guest') AND (identityKind='account' OR role='user'));
ALTER TABLE sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'legacy'
 CHECK(surface IN ('legacy','student','admin'));
CREATE TABLE order_query_codes (
 orderId TEXT PRIMARY KEY REFERENCES print_orders(id) ON DELETE CASCADE,
 codeHash TEXT NOT NULL UNIQUE CHECK(length(codeHash)=64),
 code TEXT NOT NULL UNIQUE CHECK(length(code)=32),
 createdAt TEXT NOT NULL
) STRICT;
CREATE TABLE order_access_grants (
 sessionHash TEXT NOT NULL REFERENCES sessions(tokenHash) ON DELETE CASCADE,
 orderId TEXT NOT NULL REFERENCES print_orders(id) ON DELETE CASCADE,
 recoveredAt TEXT NOT NULL,
 PRIMARY KEY(sessionHash,orderId)
) STRICT;
CREATE INDEX grants_order ON order_access_grants(orderId,sessionHash);
