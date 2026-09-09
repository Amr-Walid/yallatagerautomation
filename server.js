#!/usr/bin/env node
'use strict';
/**
 * ================================================================
 *  يلا تاجر — ويب أبلكيشن تسجيل المنتجات
 * ================================================================
 * سيرفر HTTP بلا أي إطار خارجي (Node core فقط) — الاعتماد الوحيد xlsx.
 *
 * المسارات:
 *   GET  /                       الواجهة
 *   POST /api/login              تحقق من بيانات التاجر + إرجاع الفئات
 *   POST /api/template           تنزيل تيمبليت الإكسل للفئة المختارة
 *   POST /api/run                بدء عملية التسجيل (رفع الملف)
 *   GET  /api/job/:id/stream     بثّ التقدّم المباشر (SSE)
 *   GET  /api/job/:id            حالة/نتيجة العملية
 *   POST /api/job/:id/cancel     إلغاء
 *   GET  /api/job/:id/report     تنزيل تقرير النتائج كإكسل
 *
 * حماية سيرفر يلا تاجر:
 *   • كل الطلبات تمرّ عبر Throttle (طابور + فاصل + كاش + قاطع دائرة)
 *   • مهمة واحدة فقط قيد التشغيل لكل حساب في نفس الوقت
 *   • جلسات التحقق تُخزَّن مؤقتاً فلا نعيد تسجيل الدخول بلا داعٍ
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('xlsx');

const { YallaClient } = require('./lib/api');
const { Throttle } = require('./lib/throttle');
const { SubmissionState } = require('./lib/state');
const { buildTemplateWorkbook, COLUMNS } = require('./lib/template');
const { Job } = require('./lib/job');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 8 * 1024 * 1024; // 8MB
const SESSION_TTL = 30 * 60 * 1000; // 30 دقيقة

// ------------------------------------------------------------------- الحالة

/** جلسات المستخدمين: token → { email, password, categories, client, at } */
const sessions = new Map();
/** المهام: id → Job */
const jobs = new Map();
/** منع تشغيل أكثر من مهمة لنفس الحساب */
const activeByEmail = new Map();
/** سجل منع التكرار — مشترك لكل حساب */
const states = new Map();

function stateFor(email) {
  const key = email.toLowerCase();
  if (!states.has(key)) {
    const safe = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    states.set(key, new SubmissionState(path.join(dir, `submitted-${safe}.json`)));
  }
  return states.get(key);
}

/** تنظيف دوري للجلسات والمهام القديمة */
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(t);
  for (const [id, j] of jobs) {
    const end = j.finishedAt ? new Date(j.finishedAt).getTime() : now;
    if (j.status !== 'running' && now - end > 2 * 60 * 60 * 1000) jobs.delete(id);
  }
}, 60 * 1000).unref();

// ------------------------------------------------------------------- أدوات

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

const ok = (res, obj) => send(res, 200, { success: true, ...obj });
const bad = (res, status, message, extra = {}) => send(res, status, { success: false, message, ...extra });

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('حجم الملف كبير جداً (الحد ٨ ميجابايت)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 256);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('بيانات غير صالحة'), { status: 400 }); }
}

