'use strict';
const { hashSecret, hashPassword, verifyPassword, hashToken } = require('../auth');
const { ApiError, invalid } = require('../errors');
const v = require('../validation');

const questions = [
  ['first_school', '你就读的第一所学校叫什么？', 'What was the name of your first school?'],
  ['childhood_friend', '你儿时最好的朋友叫什么？', 'What was the name of your childhood best friend?'],
  ['childhood_place', '你童年居住的地方叫什么？', 'What was the name of the place where you grew up?'],
  ['favorite_teacher', '你最难忘的老师叫什么？', 'What was the name of your most memorable teacher?'],
  ['first_pet', '你的第一只宠物叫什么？', 'What was the name of your first pet?'],
  ['memorable_city', '你第一次独自旅行去的城市是哪里？', 'Which city did you first travel to on your own?'],
  ['favorite_book', '你童年最喜欢的书叫什么？', 'What was your favorite book as a child?'],
  ['family_nickname', '家人小时候怎么称呼你？', 'What nickname did your family use for you as a child?']
].map(([id, zh, en]) => ({ id, zh, en }));
const questionIds = questions.map(question => question.id);
function answers(value, field) {
  if (!Array.isArray(value) || value.length !== 3) invalid(field, '必须一次填写三个答案');
  return value.map((answer, i) => {
    const normalized = v.string(answer, `${field}.${i}`, { min: 1, max: 120 }).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    return v.string(normalized, `${field}.${i}`, { min: 1, max: 120 });
  });
}
module.exports = ({ db, auth, add, now }) => {
  const record = id => db.get('SELECT * FROM user_security WHERE userId=?', id);
  const state = id => {
    const row = record(id);
    return { configured: !!row, version: row?.version || 0, questions: row ? JSON.parse(row.questionsJson).map(item => questions.find(question => question.id === item.questionId)) : [], availableQuestions: questions };
  };
  function expected(req, row) {
    if (!Number.isSafeInteger(req.body.expectedVersion) || req.body.expectedVersion < 0) invalid('expectedVersion', '须为非负整数');
    if (req.body.expectedVersion !== (row?.version || 0)) throw new ApiError(409, 'SECURITY_STATE_CHANGED', '密保设置已更新，请重新打开账号安全');
  }
  function limit(req, res) {
    auth.rate(`security:ip:${req.ip}`, 30, 15 * 60000, res);
    auth.rate(`security:account:${req.user.id}`, 5, 15 * 60000, res);
  }
  function verified(req, before) {
    // Recheck after expensive async hashing so an expired/revoked session or a
    // concurrent password/question change cannot write using stale authority.
    if (auth.sessionFrom(req)?.userId !== req.user.id) throw new ApiError(401, 'AUTH_REQUIRED', '会话已失效，请重新登录');
    if (db.get('SELECT passwordHash FROM users WHERE id=?', req.user.id)?.passwordHash !== req.user.passwordHash || (record(req.user.id)?.version || 0) !== (before?.version || 0)) {
      throw new ApiError(409, 'SECURITY_STATE_CHANGED', '账号安全信息已更新，请重新打开账号安全');
    }
  }
  function success(req) { db.run('DELETE FROM rate_limits WHERE bucketKey=?', hashToken(`security:account:${req.user.id}`)); }
  async function checkAnswers(row, input) {
    const submitted = answers(input, 'answers'), stored = JSON.parse(row.questionsJson);
    let valid = true;
    // Verify all three every time. Never reveal which answer failed.
    for (let i = 0; i < 3; i++) valid = (await verifyPassword(submitted[i], stored[i].answerHash)) && valid;
    if (!valid) throw new ApiError(403, 'SECURITY_ANSWERS_INCORRECT', '密保答案不正确，请检查全部三个答案');
  }
  add('get', '/me/security-questions', { role: 'session', account: true }, req => state(req.user.id));
  add('post', '/me/security-questions', { role: 'session', account: true, transaction: false, bodyKeys: ['expectedVersion', 'questions', 'currentPassword', 'answers'] }, async (req, res) => {
    const before = record(req.user.id); expected(req, before);
    if (!Array.isArray(req.body.questions) || req.body.questions.length !== 3) invalid('questions', '必须一次设置三个密保问题');
    const selected = req.body.questions.map((item, i) => {
      v.keys(item, ['questionId', 'answer'], `questions.${i}`);
      return v.choice(item.questionId, questionIds, `questions.${i}.questionId`);
    });
    if (new Set(selected).size !== 3) invalid('questions', '请选择三个不同的问题');
    const normalized = answers(req.body.questions.map(item => item.answer), 'questions.answer');
    limit(req, res);
    if (before) {
      await checkAnswers(before, req.body.answers);
    } else if (!await verifyPassword(v.loginPassword(req.body.currentPassword, 'currentPassword'), req.user.passwordHash)) {
      throw new ApiError(403, 'CURRENT_PASSWORD_INCORRECT', '当前密码不正确');
    }
    const stored = [];
    for (let i = 0; i < 3; i++) stored.push({ questionId: selected[i], answerHash: await hashSecret(normalized[i]) });
    return db.tx(() => {
      verified(req, before);
      db.run('INSERT INTO user_security(userId,version,questionsJson,updatedAt) VALUES(?,?,?,?) ON CONFLICT(userId) DO UPDATE SET version=excluded.version,questionsJson=excluded.questionsJson,updatedAt=excluded.updatedAt', req.user.id, (before?.version || 0) + 1, JSON.stringify(stored), now());
      success(req); return state(req.user.id);
    });
  });
  add('post', '/me/password', { role: 'session', account: true, transaction: false, bodyKeys: ['expectedVersion', 'answers', 'newPassword'] }, async (req, res) => {
    const before = record(req.user.id); expected(req, before);
    if (!before) throw new ApiError(409, 'SECURITY_QUESTIONS_REQUIRED', '请先设置三个密保问题，再修改密码');
    const password = v.password(req.body.newPassword, 'newPassword');
    limit(req, res); await checkAnswers(before, req.body.answers);
    const passwordHash = await hashPassword(password);
    return db.tx(() => {
      verified(req, before);
      db.run('UPDATE users SET passwordHash=? WHERE id=?', passwordHash, req.user.id);
      db.run('DELETE FROM sessions WHERE userId=?', req.user.id);
      auth.newSession(req, res, req.user.id); res.set('X-CSRF-Token', req.session.csrfToken);
      success(req); return { passwordChanged: true, otherSessionsRevoked: true };
    });
  });
};
module.exports.questions = questions;
