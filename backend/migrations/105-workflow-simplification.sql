-- Preserve historical production, delivery, amounts, addresses and deadlines.
ALTER TABLE print_orders ADD COLUMN acceptedAt TEXT;
ALTER TABLE print_orders ADD COLUMN workflowHold INTEGER NOT NULL DEFAULT 0 CHECK(workflowHold IN (0,1));
ALTER TABLE print_orders ADD COLUMN workflowHoldReasonCode TEXT;
ALTER TABLE print_orders ADD COLUMN workflowHoldNote TEXT;
ALTER TABLE print_orders ADD COLUMN refundFulfillmentHold INTEGER NOT NULL DEFAULT 0 CHECK(refundFulfillmentHold IN (0,1));
CREATE TABLE general_feedback (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), subject TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 contactType TEXT CHECK(contactType IN ('phone','wechat')), contactValue TEXT,
 CHECK((contactType IS NULL AND contactValue IS NULL) OR (contactType IS NOT NULL AND contactValue IS NOT NULL AND length(contactValue) BETWEEN 1 AND 120))
) STRICT;
CREATE INDEX feedback_owner ON general_feedback(userId,createdAt,id);
CREATE TABLE general_feedback_updates (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, feedbackId TEXT NOT NULL REFERENCES general_feedback(id),
 authorId TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')), createdAt TEXT NOT NULL
) STRICT;
CREATE INDEX feedback_updates_parent ON general_feedback_updates(feedbackId,seq);
CREATE TRIGGER order_acceptance_immutable BEFORE UPDATE ON print_orders
 WHEN OLD.acceptedAt IS NOT NULL AND NEW.acceptedAt IS NOT OLD.acceptedAt
 BEGIN SELECT RAISE(ABORT,'ORDER_ACCEPTANCE_IMMUTABLE'); END;
