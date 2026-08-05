'use strict';
/**
 * مُشغِّل المهام (Job Runner) — يدير عملية تسجيل كاملة مع بثّ التقدّم.
 * ==================================================================
 *
 * خطة تقليل الطلبات على سيرفر يلا تاجر
 * -------------------------------------
 * الباك إند يبحث في الـ SKU أيضاً (وليس في نص القالب فقط)، لكنه لا يعرض
 * الـ SKU في نتائج البحث. لذلك نستخدم استراتيجية هجينة **تكيّفية**:
 *
 *   • ملف صغير (أقل من INDEX_THRESHOLD صف):
 *       بحث شبكي مستهدف لكل صف — أرخص من جلب فهرس فئة فيها آلاف القوالب.
 *
 *   • ملف كبير:
 *       نجلب فهرس الفئة **مرة واحدة** (صفحات بحجم 200) ونطابق كل الصفوف
 *       محلياً بالذاكرة بصفر طلبات، ثم بحث شبكي مستهدف للصفوف المتبقية فقط.
 *
 * كل الطلبات تمرّ عبر Throttle: طلب واحد في اللحظة + فاصل زمني + كاش
 * + قاطع دائرة. أي 429 أو خطأ متكرر يوقف العملية مؤقتاً تلقائياً.
 */

const { YallaClient, YallaApiError } = require('./api');
const { Throttle } = require('./throttle');
const { SubmissionState } = require('./state');
const { readTemplateRows } = require('./template');
const { buildCategoryIndex, matchRowLocally, buildPayload, reasonFor, REASONS } = require('./engine');

/** الحد الذي بعده يصبح جلب الفهرس أرخص من البحث لكل صف */
const INDEX_THRESHOLD = 12;

/** حالات الصف */
const STATUS = {
  SAVED: 'saved',
  ALREADY_PUBLISHED: 'already_published',
  ALREADY_SUBMITTED: 'already_submitted',
  NOT_FOUND: 'not_found',
  NO_PRICE: 'no_price',
  MISSING_KEY: 'missing_key',
  SAVE_FAILED: 'save_failed',
  ERROR: 'error',
};

let jobSeq = 0;

class Job {
  /**
   * @param {object} o
   * @param {string} o.email
   * @param {string} o.password
   * @param {number} o.categoryId
   * @param {string} o.categoryName
   * @param {Buffer} o.fileBuffer   ملف الإكسل المرفوع
   * @param {boolean} [o.dryRun]
   * @param {SubmissionState} [o.state]
   */
  constructor(o) {
    this.id = `job_${Date.now()}_${++jobSeq}`;
    this.email = o.email;
    this.password = o.password;
    this.categoryId = Number(o.categoryId);
    this.categoryName = o.categoryName || '';
    this.fileBuffer = o.fileBuffer;
    this.dryRun = !!o.dryRun;
    this.state = o.state || null;

    this.status = 'queued';          // queued | running | done | failed | cancelled
    this.phase = '';
    this.createdAt = new Date().toISOString();
    this.finishedAt = null;
    this.error = null;
    this.cancelled = false;

    this.rows = [];
    this.results = [];
    this.events = [];                // سجل الأحداث للبثّ (SSE)
    this._listeners = new Set();
    this.progress = { current: 0, total: 0 };
    this.summary = null;
    this.usage = null;

    // إعدادات لطيفة على السيرفر
    this.throttle = new Throttle({
      minIntervalMs: 1100,
      maxIntervalMs: 10000,
      jitterMs: 500,
      failureThreshold: 4,
      cooldownMs: 25000,
      cacheTtlMs: 15 * 60 * 1000,
      onWait: ({ reason, ms }) => {
        if (reason === 'circuit-trip') {
          this.emit('warn', `توقّف مؤقت ${Math.ceil(ms / 1000)} ثانية لحماية سيرفر يلا تاجر من الإجهاد`);
        }
      },
    });
  }

