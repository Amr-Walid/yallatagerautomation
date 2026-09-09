/* ================= يلا تاجر — منطق الواجهة ================= */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  categories: [],
  categoryId: null,
  categoryName: '',
  file: null,
  jobId: null,
  results: [],
  filter: 'all',
  es: null,
};

/* ---------------------------------------------------- أدوات مساعدة */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msg(el, text, kind = '') {
  const n = $(el);
  n.textContent = text || '';
  n.className = 'msg' + (kind ? ' ' + kind : '');
}

function showPanel(n) {
  for (let i = 1; i <= 4; i++) $(`panel-${i}`).classList.toggle('hidden', i !== n);
  document.querySelectorAll('.step').forEach((s) => {
    const k = Number(s.dataset.step);
    s.classList.toggle('active', k === n);
    s.classList.toggle('done', k < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('خطأ في الاتصال بالسيرفر');
    return res;
  }
  const json = await res.json();
  if (!res.ok || json.success === false) throw new Error(json.message || 'حدث خطأ');
  return json;
}

function triggerDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** تنزيل ملف من استجابة POST */
async function download(url, body, fallbackName) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let m = 'تعذّر تنزيل الملف';
    try { m = (await res.json()).message || m; } catch { /* ignore */ }
    throw new Error(m);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const nm = /filename="([^"]+)"/.exec(cd);
  triggerDownload(blob, nm ? nm[1] : fallbackName);
}

/* ---------------------------------------------------- ١) تسجيل الدخول */

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'جارٍ التحقق…';
  msg('login-msg', '');

  try {
    const r = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
    });

    state.token = r.token;
    state.categories = r.categories || [];

    const who = $('whoami');
    who.innerHTML = `<b>${escapeHtml(r.name)}</b> — تاجر #${escapeHtml(String(r.vendorId))}`
      + (r.approved ? '' : ' <span style="color:var(--warn)">(غير معتمد)</span>');
    who.classList.remove('hidden');

    fillCategories();
    await fillColumns();
    showPanel(2);
  } catch (err) {
    msg('login-msg', err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تسجيل الدخول';
  }
});

function fillCategories() {
  const sel = $('category');
  sel.innerHTML = '<option value="">— اختر الفئة —</option>'
    + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.onchange = () => {
    state.categoryId = sel.value ? Number(sel.value) : null;
    state.categoryName = sel.value ? sel.options[sel.selectedIndex].textContent : '';
    $('chosen-cat').textContent = state.categoryName;
  };
}

async function fillColumns() {
  try {
    const r = await api('/api/columns');
    $('cols-list').innerHTML = r.columns.map((c) => `
      <li>
        <span class="${c.required ? 'req' : 'opt'}">${escapeHtml(c.header)}</span>
        ${c.required ? '' : ' <span class="opt">(اختياري)</span>'}
        <div class="hint">${escapeHtml(c.hint)}</div>
      </li>`).join('');
  } catch { /* غير حرج */ }
}

/* ---------------------------------------------------- ٢) التيمبليت */

