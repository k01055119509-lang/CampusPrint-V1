CREATE TABLE coupon_batches (
 id TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 rulesJson TEXT NOT NULL CHECK(json_valid(rulesJson)), createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL,
 createdBy TEXT NOT NULL REFERENCES users(id)
) STRICT;
CREATE TABLE coupons (
 id TEXT PRIMARY KEY, batchId TEXT NOT NULL REFERENCES coupon_batches(id),
 codeHash TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE CHECK(length(code)=25 AND code NOT GLOB '*[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*'),
 type TEXT NOT NULL CHECK(type IN ('discount','threshold')),
 minPrintAmountFen INTEGER NOT NULL CHECK(minPrintAmountFen BETWEEN 0 AND 100000000),
 payRatePercent INTEGER CHECK(payRatePercent BETWEEN 1 AND 99),
 maxDiscountFen INTEGER CHECK(maxDiscountFen BETWEEN 1 AND 100000000),
 reductionFen INTEGER CHECK(reductionFen BETWEEN 1 AND 100000000),
 state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','redeemed')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL CHECK(expiresAt>createdAt),
 disabledAt TEXT, reservedOrderId TEXT UNIQUE REFERENCES print_orders(id), redeemedAt TEXT,
 createdBy TEXT NOT NULL REFERENCES users(id),
 CHECK((type='discount' AND payRatePercent IS NOT NULL AND reductionFen IS NULL) OR
       (type='threshold' AND payRatePercent IS NULL AND maxDiscountFen IS NULL AND minPrintAmountFen>0 AND reductionFen IS NOT NULL AND reductionFen<minPrintAmountFen)),
 CHECK((state='available' AND reservedOrderId IS NULL AND redeemedAt IS NULL) OR
       (state='reserved' AND reservedOrderId IS NOT NULL AND redeemedAt IS NULL) OR
       (state='redeemed' AND reservedOrderId IS NOT NULL AND redeemedAt IS NOT NULL))
) STRICT;
CREATE INDEX coupons_filter ON coupons(state,type,batchId,createdAt,id);
CREATE INDEX coupons_reserved_expiry ON coupons(expiresAt) WHERE state='reserved';
CREATE TRIGGER coupon_rule_immutable BEFORE UPDATE ON coupons WHEN
 NEW.id IS NOT OLD.id OR NEW.batchId IS NOT OLD.batchId OR NEW.code IS NOT OLD.code OR NEW.codeHash IS NOT OLD.codeHash OR
 NEW.type IS NOT OLD.type OR NEW.minPrintAmountFen IS NOT OLD.minPrintAmountFen OR NEW.payRatePercent IS NOT OLD.payRatePercent OR
 NEW.maxDiscountFen IS NOT OLD.maxDiscountFen OR NEW.reductionFen IS NOT OLD.reductionFen OR
 NEW.createdAt IS NOT OLD.createdAt OR NEW.expiresAt IS NOT OLD.expiresAt OR NEW.createdBy IS NOT OLD.createdBy
 BEGIN SELECT RAISE(ABORT,'COUPON_RULE_IMMUTABLE'); END;
CREATE TRIGGER coupon_redemption_immutable BEFORE UPDATE ON coupons WHEN OLD.state='redeemed' AND
 (NEW.state IS NOT OLD.state OR NEW.reservedOrderId IS NOT OLD.reservedOrderId OR NEW.redeemedAt IS NOT OLD.redeemedAt)
 BEGIN SELECT RAISE(ABORT,'COUPON_REDEMPTION_IMMUTABLE'); END;
CREATE TRIGGER coupon_disable_immutable BEFORE UPDATE ON coupons WHEN OLD.disabledAt IS NOT NULL AND NEW.disabledAt IS NOT OLD.disabledAt
 BEGIN SELECT RAISE(ABORT,'COUPON_DISABLE_IMMUTABLE'); END;
CREATE TABLE coupon_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, couponId TEXT NOT NULL REFERENCES coupons(id),
 orderId TEXT REFERENCES print_orders(id), actorId TEXT REFERENCES users(id), type TEXT NOT NULL,
 createdAt TEXT NOT NULL, dataJson TEXT NOT NULL CHECK(json_valid(dataJson))
) STRICT;
ALTER TABLE print_quotes ADD COLUMN couponSnapshotJson TEXT CHECK(couponSnapshotJson IS NULL OR json_valid(couponSnapshotJson));
ALTER TABLE print_orders ADD COLUMN couponSnapshotJson TEXT CHECK(couponSnapshotJson IS NULL OR json_valid(couponSnapshotJson));
CREATE TRIGGER order_coupon_snapshot_immutable BEFORE UPDATE ON print_orders WHEN NEW.couponSnapshotJson IS NOT OLD.couponSnapshotJson
 BEGIN SELECT RAISE(ABORT,'ORDER_COUPON_SNAPSHOT_IMMUTABLE'); END;
CREATE TABLE order_coupon_exceptions (
 orderId TEXT PRIMARY KEY REFERENCES print_orders(id), couponId TEXT NOT NULL REFERENCES coupons(id),
 hold INTEGER NOT NULL CHECK(hold IN (0,1)), reasonsJson TEXT NOT NULL CHECK(json_valid(reasonsJson)),
 acceptedReasonsJson TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(acceptedReasonsJson)),
 detectedAt TEXT NOT NULL, resolution TEXT CHECK(resolution IN ('continue','cancel')), resolvedAt TEXT,
 resolvedBy TEXT REFERENCES users(id), resolutionNote TEXT,
 CHECK((resolution IS NULL AND resolvedAt IS NULL AND resolvedBy IS NULL) OR (resolution IS NOT NULL AND resolvedAt IS NOT NULL AND resolvedBy IS NOT NULL))
) STRICT;
CREATE TABLE coupon_exception_history (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, orderId TEXT NOT NULL REFERENCES print_orders(id),
 type TEXT NOT NULL CHECK(type IN ('detected','continue','cancel')), reasonsJson TEXT NOT NULL CHECK(json_valid(reasonsJson)),
 createdAt TEXT NOT NULL, actorId TEXT REFERENCES users(id), note TEXT NOT NULL
) STRICT;
