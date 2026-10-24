import { api, $, h } from './common.js';

async function main() {
  let st;
  try { st = await api('GET', '/api/setup/status'); } catch (e) { $('#state').replaceChildren(h('div', { class: 'alert alert-error' }, e.message)); return; }
  if (!st.needed) {
    $('#state').replaceChildren(h('div', { class: 'card card-pad stack' }, h('p', null, 'تم إعداد النظام مسبقًا.'), h('a', { class: 'btn btn-primary btn-lg', href: '/login' }, 'تسجيل الدخول')));
    return;
  }
  if (st.tokenRequired && !st.tokenConfigured) {
    $('#state').replaceChildren(h('div', { class: 'alert alert-warn' }, 'لم يُضبط متغير SETUP_TOKEN في إعدادات الاستضافة. اضبطه ثم أعد تشغيل الخدمة وحدّث هذه الصفحة.'));
    return;
  }
  $('#state').replaceChildren();
  $('#form').hidden = false;
  $('#tokenSet').hidden = !st.tokenRequired;
  const qsToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (qsToken) $('#setupToken').value = qsToken;
  $('#shopName').focus();
}

function readLogo(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 512 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('تعذر قراءة صورة الشعار'));
    img.src = URL.createObjectURL(file);
  });
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#err'); err.hidden = true;
  const btn = $('#submit');
  if (btn.disabled) return;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    const body = {
      setupToken: $('#setupToken').value.trim(), shopName: $('#shopName').value, branchName: $('#branchName').value,
      timezone: $('#timezone').value, pickupInstructions: $('#pickup').value, ownerName: $('#ownerName').value,
      username: $('#username').value, password: $('#password').value, logo: await readLogo($('#logo').files[0]),
    };
    await api('POST', '/api/setup', body);
    location.href = '/staff/settings#start';
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false; err.scrollIntoView({ block: 'center' });
  } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
});
main();