$('dl-btn').addEventListener('click', async () => {
  if (!state.categoryId) return msg('tpl-msg', 'اختر الفئة أولاً', 'err');
  const btn = $('dl-btn');
  btn.disabled = true;
  btn.textContent = 'جارٍ التحضير…';
  try {
    await download('/api/template',
      { token: state.token, categoryId: state.categoryId },
      `yalla-template-${state.categoryId}.xlsx`);
    msg('tpl-msg', 'تم تنزيل التيمبليت ✓ املأه ثم ارفعه في الخطوة التالية.', 'ok');
  } catch (err) {
    msg('tpl-msg', err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ تنزيل تيمبليت الإكسل';
  }
});

$('to-upload-btn').addEventListener('click', () => {
  if (!state.categoryId) return msg('tpl-msg', 'اختر الفئة أولاً', 'err');
  showPanel(3);
});

$('back-2-btn').addEventListener('click', () => showPanel(2));

/* ---------------------------------------------------- ٣) الرفع */

const drop = $('drop');
const fileInput = $('file');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

function setFile(f) {
  if (!/\.xlsx?$/i.test(f.name)) {
    msg('run-msg', 'الملف يجب أن يكون بصيغة .xlsx', 'err');
    return;
  }
  state.file = f;
  $('file-name').textContent = `${f.name} — ${(f.size / 1024).toFixed(0)} كيلوبايت`;
  drop.classList.add('has');
  $('run-btn').disabled = false;
  msg('run-msg', '');
}

$('run-btn').addEventListener('click', async () => {
  if (!state.file || !state.categoryId) return;
  const btn = $('run-btn');
  btn.disabled = true;
  btn.textContent = 'جارٍ البدء…';
  msg('run-msg', '');

  try {
    const fd = new FormData();
    fd.append('token', state.token);
    fd.append('categoryId', String(state.categoryId));
    fd.append('dryRun', $('dry-run').checked ? 'true' : 'false');
    fd.append('file', state.file, state.file.name);

    const r = await api('/api/run', { method: 'POST', body: fd });
    state.jobId = r.jobId;
    startWatching(r.jobId, r.dryRun);
    showPanel(4);
  } catch (err) {
    msg('run-msg', err.message, 'err');
    btn.disabled = false;
  } finally {
    btn.textContent = '▶ ابدأ التسجيل';
  }
});

/* ---------------------------------------------------- ٤) المتابعة المباشرة */

function resetProgressUI(dryRun) {
  state.results = [];
  state.filter = 'all';
  $('log').textContent = '';
  $('bar-fill').style.width = '0%';
  $('prog-title').textContent = dryRun ? 'جارٍ المعاينة…' : 'جارٍ التسجيل…';
  $('phase-text').textContent = 'التحضير…';
  $('stats').classList.add('hidden');
  $('usage').classList.add('hidden');
  $('results-head').classList.add('hidden');
  $('table-wrap').classList.add('hidden');
  $('final-actions').classList.add('hidden');
  $('cancel-btn').classList.remove('hidden');
  $('cancel-btn').disabled = false;
  $('results').tBodies[0].innerHTML = '';
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.f === 'all'));
  $('logbox').open = true;
}

function startWatching(jobId, dryRun) {
  resetProgressUI(dryRun);
  if (state.es) state.es.close();

  const es = new EventSource(`/api/job/${jobId}/stream`);
  state.es = es;

  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
  es.onerror = () => {
    // السيرفر يُغلق الاتصال بعد الانتهاء — نتحقّق من الحالة النهائية
    es.close();
    fetch(`/api/job/${jobId}`)
      .then((r) => r.json())
      .then((j) => { if (j.success && j.job) applyState(j.job); })
      .catch(() => {});
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'phase':
      $('phase-text').textContent = ev.message;
      appendLog('▸ ' + ev.message);
      break;
    case 'index':
      $('phase-text').textContent = ev.message;
      if (ev.data && ev.data.pages) {
        $('bar-fill').style.width = Math.round((ev.data.page / ev.data.pages) * 25) + '%';
      }
      break;
    case 'row-start':
      $('phase-text').textContent = ev.message;
      break;
    case 'row':
      if (ev.data) addResultRow(ev.data);
      break;
    case 'ok': appendLog('✔ ' + ev.message); break;
    case 'warn': appendLog('⚠ ' + ev.message); break;
    case 'fail': appendLog('✘ ' + ev.message); break;
    case 'log': appendLog('  ' + ev.message); break;
    case 'state': if (ev.data) applyState(ev.data); break;
    case 'done': appendLog('— انتهت العملية —'); break;
  }
}

function appendLog(line) {
  const pre = $('log');
  pre.textContent += line + '\n';
  pre.scrollTop = pre.scrollHeight;
}

/** تصنيف الحالة إلى مجموعة عرض */
function group(status) {
  if (status === 'saved') return 'saved';
  if (status === 'already_published' || status === 'already_submitted') return 'skipped';
  if (status === 'not_found') return 'not_found';
  return 'failed';
}

const LABELS = {
  saved: 'تم التسجيل',
  already_published: 'مسجّل سابقاً',
  already_submitted: 'أُرسل سابقاً',
  not_found: 'غير موجود',
  no_price: 'بدون سعر',
  missing_key: 'صف ناقص',
  save_failed: 'فشل التسجيل',
  error: 'خطأ',
};

const TAG_CLASS = { saved: 'saved', skipped: 'skipped', not_found: 'notfound', failed: 'failed' };

function addResultRow(rec) {
  state.results.push(rec);
  $('results-head').classList.remove('hidden');
  $('table-wrap').classList.remove('hidden');
  renderRow(rec);
  updateLiveStats();
}

