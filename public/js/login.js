import { api, $ } from './common.js';

const form = $('#form');
api('GET', '/api/setup/status').then((s) => { if (s.needed) $('#setupHint').hidden = false; }).catch(() => {});
$('#username').focus();
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#err');
  err.hidden = true;
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) { err.textContent = 'أدخل اسم المستخدم وكلمة المرور'; err.hidden = false; return; }
  const btn = $('#submit');
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  try {
    await api('POST', '/api/auth/login', { username, password });
    location.href = '/staff';
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    $('#password').select();
  } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
});
