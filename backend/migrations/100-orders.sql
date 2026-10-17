CREATE TABLE print_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
 buildingLabel TEXT NOT NULL DEFAULT '本栋宿舍', acceptingOrders INTEGER NOT NULL DEFAULT 1 CHECK(acceptingOrders IN (0,1)),
 serviceNotice TEXT NOT NULL DEFAULT '', paymentInstructions TEXT NOT NULL DEFAULT '', paymentAssetJson TEXT,
 updatedAt TEXT, updatedBy TEXT REFERENCES users(id)
) STRICT;
INSERT INTO print_settings(id) VALUES(1);
CREATE TABLE print_defaults (userId TEXT PRIMARY KEY REFERENCES users(id), room TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', copies INTEGER NOT NULL DEFAULT 1 CHECK(copies BETWEEN 1 AND 99), duplex INTEGER NOT NULL DEFAULT 0 CHECK(duplex IN (0,1)), updatedAt TEXT) STRICT;
CREATE TABLE print_quotes (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
 itemsJson TEXT NOT NULL CHECK(json_valid(itemsJson)), totalsJson TEXT NOT NULL CHECK(json_valid(totalsJson)),
 createdAt TEXT NOT NULL, preparationDeadline TEXT NOT NULL, readyAt TEXT, expiresAt TEXT, fingerprint TEXT,
 errorJson TEXT CHECK(errorJson IS NULL OR json_valid(errorJson)), claimedOrderId TEXT UNIQUE
) STRICT;
CREATE INDEX quotes_owner ON print_quotes(userId,createdAt,id);
CREATE TABLE print_orders (
 id TEXT PRIMARY KEY, orderNo TEXT NOT NULL UNIQUE, userId TEXT NOT NULL REFERENCES users(id), quoteId TEXT NOT NULL UNIQUE REFERENCES print_quotes(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 itemsJson TEXT NOT NULL CHECK(json_valid(itemsJson)), totalsJson TEXT NOT NULL CHECK(json_valid(totalsJson)), addressJson TEXT NOT NULL CHECK(json_valid(addressJson)),
 totalAmountFen INTEGER NOT NULL CHECK(totalAmountFen>0), contentPages INTEGER NOT NULL CHECK(contentPages BETWEEN 1 AND 99), sheetCount INTEGER NOT NULL CHECK(sheetCount BETWEEN 1 AND 99),
 paymentStatus TEXT NOT NULL DEFAULT 'unpaid' CHECK(paymentStatus IN ('unpaid','submitted','confirmed','rejected')),
 productionStatus TEXT NOT NULL DEFAULT 'not_started' CHECK(productionStatus IN ('not_started','printing','printed','failed')),
 productionProgress INTEGER NOT NULL DEFAULT 0 CHECK(productionProgress>=0), productionAttempt INTEGER NOT NULL DEFAULT 0, reprintActive INTEGER NOT NULL DEFAULT 0 CHECK(reprintActive IN (0,1)),
 deliveryStatus TEXT NOT NULL DEFAULT 'pending' CHECK(deliveryStatus IN ('pending','delivering','delivered','failed')),
 lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','cancel_requested','completed','cancelled')),
 financialHold INTEGER NOT NULL DEFAULT 0 CHECK(financialHold IN (0,1)), fulfillmentHold INTEGER NOT NULL DEFAULT 0 CHECK(fulfillmentHold IN (0,1)),
 completedAt TEXT, filesExpireAt TEXT,
 CHECK((completedAt IS NULL AND filesExpireAt IS NULL) OR (completedAt IS NOT NULL AND filesExpireAt IS NOT NULL))
) STRICT;
CREATE INDEX orders_owner ON print_orders(userId,createdAt,id);
CREATE INDEX orders_queue ON print_orders(lifecycle,paymentStatus,productionStatus,deliveryStatus);
CREATE TRIGGER order_completion_immutable BEFORE UPDATE ON print_orders WHEN OLD.completedAt IS NOT NULL AND (NEW.completedAt IS NOT OLD.completedAt OR NEW.filesExpireAt IS NOT OLD.filesExpireAt) BEGIN SELECT RAISE(ABORT,'ORDER_COMPLETION_IMMUTABLE'); END;
CREATE TRIGGER order_snapshot_immutable BEFORE UPDATE ON print_orders WHEN NEW.itemsJson!=OLD.itemsJson OR NEW.totalsJson!=OLD.totalsJson OR NEW.addressJson!=OLD.addressJson OR NEW.totalAmountFen!=OLD.totalAmountFen OR NEW.quoteId!=OLD.quoteId BEGIN SELECT RAISE(ABORT,'ORDER_SNAPSHOT_IMMUTABLE'); END;
CREATE TABLE order_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, orderId TEXT NOT NULL REFERENCES print_orders(id),
 actorId TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, createdAt TEXT NOT NULL, dataJson TEXT NOT NULL CHECK(json_valid(dataJson))
) STRICT;
CREATE INDEX events_order ON order_events(orderId,seq);
CREATE TABLE payment_submissions (id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES print_orders(id), channel TEXT NOT NULL, reference TEXT NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL, submittedBy TEXT NOT NULL REFERENCES users(id)) STRICT;
CREATE TABLE payment_receipts (id TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE REFERENCES print_orders(id), amountFen INTEGER NOT NULL CHECK(amountFen>0), channel TEXT NOT NULL, reference TEXT NOT NULL, referenceKey TEXT NOT NULL UNIQUE, confirmedAt TEXT NOT NULL, confirmedBy TEXT NOT NULL REFERENCES users(id), note TEXT NOT NULL) STRICT;
CREATE TABLE financial_exceptions (id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES print_orders(id), amountFen INTEGER, reason TEXT NOT NULL, reference TEXT NOT NULL, createdAt TEXT NOT NULL, createdBy TEXT NOT NULL REFERENCES users(id), resolvedAt TEXT, resolvedBy TEXT REFERENCES users(id), resolution TEXT) STRICT;
CREATE TABLE cancellation_requests (id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES print_orders(id), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','approved','rejected')), createdAt TEXT NOT NULL, createdBy TEXT NOT NULL REFERENCES users(id), resolvedAt TEXT, resolvedBy TEXT REFERENCES users(id), resolution TEXT) STRICT;
CREATE UNIQUE INDEX one_open_cancel ON cancellation_requests(orderId) WHERE status='requested';
CREATE TABLE order_refunds (
 id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES print_orders(id), status TEXT NOT NULL CHECK(status IN ('requested','approved','rejected','paid_out')),
 amountFen INTEGER NOT NULL CHECK(amountFen>0), reason TEXT NOT NULL, createdAt TEXT NOT NULL, createdBy TEXT NOT NULL REFERENCES users(id),
 decidedAt TEXT, decidedBy TEXT REFERENCES users(id), decisionNote TEXT, paidAt TEXT, paidBy TEXT REFERENCES users(id), payoutReference TEXT, payoutReferenceKey TEXT UNIQUE,
 fulfillmentDecision TEXT CHECK(fulfillmentDecision IN ('resume','stop')), payoutNote TEXT
) STRICT;
CREATE INDEX refunds_order ON order_refunds(orderId,createdAt,id);
CREATE TABLE order_tickets (id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES print_orders(id), userId TEXT NOT NULL REFERENCES users(id), subject TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')), version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL) STRICT;
CREATE INDEX tickets_owner ON order_tickets(userId,createdAt,id);
CREATE TABLE ticket_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticketId TEXT NOT NULL REFERENCES order_tickets(id), authorId TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')), createdAt TEXT NOT NULL) STRICT;
CREATE TABLE business_idempotency (actorId TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL, key TEXT NOT NULL, requestHash TEXT NOT NULL, resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL, PRIMARY KEY(actorId,operation,key)) STRICT;
CREATE TABLE payment_asset_cleanup (assetId TEXT PRIMARY KEY, queuedAt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT) STRICT;
