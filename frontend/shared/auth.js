import { request, clearPrivateViews, setSurface } from './api.js';
import { t, translate } from './i18n.js';
let currentUser = null, currentRole = 'user';
const account = () => document.querySelector('[data-account]');
function render() {
  const matches = currentUser?.role === currentRole;
  const button = account(); if (button) button.textContent = matches ? currentUser.nickname : t(currentRole === 'admin' ? 'adminLogin' : 'account');
  document.querySelectorAll('[data-logout],[data-profile]').forEach(button => { button.hidden = !matches; });
}
export async function refreshIdentity() { try { currentUser = await request('/auth/me'); } catch (error) { if (error.status !== 401) throw error; currentUser = null; } render(); return currentUser; }
export function authDialog(role = 'user', register = false) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog'); dialog.className = 'dialog';
    dialog.innerHTML = '<form><h2></h2><label class="field"><span data-i18n="username"></span><input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_]{3,32}"></label><label class="field"><span data-i18n="password"></span><input name="password" type="password" required minlength="1" maxlength="128"></label><button class="button" type="button" data-password></button><p data-password-rule hidden></p><p class="status error" role="alert"></p><div class="actions"><button class="button" type="button" data-mode></button><button class="button" type="button" data-close data-i18n="cancel"></button><button class="button primary" type="submit" data-submit></button></div></form>';
    document.body.append(dialog); translate(dialog); let done = false, busy = false;
    const form = dialog.querySelector('form'), password = form.elements.password, error = dialog.querySelector('[role=alert]');
    function update() {
      dialog.querySelector('h2').textContent = role === 'admin' ? t('adminLogin') : register ? t('register') : t('login');
      dialog.querySelector('[data-password-rule]').hidden = !register; dialog.querySelector('[data-password-rule]').textContent = t('passwordRule'); password.minLength = register ? 6 : 1; password.maxLength = register ? 12 : 128; if (register) password.pattern = '(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,12}'; else password.removeAttribute('pattern'); dialog.querySelector('[data-mode]').hidden = role === 'admin';
      dialog.querySelector('[data-mode]').textContent = register ? t('login') : t('register'); dialog.querySelector('[data-submit]').textContent = register ? t('register') : t('login');
      password.autocomplete = register ? 'new-password' : 'current-password'; dialog.querySelector('[data-password]').textContent = t(password.type === 'password' ? 'passwordShow' : 'passwordHide');
    }
    dialog.querySelector('[data-mode]').onclick = () => { register = !register; update(); };
    dialog.querySelector('[data-password]').onclick = () => { password.type = password.type === 'password' ? 'text' : 'password'; update(); };
    dialog.querySelector('[data-close]').onclick = () => { if (!busy) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (!done) reject(Object.assign(new Error(t('cancel')), { code: 'USER_CANCELLED' })); });
    form.onsubmit = async event => {
      event.preventDefault(); busy = true; error.textContent = ''; const button = dialog.querySelector('[data-submit]'); button.disabled = true; button.textContent = t('busy');
      try {
        const body = { username: form.elements.username.value, password: password.value };
        currentUser = await request(register ? '/auth/register' : role === 'admin' ? '/auth/admin-login' : '/auth/login', { method: 'POST', body });
        done = true; render(); dialog.close(); resolve(currentUser);
      } catch (failure) { error.textContent = failure.message; } finally { busy = false; button.disabled = false; update(); }
    };
    update(); dialog.showModal(); form.elements.username.focus();
  });
}
export async function ensureIdentity(role = 'user') { const user = await refreshIdentity(); if (user?.role === role) return user; return authDialog(role); }
export async function initializeAuth(role = 'user') {
  setSurface(role === 'admin' ? 'admin' : 'student');
  currentRole = role;
  account()?.addEventListener('click', () => authDialog(role).catch(() => {}));
  document.querySelector('[data-logout]')?.addEventListener('click', async () => { try { await request('/auth/logout', { method: 'POST', body: {} }); currentUser = null; clearPrivateViews(); render(); } catch (error) { alert(error.message); } });
  document.querySelector('[data-profile]')?.addEventListener('click', () => {
    const dialog = document.createElement('dialog'); dialog.className = 'dialog';
    dialog.innerHTML = '<form><h2 data-i18n="profileTitle"></h2><label class="field"><span data-i18n="nickname"></span><input name="nickname" required maxlength="80"></label><p class="status error" role="alert"></p><div class="actions"><button class="button" type="button" data-close data-i18n="cancel"></button><button class="button primary" type="submit" data-i18n="save"></button></div></form>';
    document.body.append(dialog); translate(dialog); dialog.querySelector('input').value = currentUser.nickname;
    dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove();
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const button = dialog.querySelector('[type=submit]'); button.disabled = true;
      try { currentUser = await request('/me/profile', { method: 'PATCH', body: { nickname: dialog.querySelector('input').value } }); render(); dialog.close(); }
      catch (error) { dialog.querySelector('[role=alert]').textContent = error.message; } finally { button.disabled = false; } };
    dialog.showModal(); dialog.querySelector('input').focus();
  });
  window.addEventListener('cp:auth-expired', () => { currentUser = null; render(); }); window.addEventListener('cp:language', render);
  await refreshIdentity();
}
