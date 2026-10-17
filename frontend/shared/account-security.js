import { request } from './api.js';

const L = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const passwordPattern = '(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,12}';
let active = null;
export async function openAccountSecurity(user) {
  if (active?.isConnected || !user) return;
  const trigger = document.activeElement, dialog = document.createElement('dialog');
  active = dialog; dialog.className = 'dialog security-dialog'; dialog.setAttribute('aria-label', L('账号安全', 'Account security'));
  document.body.append(dialog);
  let state = null, mode = 'home', busy = false, message = '';
  const close = () => dialog.close();
  const questionText = question => document.documentElement.lang === 'en' ? question.en : question.zh;
  const field = (name, label, attrs = '') => `<label class="field"><span>${escape(label)}</span><input name="${name}" type="password" required ${attrs.includes('maxlength=') ? '' : 'maxlength="120"'} ${attrs.includes('autocomplete=') ? '' : 'autocomplete="off"'} ${attrs}></label>`;
  const currentAnswers = () => `<p class="hint">${L('请按顺序回答原来的三个问题。答案忽略首尾空格、全半角及英文字母大小写。', 'Answer all three existing questions in order. Leading/trailing spaces, full-width characters and letter case are normalized.')}</p>${state.questions.map((question, i) => field('answer'+i, `${i+1}. ${questionText(question)}`)).join('')}`;
  function render() {
    if (!dialog.isConnected) return;
    let html = '';
    if (!state) html = `<p>${L('正在读取账号安全设置…', 'Loading account security…')}</p>`;
    else if (mode === 'home') html = `<p>${state.configured ? L('已设置三个密保问题。修改密码前需全部回答正确。', 'Three security questions are configured. Answer all three correctly to change your password.') : L('尚未设置密保。请一次选择三个不同的问题并填写答案。', 'Choose three different questions and provide an answer for each.')}</p><div class="actions"><button class="button primary" type="button" data-security-mode="questions">${state.configured ? L('更换密保问题', 'Replace security questions') : L('设置三个密保问题', 'Set three security questions')}</button>${state.configured ? `<button class="button" type="button" data-security-mode="password">${L('修改密码', 'Change password')}</button>` : ''}</div>`;
    else if (mode === 'questions') {
      html = state.configured ? `<h3>${L('先验证原密保', 'Verify existing answers')}</h3>${currentAnswers()}` : field('currentPassword', L('当前登录密码', 'Current password'), 'maxlength="128" autocomplete="current-password"');
      html += `<h3>${L('设置三个不同的问题与答案', 'Set three different questions and answers')}</h3><p class="hint">${L('答案最多 120 个字符，请记住自己的填写方式。', 'Answers may contain up to 120 characters. Remember the answers you enter.')}</p>`;
      for (let i = 0; i < 3; i++) html += `<fieldset><legend>${L('密保问题', 'Security question')} ${i+1}</legend><label class="field"><span>${L('选择问题', 'Choose a question')} ${i+1}</span><select name="question${i}" required><option value="">${L('请选择', 'Choose a question')}</option>${state.availableQuestions.map(question => `<option value="${escape(question.id)}">${escape(questionText(question))}</option>`).join('')}</select></label>${field('newAnswer'+i, L('答案', 'Answer')+' '+(i+1))}</fieldset>`;
    } else {
      html = currentAnswers() + `<p class="hint">${L('新密码须为 6–12 位，同时包含英文字母和数字，不含空格或符号。修改后，其他设备的登录会失效。', 'Use 6–12 letters and digits, with at least one of each and no spaces or symbols. Other devices will be signed out.')}</p>`;
      html += field('newPassword', L('新密码', 'New password'), `minlength="6" maxlength="12" pattern="${passwordPattern}" autocomplete="new-password"`);
      html += field('confirmPassword', L('再次输入新密码', 'Confirm new password'), `minlength="6" maxlength="12" pattern="${passwordPattern}" autocomplete="new-password"`);
    }
    dialog.innerHTML = `<form><h2>${L('账号安全', 'Account security')}</h2><p class="hint">${escape(user.username)}</p><p class="status success" role="status">${escape(message)}</p>${html}<p class="status error" role="alert" aria-live="polite"></p><div class="actions"><button type="button" class="button" data-security-close>${L('关闭', 'Close')}</button>${mode !== 'home' ? `<button type="button" class="button" data-security-mode="home">${L('返回', 'Back')}</button><button type="submit" class="button primary" data-security-submit>${L('确认保存', 'Save')}</button>` : !state ? `<button type="button" class="button" data-security-retry>${L('重试', 'Retry')}</button>` : ''}</div></form>`;
    dialog.querySelector('[data-security-close]').onclick = () => { if (!busy) close(); };
    dialog.querySelector('[data-security-retry]')?.addEventListener('click', load);
    dialog.querySelectorAll('[data-security-mode]').forEach(button => button.onclick = () => { if (!busy) { mode = button.dataset.securityMode; message = ''; render(); dialog.querySelector('input,select,button')?.focus(); } });
    dialog.querySelector('form').onsubmit = save;
  }
  async function checkIdentity() {
    const identity = await request('/auth/me');
    if (identity.id !== user.id || !dialog.open) { close(); throw new Error(L('账号已切换，请重新打开账号安全。', 'The account changed. Open account security again.')); }
  }
  async function load() {
    try { await checkIdentity(); state = await request('/me/security-questions'); render(); }
    catch (error) { if (dialog.isConnected) dialog.querySelector('[role=alert]').textContent = error.message; }
  }
  async function save(event) {
    event.preventDefault(); if (busy || mode === 'home') return;
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form)), errorNode = form.querySelector('[role=alert]');
    errorNode.textContent = '';
    if (mode === 'password' && values.newPassword !== values.confirmPassword) { errorNode.textContent = L('两次输入的新密码不一致。', 'The new passwords do not match.'); return; }
    if (mode === 'questions' && new Set([values.question0, values.question1, values.question2]).size !== 3) { errorNode.textContent = L('请选择三个不同的问题。', 'Choose three different questions.'); return; }
    busy = true; form.querySelectorAll('input,select,button').forEach(node => node.disabled = true);
    try {
      await checkIdentity();
      const answers = [values.answer0, values.answer1, values.answer2];
      if (mode === 'password') {
        await request('/me/password', { method:'POST', body:{ expectedVersion:state.version, answers, newPassword:values.newPassword } });
        message = L('密码已修改，其他设备已退出。当前页面可继续使用。', 'Password changed. Other devices have been signed out. You can keep using this page.');
      } else {
        state = await request('/me/security-questions', { method:'POST', body:{ expectedVersion:state.version, questions:[0,1,2].map(i => ({questionId:values['question'+i],answer:values['newAnswer'+i]})), ...(state.configured ? {answers} : {currentPassword:values.currentPassword}) } });
        message = L('三个密保问题已保存。修改密码时须全部答对。', 'Three security questions saved. All three answers are required to change your password.');
      }
      mode = 'home'; render(); dialog.querySelector('button')?.focus();
    } catch (error) { if (dialog.isConnected) errorNode.textContent = error.message; }
    finally { busy = false; form.querySelectorAll('input,select,button').forEach(node => node.disabled = false); }
  }
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  window.addEventListener('cp:auth-expired', close);
  window.addEventListener('pagehide', close);
  dialog.addEventListener('close', () => {
    dialog.replaceChildren(); dialog.remove(); active = null;
    window.removeEventListener('cp:auth-expired', close); window.removeEventListener('pagehide', close);
    if (trigger?.isConnected) trigger.focus();
  });
  render(); dialog.showModal(); await load();
}
