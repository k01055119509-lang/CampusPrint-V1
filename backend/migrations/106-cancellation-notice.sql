-- New defaults only; preserve all pre-existing money, text, events and deadlines.
ALTER TABLE print_defaults ADD COLUMN receiptMethod TEXT CHECK(receiptMethod IS NULL OR receiptMethod IN ('handover','contact_first','doorstep','other'));
ALTER TABLE print_defaults ADD COLUMN receiptNote TEXT NOT NULL DEFAULT '' CHECK(length(receiptNote)<=500);
ALTER TABLE print_orders ADD COLUMN hiddenFromMerchant INTEGER NOT NULL DEFAULT 0 CHECK(hiddenFromMerchant IN (0,1) AND (hiddenFromMerchant=0 OR lifecycle='cancelled'));
ALTER TABLE cancellation_requests ADD COLUMN origin TEXT CHECK(origin IS NULL OR origin IN ('user','merchant','legacy'));
UPDATE cancellation_requests SET origin=CASE
 WHEN createdBy=(SELECT userId FROM print_orders WHERE id=orderId) AND (SELECT role FROM users WHERE id=createdBy)='user' THEN 'user'
 WHEN (SELECT role FROM users WHERE id=createdBy)='admin' THEN 'merchant'
 ELSE 'legacy' END;
CREATE TRIGGER cancellation_origin_immutable BEFORE UPDATE ON cancellation_requests
 WHEN NEW.origin IS NOT OLD.origin OR NEW.createdBy IS NOT OLD.createdBy OR NEW.orderId IS NOT OLD.orderId
 BEGIN SELECT RAISE(ABORT,'CANCELLATION_ORIGIN_IMMUTABLE'); END;
CREATE TRIGGER merchant_hidden_immutable BEFORE UPDATE ON print_orders
 WHEN OLD.hiddenFromMerchant=1 AND NEW.hiddenFromMerchant!=1
 BEGIN SELECT RAISE(ABORT,'MERCHANT_HIDDEN_IMMUTABLE'); END;
CREATE INDEX orders_merchant_visibility ON print_orders(hiddenFromMerchant,createdAt,id);
CREATE TABLE announcement_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), content TEXT NOT NULL DEFAULT '' CHECK(length(content)<=1000),
 updatedAt TEXT, updatedBy TEXT REFERENCES users(id), CHECK(enabled=0 OR length(trim(content))>0)
) STRICT;
INSERT INTO announcement_settings(id) VALUES(1);
CREATE TABLE order_compensations (
 orderId TEXT PRIMARY KEY REFERENCES print_orders(id), couponId TEXT NOT NULL UNIQUE REFERENCES coupons(id),
 policyId TEXT NOT NULL CHECK(policyId='merchant_cancellation_v1'), type TEXT NOT NULL CHECK(type='discount'),
 payRatePercent INTEGER NOT NULL CHECK(payRatePercent=90), minPrintAmountFen INTEGER NOT NULL CHECK(minPrintAmountFen=0),
 maxDiscountFen INTEGER NOT NULL CHECK(maxDiscountFen=200), validDays INTEGER NOT NULL CHECK(validDays=30),
 issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL CHECK(expiresAt>issuedAt), issuedBy TEXT NOT NULL REFERENCES users(id)
) STRICT;
CREATE TRIGGER compensation_snapshot_immutable BEFORE UPDATE ON order_compensations
 BEGIN SELECT RAISE(ABORT,'COMPENSATION_SNAPSHOT_IMMUTABLE'); END;
