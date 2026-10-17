-- Preserve the unassigned legacy QR in print_settings.paymentAssetJson.
-- A legacy image is never silently attributed to either payment provider.
CREATE TABLE payment_channels (
 channel TEXT PRIMARY KEY CHECK(channel IN ('wechat','alipay')),
 assetJson TEXT,
 updatedAt TEXT,
 updatedBy TEXT REFERENCES users(id)
) STRICT;
INSERT INTO payment_channels(channel) VALUES('wechat'),('alipay');

ALTER TABLE order_tickets ADD COLUMN feedbackType TEXT NOT NULL DEFAULT 'other'
 CHECK(feedbackType IN ('print_quality','content_quantity','delivery','payment_refund','other'));
ALTER TABLE order_tickets ADD COLUMN contactType TEXT CHECK(contactType IN ('phone','wechat'));
ALTER TABLE order_tickets ADD COLUMN contactValue TEXT;
CREATE INDEX tickets_feedback ON order_tickets(feedbackType,createdAt,id);
CREATE TRIGGER ticket_contact_insert BEFORE INSERT ON order_tickets
 WHEN (NEW.contactType IS NULL) != (NEW.contactValue IS NULL)
 BEGIN SELECT RAISE(ABORT,'Ticket contact must contain both type and value'); END;
CREATE TRIGGER ticket_contact_update BEFORE UPDATE OF contactType,contactValue ON order_tickets
 WHEN (NEW.contactType IS NULL) != (NEW.contactValue IS NULL)
 BEGIN SELECT RAISE(ABORT,'Ticket contact must contain both type and value'); END;

CREATE TABLE advertisement_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 intervalSeconds INTEGER NOT NULL DEFAULT 5 CHECK(intervalSeconds BETWEEN 2 AND 30),
 updatedAt TEXT, updatedBy TEXT REFERENCES users(id)
) STRICT;
INSERT INTO advertisement_settings(id) VALUES(1);
CREATE TABLE advertisements (
 id TEXT PRIMARY KEY,
 assetJson TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 position INTEGER NOT NULL CHECK(position>=0),
 altText TEXT NOT NULL DEFAULT '' CHECK(length(altText)<=200),
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
) STRICT;
CREATE TRIGGER advertisements_limit BEFORE INSERT ON advertisements
 WHEN (SELECT COUNT(*) FROM advertisements)>=5
 BEGIN SELECT RAISE(ABORT,'Advertisement limit exceeded'); END;
CREATE TABLE advertisement_asset_cleanup (
 assetId TEXT PRIMARY KEY, queuedAt TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT
) STRICT;