/** تحليل multipart/form-data بشكل مبسّط لكن سليم (يعمل على البيانات الثنائية) */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw Object.assign(new Error('صيغة الرفع غير مدعومة'), { status: 400 });
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());

  const fields = {};
  const files = {};
  let pos = buffer.indexOf(boundary);
  if (pos < 0) throw Object.assign(new Error('لم يُعثر على محتوى الرفع'), { status: 400 });
  pos += boundary.length;

  while (pos < buffer.length) {
    // نهاية الرسالة
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
    // تخطي CRLF
    if (buffer.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    const headEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buffer.slice(pos, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;

    let next = buffer.indexOf(boundary, bodyStart);
    if (next < 0) next = buffer.length;
    // استبعاد CRLF قبل الحد الفاصل
    let bodyEnd = next;
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2;

    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const name = nameM ? nameM[1] : null;

    if (name) {
      if (fileM && fileM[1]) {
        files[name] = { filename: fileM[1], data: buffer.slice(bodyStart, bodyEnd) };
      } else {
        fields[name] = buffer.slice(bodyStart, bodyEnd).toString('utf8');
      }
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function requireSession(body, req) {
  // التوكن يُقبل من جسم الطلب أو من ترويسة Authorization: Bearer <token>
  let token = body && body.token;
  if (!token && req && req.headers && req.headers.authorization) {
    token = String(req.headers.authorization).replace(/^Bearer\s+/i, '').trim();
  }
  const s = sessions.get(token);
  if (!s) throw Object.assign(new Error('انتهت الجلسة — سجّل الدخول من جديد'), { status: 401 });
  s.at = Date.now();
  return s;
}

// ------------------------------------------------------------------- المسارات

/** POST /api/login — تحقق + جلب الفئات */
async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email || !password) return bad(res, 400, 'البريد وكلمة المرور مطلوبان');

  // Throttle مخصص لهذه الجلسة — لطيف على السيرفر
  const throttle = new Throttle({ minIntervalMs: 900, cacheTtlMs: 20 * 60 * 1000 });
  const client = new YallaClient({ throttle });

  try {
    await client.login(email, password);
  } catch (err) {
    return bad(res, 401, err.message || 'فشل تسجيل الدخول — تأكّد من البريد وكلمة المرور');
  }

  let account = null;
  let vendor = null;
  try {
    const acc = await client.getAccountData();
    account = acc.account_data || null;
    vendor = await client.getSellerFormData();
  } catch (err) {
    return bad(res, 403, `تعذّر التحقق من حساب التاجر: ${err.message}`);
  }

  if (!vendor.is_vendor) {
    return bad(res, 403, 'هذا الحساب ليس حساب تاجر (Vendor) — لا يمكن إضافة منتجات');
  }

  let categories = [];
  try {
    const cats = await client.getCategories(2);
    categories = cats
      .map((c) => ({ id: Number(c.entity_id), name: String(c.name || '').trim() }))
      .filter((c) => c.id && c.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  } catch (err) {
    return bad(res, 502, `تعذّر جلب الفئات: ${err.message}`);
  }

  const token = newToken();
  sessions.set(token, { email, password, categories, client, at: Date.now() });

  return ok(res, {
    token,
    name: (account && account.full_name ? String(account.full_name).trim() : email),
    vendorId: vendor.vendor_id,
    approved: !!vendor.is_approved,
    categories,
    usage: client.usage,
  });
}

/** POST /api/template — بناء وتنزيل التيمبليت */
async function handleTemplate(req, res) {
  const body = await readJson(req);
  const s = requireSession(body, req);
  const categoryId = Number(body.categoryId);
  const cat = s.categories.find((c) => c.id === categoryId);
  if (!cat) return bad(res, 400, 'اختر فئة صحيحة من القائمة');

  // عيّنة صغيرة من منتجات الفئة لمساعدة المستخدم (طلب واحد فقط، ومن الكاش لاحقاً).
  // ملاحظة: تشغيل مهمة بنفس الحساب يُبطل كوكيز هذه الجلسة (الباك إند يسمح بجلسة
  // واحدة)، لذلك نُعيد تسجيل الدخول مرة واحدة عند الحاجة بدل أن نفقد العيّنة.
  let samples = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await s.client.searchTemplates({ query: '', categoryId, page: 1, limit: 25 });
      samples = (r.templates || []).slice(0, 25).map((t) => ({ name: t.label, templateId: t.value }));
      if (samples.length || attempt === 2) break;
      // نتيجة فارغة غالباً = جلسة منتهية ⇒ نجدّد الدخول ونعيد المحاولة
      await s.client.login(s.email, s.password);
    } catch {
      if (attempt === 2) break;
      try { await s.client.login(s.email, s.password); } catch { break; }
    }
  }

  const buf = buildTemplateWorkbook({ categoryName: cat.name, categoryId, samples });
  const fname = `yalla-template-${categoryId}.xlsx`;
  return send(res, 200, buf, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'Content-Length': buf.length,
  });
}

/** POST /api/run — بدء المهمة */
async function handleRun(req, res) {
  const raw = await readBody(req);
  const { fields, files } = parseMultipart(raw, req.headers['content-type']);
  const s = requireSession(fields, req);

  const categoryId = Number(fields.categoryId);
  const cat = s.categories.find((c) => c.id === categoryId);
  if (!cat) return bad(res, 400, 'اختر فئة صحيحة من القائمة');

  const file = files.file;
  if (!file || !file.data || !file.data.length) return bad(res, 400, 'أرفق ملف الإكسل المملوء');
  if (!/\.xlsx?$/i.test(file.filename)) return bad(res, 400, 'الملف يجب أن يكون بصيغة .xlsx');

  if (activeByEmail.has(s.email.toLowerCase())) {
    const prev = activeByEmail.get(s.email.toLowerCase());
    return bad(res, 409, 'هناك عملية جارية بالفعل لهذا الحساب — انتظر انتهاءها', { jobId: prev });
  }

  const job = new Job({
    email: s.email,
    password: s.password,
    categoryId,
    categoryName: cat.name,
    fileBuffer: file.data,
    dryRun: String(fields.dryRun || '') === 'true',
    state: stateFor(s.email),
  });
  jobs.set(job.id, job);
  activeByEmail.set(s.email.toLowerCase(), job.id);

  job.run().finally(() => {
    activeByEmail.delete(s.email.toLowerCase());
  });

  return ok(res, { jobId: job.id, dryRun: job.dryRun, categoryName: cat.name });
}

