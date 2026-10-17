'use strict';
const { createHash } = require('node:crypto');
const v = require('../validation');
const { invalid, ApiError } = require('../errors');
const { parsePages } = require('../files/pages');
const PRICING_RULES = Object.freeze({ singleSidedSheetPriceFen: 50, doubleSidedSheetPriceFen: 90, oddTailSheetPriceFen: 50 });
const RULES = Object.freeze({ paperSize: 'A4', colorMode: 'black_white', pricingVersion: '1.1.0', ...PRICING_RULES, minContentPages: 1, maxContentPages: 99,
  deliveryFeeFen: 0, currency: 'CNY', buildingId: 'local-dorm', fileRetentionDaysAfterCompletion: 7, quoteValiditySeconds: 900, preparationTimeoutSeconds: 600, maxQuoteItems: 20 });
const DISPLAY_STATUSES = ['cancelled','cancel_requested','completed','financial_exception','refund_pending','fulfillment_paused','payment_pending','payment_review','payment_rejected','awaiting_print','printing','print_failed','awaiting_delivery','delivering','delivery_failed'];
const ORDER_ACTIONS = ['view_query_code','view_compensation_code','view_tickets','preview','download','submit_payment','request_cancel','create_ticket','review_payment','resolve_financial_exception','resolve_coupon_exception','start_print','record_print_progress','fail_print','complete_print','retry_print','reprint','record_reprint_progress','fail_reprint','complete_reprint','retry_reprint','resume_fulfillment','request_cancel_admin','start_delivery','fail_delivery','confirm_delivered','retry_delivery','resolve_cancel','request_refund','approve_refund','reject_refund','record_refund_paid','pause_fulfillment','resolve_fulfillment_pause'];
function bool(value, field) { if (typeof value !== 'boolean') invalid(field, '必须为布尔值'); return value; }
function integer(value, field, min = 1, max = 99) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field, `必须为 ${min}–${max} 的整数`); return value; }
function uuid(value, field = 'id') { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) invalid(field, '标识无效'); return value; }
function optional(value, field, max = 500) { return v.string(value, field, { max, fallback: '' }); }
function reason(value, field = 'reason') { return v.string(value, field, { min: 1, max: 1000 }); }
function calculateItems(items, getSource) {
  if (!Array.isArray(items) || !items.length || items.length > RULES.maxQuoteItems) invalid('items', `明细数量须为 1–${RULES.maxQuoteItems}`);
  const calculated = items.map((input, i) => {
    v.keys(input, ['fileId','pages','copies','duplex'], `items.${i}`); uuid(input.fileId, `items.${i}.fileId`);
    const copies = integer(input.copies, `items.${i}.copies`), duplex = bool(input.duplex, `items.${i}.duplex`), source = getSource(input.fileId);
    const pageNumbers = parsePages(input.pages, source.sourcePageCount, 100), selectedPageCount = pageNumbers.length;
    const contentPages = selectedPageCount * copies, sheetCount = (duplex ? Math.ceil(selectedPageCount / 2) : selectedPageCount) * copies;
    return { fileId: source.id, originalName: source.originalName, sourceSha256: source.sourceSha256, sourcePageCount: source.sourcePageCount,
      pageNumbers, selectedPageCount, copies, duplex, contentPages, sheetCount,
      amountFen: (duplex ? Math.floor(selectedPageCount / 2) * RULES.doubleSidedSheetPriceFen + (selectedPageCount % 2) * RULES.oddTailSheetPriceFen : selectedPageCount * RULES.singleSidedSheetPriceFen) * copies,
      paperSize: RULES.paperSize, colorMode: RULES.colorMode, copiesInPdf: 1, printArtifactId: null, printArtifactSha256: null };
  });
  const contentPages = calculated.reduce((n, item) => n + item.contentPages, 0);
  if (contentPages < 1 || contentPages > 99) throw new ApiError(400, 'CONTENT_PAGE_LIMIT', '整单内容页数含份数，须为 1–99 页', { items: '请减少选页或份数' });
  const sheetCount = calculated.reduce((n, item) => n + item.sheetCount, 0);
  const printAmountFen = calculated.reduce((n, item) => n + item.amountFen, 0);
  return { items: calculated, totals: { contentPages, sheetCount, pricingVersion: RULES.pricingVersion, pricingRules: { ...PRICING_RULES }, printAmountFen, discountAmountFen: 0, deliveryFeeFen: 0, totalAmountFen: printAmountFen, currency: 'CNY' } };
}
// Compatibility is a read projection only. Never reprice or write back an existing order.
function totalsDto(totals) {
  if (totals.pricingVersion === RULES.pricingVersion) return totals;
  return { ...totals, pricingVersion: 'legacy', pricingRules: { unitSheetPriceFen: totals.unitSheetPriceFen ?? 50 }, discountAmountFen: totals.discountAmountFen ?? 0 };
}
function address(value, label) {
  v.keys(value, ['buildingId','room','contact','notes','receiptMethod','receiptNote'], 'deliveryAddress');
  if (value.buildingId !== RULES.buildingId) throw new ApiError(400, 'BUILDING_NOT_SUPPORTED', '仅配送本栋宿舍', { buildingId: RULES.buildingId });
  const receiptMethod=v.choice(value.receiptMethod,['handover','contact_first','doorstep','other'],'deliveryAddress.receiptMethod');
  const contact=optional(value.contact,'contact',120),receiptNote=optional(value.receiptNote,'receiptNote',500);
  if(receiptMethod==='contact_first'&&!contact)invalid('deliveryAddress.contact','送达前联系须填写联系方式');
  if(receiptMethod==='other'&&!receiptNote)invalid('deliveryAddress.receiptNote','其他接收方式须填写说明');
  return { buildingId: RULES.buildingId, buildingLabel: label, room: v.string(value.room, 'room', { min: 1, max: 40 }), contact, notes: optional(value.notes, 'notes', 500), receiptMethod, receiptNote };
}
function canonical(value) { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}'; return JSON.stringify(value); }
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const referenceKey = value => v.string(value, 'reference', { min: 1, max: 160 }).normalize('NFKC').toLocaleLowerCase('en-US');
module.exports = { RULES, PRICING_RULES, DISPLAY_STATUSES, ORDER_ACTIONS, bool, integer, uuid, optional, reason, calculateItems, totalsDto, address, fingerprint, referenceKey };