  // ---------------------------------------------------------------- الأحداث

  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type, message, data = null) {
    const ev = { seq: this.events.length + 1, at: Date.now(), type, message, data };
    this.events.push(ev);
    if (this.events.length > 2000) this.events.splice(0, 500);
    for (const fn of this._listeners) {
      try { fn(ev); } catch { /* لا نُسقط المهمة بسبب مستمع */ }
    }
  }

  cancel() {
    this.cancelled = true;
    this.emit('warn', 'تم طلب إلغاء العملية — سنتوقّف بعد الصف الحالي');
  }

  _checkCancel() {
    if (this.cancelled) {
      const e = new Error('CANCELLED');
      e.cancelled = true;
      throw e;
    }
  }

  /** لقطة كاملة للحالة (للواجهة) */
  snapshot() {
    return {
      id: this.id,
      status: this.status,
      phase: this.phase,
      progress: this.progress,
      categoryId: this.categoryId,
      categoryName: this.categoryName,
      dryRun: this.dryRun,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      error: this.error,
      summary: this.summary,
      usage: this.usage || (this.client ? this.client.usage : null),
      results: this.results,
      totalRows: this.rows.length,
    };
  }

  // ---------------------------------------------------------------- التشغيل

  async run() {
    this.status = 'running';
    const t0 = Date.now();
    try {
      await this._run();
      this.status = this.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      if (err && err.cancelled) {
        this.status = 'cancelled';
        this.emit('warn', 'تم إلغاء العملية');
      } else {
        this.status = 'failed';
        this.error = { message: err.message, code: err.code || null };
        this.emit('fail', err.message);
      }
    } finally {
      this.finishedAt = new Date().toISOString();
      this.usage = this.client ? this.client.usage : null;
      this._buildSummary(Date.now() - t0);
      this.emit('done', 'انتهت العملية', { summary: this.summary, usage: this.usage });
    }
    return this.snapshot();
  }

  async _run() {
    // ---------- 1) قراءة الملف ----------
    this.phase = 'read';
    this.emit('phase', 'قراءة ملف الإكسل…');
    const { rows, warnings } = readTemplateRows(this.fileBuffer);
    for (const w of warnings) this.emit('warn', w);
    if (!rows.length) throw new Error('الملف لا يحتوي أي صف صالح. تأكّد من ملء عمود الكود أو الاسم.');
    this.rows = rows;
    this.progress = { current: 0, total: rows.length };
    this.emit('ok', `تم قراءة ${rows.length} صف من الملف`);

    // تحذير مبكر للصفوف بلا سعر
    const noPrice = rows.filter((r) => !r.price).length;
    if (noPrice) {
      this.emit('warn', `${noPrice} صف بدون سعر — سنحاول استخدام سعر الموقع، وإلا سيُرفض`);
    }

    // ---------- 2) تسجيل الدخول ----------
    this._checkCancel();
    this.phase = 'login';
    this.emit('phase', 'تسجيل الدخول إلى يلا تاجر…');
    this.client = new YallaClient({
      throttle: this.throttle,
      logger: (m) => this.emit('log', m),
    });
    await this.client.login(this.email, this.password);
    const acc = await this.client.getAccountData();
    const name = ((acc.account_data && acc.account_data.full_name) || this.email).trim();
    this.emit('ok', `تم تسجيل الدخول — ${name}`);

    // ---------- 3) التحقق من حساب التاجر ----------
    this._checkCancel();
    const form = await this.client.getSellerFormData();
    if (!form.is_vendor) throw new Error('هذا الحساب ليس حساب تاجر (Vendor) — لا يمكن إضافة منتجات');
    if (!form.is_approved) this.emit('warn', 'حساب التاجر غير معتمد بعد — قد تُرفض الإضافات');
    const sellerGroups = await this.client.getCustomerGroups();
    if (!sellerGroups.length) throw new Error('لا توجد مجموعات تسعير متاحة لحسابك — تعذّر بناء سعر الجملة');
    this.emit('ok', `حساب تاجر معتمد (#${form.vendor_id}) — مجموعات التسعير: ${sellerGroups.map((g) => g.label).join('، ')}`);

    // ---------- 4) منع التكرار ----------
    this._checkCancel();
    let publishedIds = new Set();
    if (!this.dryRun) {
      this.phase = 'dedup';
      this.emit('phase', 'جلب منتجاتك المسجّلة لمنع التكرار…');
      try {
        publishedIds = await this.client.getPublishedTemplateIds();
        this.emit('ok', `${publishedIds.size} منتج مسجّل بحسابك — لن نكرّرها`);
      } catch (err) {
        this.emit('warn', `تعذّر جلب المنتجات المسجّلة (${err.message}) — سنعتمد على السجل المحلي`);
      }
    }

    // ---------- 5) المطابقة (الاستراتيجية التكيّفية) ----------
    this._checkCancel();
    let index = null;
    const useIndex = rows.length >= INDEX_THRESHOLD;
    if (useIndex) {
      this.phase = 'index';
      this.emit('phase', `جلب فهرس الفئة "${this.categoryName}" مرة واحدة (لتقليل الطلبات)…`);
      try {
        index = await buildCategoryIndex(this.client, this.categoryId, {
          pageSize: 200,
          maxPages: 60,
          onProgress: ({ page, pages, loaded }) =>
            this.emit('index', `تحميل الفهرس: صفحة ${page}/${pages} — ${loaded} منتج`, { page, pages, loaded }),
        });
        this.emit('ok', `الفهرس جاهز: ${index.count} منتج — المطابقة الآن محلية بصفر طلبات`
          + (index.truncated ? ' (تم بلوغ سقف الصفحات)' : ''));
      } catch (err) {
        this.emit('warn', `تعذّر بناء الفهرس (${err.message}) — سنستخدم البحث المستهدف`);
        index = null;
      }
    } else {
      this.emit('log', `عدد الصفوف قليل (${rows.length}) — سنستخدم البحث المستهدف فقط، وهو أوفر للسيرفر`);
    }

    // ---------- 6) معالجة الصفوف ----------
    this.phase = 'process';
    this.emit('phase', `معالجة ${rows.length} صف…`);

    const seenTemplates = new Set(); // منع التكرار داخل نفس الملف

    for (let i = 0; i < rows.length; i++) {
      this._checkCancel();
      const row = rows[i];
      this.progress = { current: i + 1, total: rows.length };

      const rec = {
        excelRow: row.excelRow,
        productId: row.productId,
        productName: row.productName,
        price: row.price,
        groupPrice: row.groupPrice,
        quantity: row.quantity,
        status: 'pending',
        reason: '',
        templateId: null,
        templateLabel: null,
        matchedBy: null,
        matchMethod: null,
      };

      this.emit('row-start', `[${i + 1}/${rows.length}] ${row.label}`, { excelRow: row.excelRow });

      try {
        if (!row.productId && !row.productName) {
          rec.status = STATUS.MISSING_KEY;
          rec.reason = REASONS.missing_key;
          this._pushRow(rec);
          continue;
        }

        // ---- المطابقة ----
        const match = await this._findTemplate(row, index);
        if (!match.template) {
          rec.status = STATUS.NOT_FOUND;
          if (match.ambiguous && match.ambiguous.length) {
            // لم نخمّن عمداً — نعرض المرشّحين ليختار المستخدم بدقة
            const names = match.ambiguous.slice(0, 3).map((c) => `«${c.label}»`).join(' ، ');
            rec.reason = `وُجدت نتائج متشابهة ولم نستطع التأكّد من الصحيح، فلم نسجّل شيئاً تجنّباً للخطأ. `
              + `المرشّحون: ${names}. ضع الكود الكامل أو الاسم كما هو في الموقع بالضبط.`;
            rec.candidates = match.ambiguous.slice(0, 5).map((c) => ({ id: c.id, label: c.label }));
          } else if (match.suggestion) {
            rec.reason = `لم يُعثر على تطابق مؤكّد. أقرب نتيجة: «${match.suggestion.label}» — عدّل الاسم أو استخدم الكود`;
            rec.suggestion = { id: match.suggestion.id, label: match.suggestion.label };
          } else {
            rec.reason = REASONS.not_found;
          }
          this._pushRow(rec);
          continue;
        }

        const templateId = String(match.template.id || match.template.value);
        rec.templateId = templateId;
        rec.templateLabel = match.template.label;
        rec.matchedBy = match.matchedBy === 'name' ? 'الاسم' : 'الكود';
        rec.matchMethod = match.method;
        if (match.similarity) rec.similarity = match.similarity;

        // ---- منع التكرار ----
        if (seenTemplates.has(templateId)) {
          rec.status = STATUS.ALREADY_SUBMITTED;
          rec.reason = 'مكرّر داخل نفس الملف — سُجّل في صف سابق';
          this._pushRow(rec);
          continue;
        }
        if (!this.dryRun && publishedIds.has(templateId)) {
          rec.status = STATUS.ALREADY_PUBLISHED;
          rec.reason = REASONS.already_published;
          this._pushRow(rec);
          continue;
        }
        if (!this.dryRun && this.state && this.state.has(templateId)) {
          const prev = this.state.get(templateId);
          rec.status = STATUS.ALREADY_SUBMITTED;
          rec.reason = `أُرسل طلب لهذا المنتج بتاريخ ${(prev.submittedAt || '').slice(0, 10)} — لم نكرّره`;
          this._pushRow(rec);
          continue;
        }

        // ---- بيانات القالب ----
        const tpl = await this.client.getTemplateData(templateId);
        if (!tpl) throw new YallaApiError('تعذّر جلب بيانات المنتج من الموقع');
        rec.sku = (tpl.product && tpl.product.sku) || null;
        rec.sitePrice = (tpl.product && tpl.product.price) || null;

        // ---- المعاينة ----
        if (this.dryRun) {
          if (!row.price && !rec.sitePrice) {
            rec.status = STATUS.NO_PRICE;
            rec.reason = REASONS.no_price;
          } else {
            rec.status = STATUS.SAVED;
            rec.reason = 'معاينة: جاهز للتسجيل';
            rec.dryRun = true;
          }
          seenTemplates.add(templateId);
          this._pushRow(rec);
          continue;
        }

        // ---- الحفظ الفعلي ----
        let built;
        try {
          built = buildPayload({ templateId, tpl, row, sellerGroups });
        } catch (err) {
          rec.status = STATUS.NO_PRICE;
          rec.reason = err.message;
          this._pushRow(rec);
          continue;
        }
        rec.price = built.price;
        rec.groupPrice = built.groupPrice;

        const saved = await this.client.saveProduct(built.payload);
        if (saved && saved.success === true) {
          const obj = saved.object || {};
          rec.requestId = obj.entity_id || null;
          rec.needApproval = !!saved.need_approval;
          rec.status = STATUS.SAVED;
          rec.reason = rec.needApproval
            ? `تم التسجيل ✓ طلب #${rec.requestId || '—'} — بانتظار موافقة الإدارة`
            : `تم التسجيل ✓ طلب #${rec.requestId || '—'}`;
          seenTemplates.add(templateId);
          if (this.state) {
            this.state.add(templateId, {
              sku: rec.sku, productId: row.productId, productName: row.productName,
              requestId: rec.requestId, price: built.price, groupPrice: built.groupPrice,
            });
          }
        } else {
          const e = (saved && saved.error) || {};
          rec.status = STATUS.SAVE_FAILED;
          rec.errorCode = e.code || null;
          rec.reason = this._explainError(e);
        }
      } catch (err) {
        if (err && err.cancelled) throw err;
        rec.status = STATUS.ERROR;
        rec.errorCode = err.code || null;
        rec.reason = err.message || REASONS.error;
      }
      this._pushRow(rec);
    }
  }

  /** بحث القالب: محلياً من الفهرس أولاً، ثم بحث شبكي مستهدف */
  async _findTemplate(row, index) {
    // (أ) مطابقة محلية — صفر طلبات
    let weak = null;
    let localAmbiguous = null;
    if (index) {
      const local = matchRowLocally(index, row);
      if (local.template) return local;
      weak = local.suggestion || null;
      localAmbiguous = local.ambiguous || null;
    }

    // (ب) بحث شبكي مستهدف — الكود أولاً ثم الاسم (كما طلب المستخدم)
    const queries = [];
    if (row.productId) queries.push({ q: row.productId, by: 'id' });
    if (row.productName) queries.push({ q: row.productName, by: 'name' });

    for (const { q, by } of queries) {
      const res = await this.client.searchTemplates({
        query: q, categoryId: this.categoryId, page: 1, limit: 20,
      });
      if (res.templates && res.templates.length) {
        const picked = this._pick(res.templates, row, by);
        if (picked.template) {
          return {
            template: picked.template,
            method: by === 'id' ? 'api_id' : 'api_name',
            matchedBy: by,
            score: picked.score,
            candidates: picked.candidates,
          };
        }
        // نتائج موجودة لكن أيٌّ منها ليس تطابقاً موثوقاً ⇒ نُبلّغ بالغموض
        if (picked.ambiguous) {
          return { template: null, method: 'ambiguous', ambiguous: picked.ambiguous, suggestion: picked.ambiguous[0] };
        }
      }
      // لو الاسم طويل، نجرّب أول ٤ كلمات منه (بحث الباك إند حرفي نوعاً ما)
      if (by === 'name') {
        const short = String(q).split(/\s+/).slice(0, 4).join(' ');
        if (short && short !== q && short.length >= 6) {
          const res2 = await this.client.searchTemplates({
            query: short, categoryId: this.categoryId, page: 1, limit: 20,
          });
          if (res2.templates && res2.templates.length) {
            const p2 = this._pick(res2.templates, row, 'name');
            if (!p2.template) {
              return { template: null, method: 'ambiguous', ambiguous: p2.ambiguous || null,
                suggestion: (p2.ambiguous && p2.ambiguous[0]) || null };
            }
            const ranked = p2.candidates;
            return {
              template: p2.template,
              method: 'api_name_partial',
              matchedBy: 'name',
              score: 65,
              candidates: ranked.slice(0, 5),
            };
          }
        }
      }
    }

    return { template: null, method: 'none', suggestion: weak, ambiguous: localAmbiguous };
  }

  /**
   * اختيار النتيجة الصحيحة من نتائج البحث الشبكي — بصرامة.
   *
   * ⚠️ الخطر الذي يعالجه هذا التابع (مرصود فعلياً على الموقع):
   *    البحث عن "SN-33" يُرجّع أربع نتائج:
   *      SN-333 (شاحن سيارة 30 وات)
   *      SN-336 (شاحن سيارة 45 وات)
   *      SN-338 (شاحن سيارة 68 وات)
   *      SN-33  (سماعة رأس)          ← الصحيح، وهو الأخير في الترتيب!
   *    لو أخذنا أول نتيجة أو استخدمنا الاحتواء، كنا سنسجّل منتجاً خطأ
   *    بسعر منتج آخر. لذلك:
   *      • مع الكود: نقبل **التطابق التام للكود** فقط.
   *      • مع الاسم: نقبل التطابق التام، أو نتيجة وحيدة، أو تشابه عالٍ.
   *      • غير ذلك ⇒ نرجّع "غامض" ونشرح للمستخدم بدل التخمين.
   *
   * @returns {{template:object|null, score:number, candidates:Array, ambiguous:Array|null}}
   */
  _pick(templates, row, by) {
    const { tightKey, extractCodes, normText } = require('./engine');
    const list = templates.map((t) => ({
      id: String(t.value),
      label: String(t.label || ''),
      tight: tightKey(t.label || ''),
      codes: extractCodes(t.label || ''),
    }));

    // ---------- (أ) المطابقة بالكود: تطابق تام إجبارياً ----------
    if (by === 'id' && row.productId) {
      const want = String(row.productId).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const exact = list.filter((e) => e.codes.has(want));
      if (exact.length === 1) return { template: exact[0], score: 100, candidates: exact, ambiguous: null };
      if (exact.length > 1) {
        // عدة قوالب بنفس الكود (نسخ مكرّرة على الموقع) — نأخذ الأحدث (أكبر id)
        exact.sort((a, b) => Number(b.id) - Number(a.id));
        return { template: exact[0], score: 95, candidates: exact, ambiguous: null };
      }

      // باركود رقمي طويل: مميّز بطبيعته فيُسمح بالاحتواء
      const digits = String(row.productId).replace(/\D/g, '');
      if (digits.length >= 8) {
        const hit = list.filter((e) => e.tight.includes(digits));
        if (hit.length === 1) return { template: hit[0], score: 88, candidates: hit, ambiguous: null };
      }

      // نتيجة وحيدة فقط ⇒ نقبلها بثقة أقل (الباك إند بحث في SKU غالباً)
      if (list.length === 1) return { template: list[0], score: 70, candidates: list, ambiguous: null };

      // لا تطابق موثوق ⇒ غامض، لا نخمّن
      return { template: null, score: 0, candidates: list, ambiguous: list.slice(0, 5) };
    }

    // ---------- (ب) المطابقة بالاسم ----------
    const nameK = tightKey(row.productName || '');
    if (nameK) {
      const exact = list.filter((e) => e.tight === nameK);
      if (exact.length) return { template: exact[0], score: 95, candidates: exact, ambiguous: null };
    }

    if (list.length === 1) return { template: list[0], score: 75, candidates: list, ambiguous: null };

    // تشابه كلمات — نطلب فارقاً واضحاً عن المرشّح الثاني
    if (row.productName) {
      const want = new Set(normText(row.productName).split(' ').filter((t) => t.length >= 2));
      const scored = list.map((e) => {
        const has = new Set(normText(e.label).split(' ').filter((t) => t.length >= 2));
        let inter = 0;
        for (const t of want) if (has.has(t)) inter++;
        return { e, sim: inter / (want.size + has.size - inter || 1) };
      }).sort((a, b) => b.sim - a.sim);

      // تطابق جيد ومتميّز عن التالي
      if (scored[0] && scored[0].sim >= 0.55
          && (!scored[1] || scored[0].sim - scored[1].sim >= 0.12)) {
        return { template: scored[0].e, score: Math.round(scored[0].sim * 90),
          candidates: scored.slice(0, 5).map((s) => s.e), ambiguous: null };
      }
      return { template: null, score: 0, candidates: list.slice(0, 5),
        ambiguous: scored.slice(0, 5).map((s) => s.e) };
    }

    return { template: null, score: 0, candidates: list, ambiguous: list.slice(0, 5) };
  }

  /** ترجمة أخطاء الباك إند إلى سبب مفهوم */
  _explainError(e) {
    const code = e.code || '';
    const msg = e.message || 'رفض غير محدّد';
    const map = {
      marketplace_seller_133: 'الموقع يطلب سعر البيع وسعر الجملة معاً — تأكّد من ملء العمودين',
      marketplace_seller_108: 'تعذّر تحميل بيانات التاجر — أعد المحاولة',
      marketplace_sellerproduct_100: 'مشكلة مؤقتة في تحميل المنتجات — أعد المحاولة لاحقاً',
    };
    return map[code] ? `${map[code]}` : `${msg}${code ? ` (${code})` : ''}`;
  }

  _pushRow(rec) {
    if (!rec.reason) rec.reason = reasonFor(rec);
    this.results.push(rec);
    this.emit('row', rec.reason, rec);
  }

  _buildSummary(elapsedMs) {
    const by = (s) => this.results.filter((r) => r.status === s).length;
    const saved = by(STATUS.SAVED);
    const skipped = by(STATUS.ALREADY_PUBLISHED) + by(STATUS.ALREADY_SUBMITTED);
    const notFound = by(STATUS.NOT_FOUND);
    const failed = by(STATUS.SAVE_FAILED) + by(STATUS.ERROR) + by(STATUS.NO_PRICE) + by(STATUS.MISSING_KEY);
    this.summary = {
      total: this.rows.length,
      processed: this.results.length,
      saved, skipped, notFound, failed,
      dryRun: this.dryRun,
      elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    };
  }
}

module.exports = { Job, STATUS, INDEX_THRESHOLD };