function renderRow(rec) {
  const g = group(rec.status);
  if (state.filter !== 'all' && state.filter !== g) return;

  const tb = $('results').tBodies[0];
  const tr = document.createElement('tr');
  tr.dataset.group = g;
  tr.innerHTML = `
    <td>${escapeHtml(String(rec.excelRow || ''))}</td>
    <td>${escapeHtml(rec.productId || '—')}</td>
    <td class="name">${escapeHtml(rec.productName || rec.templateLabel || '—')}</td>
    <td><span class="tag ${TAG_CLASS[g]}">${LABELS[rec.status] || escapeHtml(rec.status)}</span></td>
    <td class="reason">${escapeHtml(rec.reason || '')}</td>
    <td>${escapeHtml(rec.matchedBy || '—')}</td>
    <td>${rec.price ? escapeHtml(String(rec.price)) : '—'}</td>`;
  tb.appendChild(tr);
}

function updateLiveStats() {
  const c = { saved: 0, skipped: 0, not_found: 0, failed: 0 };
  for (const r of state.results) c[group(r.status)]++;
  $('stats').classList.remove('hidden');
  $('s-saved').textContent = c.saved;
  $('s-skipped').textContent = c.skipped;
  $('s-notfound').textContent = c.not_found;
  $('s-failed').textContent = c.failed;
}

function applyState(job) {
  // التقدّم
  if (job.progress && job.progress.total) {
    const pct = 25 + Math.round((job.progress.current / job.progress.total) * 75);
    $('bar-fill').style.width = Math.min(pct, 100) + '%';
  }

  // النتائج (في حال فتحنا الصفحة بعد الانتهاء)
  if (job.results && job.results.length > state.results.length) {
    state.results = job.results;
    rerenderTable();
    updateLiveStats();
    $('results-head').classList.remove('hidden');
    $('table-wrap').classList.remove('hidden');
  }

  if (job.status === 'running' || job.status === 'queued') return;

  // ---- الانتهاء ----
  $('bar-fill').style.width = '100%';
  $('cancel-btn').classList.add('hidden');
  $('final-actions').classList.remove('hidden');
  $('logbox').open = false;

  const su = job.summary || {};
  const titles = {
    done: job.dryRun ? 'انتهت المعاينة ✓' : 'انتهى التسجيل ✓',
    cancelled: 'تم إلغاء العملية',
    failed: 'فشلت العملية',
  };
  $('prog-title').textContent = titles[job.status] || 'انتهت العملية';

  if (job.status === 'failed' && job.error) {
    $('phase-text').innerHTML = `<span style="color:var(--bad)">${escapeHtml(job.error.message)}</span>`;
  } else {
    $('phase-text').textContent =
      `من ${su.total || 0} صف: ${su.saved || 0} ${job.dryRun ? 'جاهز' : 'مسجّل'}`
      + `، ${su.skipped || 0} سابقاً، ${su.notFound || 0} غير موجود، ${su.failed || 0} فشل`
      + ` — المدة ${su.elapsedSeconds || 0} ثانية`;
  }

  // استهلاك السيرفر — يوضّح للمستخدم أننا كنا لطفاء
  const u = job.usage;
  if (u) {
    $('usage').classList.remove('hidden');
    $('usage').innerHTML =
      '<b>استهلاك سيرفر يلا تاجر:</b> '
      + `${u.requests || 0} طلب مُرسل`
      + ` · <b>${u.cachedHits || 0}</b> طلب وُفّر بالذاكرة المؤقتة`
      + (u.circuitTrips ? ` · ${u.circuitTrips} توقّف حماية` : '')
      + (u.failures ? ` · ${u.failures} محاولة فاشلة` : '')
      + ` · انتظار منظّم ${u.waitedSeconds || 0} ثانية`;
  }
}

function rerenderTable() {
  $('results').tBodies[0].innerHTML = '';
  for (const r of state.results) renderRow(r);
}

/* ---------------------------------------------------- الفلاتر والأزرار */

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filter = btn.dataset.f;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
  rerenderTable();
});

$('cancel-btn').addEventListener('click', async () => {
  if (!state.jobId) return;
  $('cancel-btn').disabled = true;
  try { await api(`/api/job/${state.jobId}/cancel`, { method: 'POST' }); } catch { /* ignore */ }
});

$('report-btn').addEventListener('click', async () => {
  if (!state.jobId) return;
  try {
    const res = await fetch(`/api/job/${state.jobId}/report`);
    if (!res.ok) throw new Error('تعذّر تنزيل التقرير');
    triggerDownload(await res.blob(), `yalla-report-${state.jobId}.xlsx`);
  } catch (err) {
    alert(err.message);
  }
});

$('again-btn').addEventListener('click', () => {
  if (state.es) state.es.close();
  state.file = null;
  state.jobId = null;
  fileInput.value = '';
  $('file-name').textContent = 'لم يتم اختيار ملف';
  drop.classList.remove('has');
  $('run-btn').disabled = true;
  msg('run-msg', '');
  showPanel(3);
});
