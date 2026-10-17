'use strict';
const v = require('../validation');
const { invalid } = require('../errors');
const FEEDBACK_TYPES = ['print_quality','content_quantity','delivery','payment_refund','other'];
function fields(body) {
  // Old clients omit feedbackType. Their text remains readable as 'other'.
  const feedbackType = v.choice(body.feedbackType === undefined ? 'other' : body.feedbackType, FEEDBACK_TYPES, 'feedbackType');
  const empty = value=>value === undefined || value === null || value === '';
  if (empty(body.contactType) && empty(body.contactValue)) return { feedbackType, contactType:null, contactValue:null };
  if (empty(body.contactType) || empty(body.contactValue)) invalid('contactValue','填写联系方式时须同时提供类型和内容');
  const contactType = v.choice(body.contactType,['phone','wechat'],'contactType');
  const contactValue = v.string(body.contactValue,'contactValue',{min:1,max:120});
  if (/[\x00-\x1f\x7f]/.test(contactValue)) invalid('contactValue','联系方式不能包含控制字符');
  return { feedbackType, contactType, contactValue };
}
function project(row, actor) {
  const { contactValue, ...rest } = row;
  return { ...rest, contactProvided: !!contactValue, ...(actor.role === 'admin' ? { contactValue } : {}) };
}
module.exports = { fields, project, FEEDBACK_TYPES };
