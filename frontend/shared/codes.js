export const normalizeCode = value => String(value || '').toUpperCase().replace(/[\s-]/g, '');
export const validCode = (value, length) => new RegExp('^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{' + length + '}$').test(normalizeCode(value));
export const groupCode = (value, size = 5) => normalizeCode(value).match(new RegExp('.{1,' + size + '}', 'g'))?.join('-') || '';

// Private values live only in this open panel. Never put them in links, storage or logs.
export function privateCodes({ title, help, items }) {
  const L = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const trigger = document.activeElement, dialog = document.createElement('dialog');
  dialog.className = 'dialog private-code-dialog'; dialog.setAttribute('aria-label', title);
  const heading = document.createElement('h2'); heading.textContent = title;
  const description = document.createElement('p'); description.textContent = help;
  dialog.append(heading, description);
  for (const item of items) {
    const label = document.createElement('label'); label.className = 'field';
    const caption = document.createElement('span'); caption.textContent = item.label;
    const input = document.createElement('textarea'); input.readOnly = true; input.rows = 2;
    input.autocomplete = 'off'; input.spellcheck = false; input.dataset.privateCode = '';
    input.value = groupCode(item.code, item.length === 32 ? 4 : 5);
    const copy = document.createElement('button'); copy.className = 'button'; copy.type = 'button'; copy.textContent = L('复制凭证', 'Copy code');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(input.value); copy.textContent = L('已复制', 'Copied'); }
      catch { input.focus(); input.select(); copy.textContent = L('请选择并手动复制', 'Select and copy manually'); } };
    label.append(caption, input, copy); dialog.append(label);
  }
  items.length = 0;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'button primary'; close.dataset.close = '';
  close.textContent = L('关闭', 'Close'); close.onclick = () => dialog.close(); dialog.append(close);
  const conceal = () => { if (document.hidden) dialog.close(); };
  const clear = () => { if (dialog.open) dialog.close(); };
  dialog.onclose = () => {
    dialog.querySelectorAll('textarea').forEach(input => { input.value = ''; }); dialog.remove();
    document.removeEventListener('visibilitychange', conceal); window.removeEventListener('cp:clear-private-views', clear);
    if (trigger?.isConnected) trigger.focus();
  };
  document.addEventListener('visibilitychange', conceal); window.addEventListener('cp:clear-private-views', clear);
  document.body.append(dialog); dialog.showModal(); close.focus(); return dialog;
}