/** GET /api/job/:id/stream — بثّ مباشر */
function handleStream(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return bad(res, 404, 'العملية غير موجودة');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (ev) => {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* اتصال مقطوع */ }
  };

  // إعادة إرسال الأحداث السابقة حتى لا يفوت المستخدم شيئاً
  for (const ev of job.events) write(ev);
  write({ type: 'state', message: '', data: job.snapshot() });

  const off = job.onEvent((ev) => {
    write(ev);
    if (ev.type === 'done') {
      write({ type: 'state', message: '', data: job.snapshot() });
      setTimeout(() => { off(); res.end(); }, 150);
    }
  });

  // نبضة للحفاظ على الاتصال عبر البروكسي
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);

  // لو المهمة منتهية أصلاً
  if (job.status !== 'running' && job.status !== 'queued') {
    write({ type: 'state', message: '', data: job.snapshot() });
    setTimeout(() => { off(); clearInterval(beat); res.end(); }, 150);
  }

  req.on('close', () => { off(); clearInterval(beat); });
}

/** GET /api/job/:id/report — تقرير إكسل */
function handleReport(res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return bad(res, 404, 'العملية غير موجودة');

  const STATUS_AR = {
    saved: 'تم التسجيل',
    already_published: 'مسجّل سابقاً',
    already_submitted: 'أُرسل سابقاً',
    not_found: 'غير موجود',
    no_price: 'بدون سعر',
    missing_key: 'صف ناقص',
    save_failed: 'فشل التسجيل',
    error: 'خطأ',
  };

  const aoa = [[
    'صف الإكسل', 'كود المنتج', 'اسم المنتج', 'الحالة', 'السبب',
    'رقم القالب', 'اسم القالب في الموقع', 'طُوبق بواسطة',
    'سعر البيع', 'سعر الجملة', 'رقم الطلب',
  ]];
  for (const r of job.results) {
    aoa.push([
      r.excelRow, r.productId || '', r.productName || '',
      STATUS_AR[r.status] || r.status, r.reason || '',
      r.templateId || '', r.templateLabel || '', r.matchedBy || '',
      r.price || '', r.groupPrice || '', r.requestId || '',
    ]);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 36 }, { wch: 14 }, { wch: 60 },
    { wch: 12 }, { wch: 46 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];

  const su = job.summary || {};
  const usage = job.usage || {};
  const info = [
    ['تقرير تسجيل المنتجات — يلا تاجر'],
    ['الفئة', job.categoryName],
    ['وقت التشغيل', job.createdAt],
    ['وضع المعاينة', job.dryRun ? 'نعم' : 'لا'],
    [''],
    ['إجمالي الصفوف', su.total || 0],
    ['تم التسجيل', su.saved || 0],
    ['مسجّل سابقاً', su.skipped || 0],
    ['غير موجود', su.notFound || 0],
    ['فشل', su.failed || 0],
    ['المدة (ثانية)', su.elapsedSeconds || 0],
    [''],
    ['استهلاك سيرفر يلا تاجر'],
    ['عدد الطلبات المُرسلة', usage.requests || 0],
    ['طلبات وُفّرت بالذاكرة المؤقتة', usage.cachedHits || 0],
    ['توقّفات حماية', usage.circuitTrips || 0],
  ];
  const wsInfo = xlsx.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 34 }, { wch: 46 }];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'النتائج');
  xlsx.utils.book_append_sheet(wb, wsInfo, 'الملخص');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const fname = `yalla-report-${job.id}.xlsx`;
  return send(res, 200, buf, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fname}"`,
    'Content-Length': buf.length,
  });
}

/** ملفات ثابتة */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return bad(res, 403, 'ممنوع');
  fs.readFile(file, (err, data) => {
    if (err) return bad(res, 404, 'الصفحة غير موجودة');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ------------------------------------------------------------------- السيرفر

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'POST' && p === '/api/login') return await handleLogin(req, res);
    if (req.method === 'POST' && p === '/api/template') return await handleTemplate(req, res);
    if (req.method === 'POST' && p === '/api/run') return await handleRun(req, res);

    let m = /^\/api\/job\/([\w]+)\/stream$/.exec(p);
    if (req.method === 'GET' && m) return handleStream(req, res, m[1]);

    m = /^\/api\/job\/([\w]+)\/report$/.exec(p);
    if (req.method === 'GET' && m) return handleReport(res, m[1]);

    m = /^\/api\/job\/([\w]+)\/cancel$/.exec(p);
    if (req.method === 'POST' && m) {
      const job = jobs.get(m[1]);
      if (!job) return bad(res, 404, 'العملية غير موجودة');
      job.cancel();
      return ok(res, {});
    }

    m = /^\/api\/job\/([\w]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      if (!job) return bad(res, 404, 'العملية غير موجودة');
      return ok(res, { job: job.snapshot() });
    }

    if (req.method === 'GET' && p === '/api/columns') {
      return ok(res, { columns: COLUMNS.map((c) => ({ header: c.header, required: c.required, hint: c.hint })) });
    }

    if (req.method === 'GET') return serveStatic(res, p);
    return bad(res, 404, 'المسار غير موجود');
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) return bad(res, status, err.message || 'خطأ في السيرفر');
    try { res.end(); } catch { /* ignore */ }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  يلا تاجر — ويب أبلكيشن تسجيل المنتجات`);
  console.log(`  السيرفر يعمل على  http://0.0.0.0:${PORT}\n`);
});
