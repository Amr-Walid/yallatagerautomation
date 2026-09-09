'use strict';
/**
 * محرّك التسجيل — يقرأ صفوف التيمبليت ويسجّل المنتجات.
 * ============================================================
 *
 * استراتيجية "الفهرسة مرة واحدة" (أهم قرار تصميمي هنا)
 * -----------------------------------------------------
 * السكربت القديم كان يعمل بحثاً شبكياً لكل صف × كل فئة:
 *      16 صف × 2 استعلام × 4 فئات = حتى 128 طلب بحث
 * وده إجهاد كبير للسيرفر بلا داعٍ.
 *
 * الطريقة الجديدة: نجلب **فهرس الفئة كاملاً مرة واحدة** عبر
 * searchTemplates({query:'', limit:200}) — الباك إند يرجّع كل قوالب
 * الفئة مقسّمة على صفحات — ثم نطابق كل الصفوف **محلياً في الذاكرة**
 * بدون أي طلب شبكة إضافي.
 *
 *      فئة فيها 7400 قالب = 37 طلب فقط، ثم أي عدد صفوف = 0 طلب بحث.
 *
 * فوائد إضافية:
 *   • المطابقة المحلية أذكى بكثير من بحث الباك إند النصي: نقدر نطابق
 *     تطابقاً تاماً، ثم جزئياً، ثم "تشابه رموز" — وده بيرفع نسبة
 *     الإيجاد بدل ما نضرب طلبات كتير على السيرفر.
 *   • الفهرس يُخزَّن في كاش الـ Throttle، فأي تشغيل تانٍ خلال 10 دقائق
 *     = صفر طلبات بحث.
 *   • البحث الشبكي المستهدف يُستخدم فقط كخطة أخيرة (fallback) لصفوف
 *     قليلة لم تُطابق محلياً.
 */

const { YallaApiError } = require('./api');

// ------------------------------------------------------------- أدوات التطبيع

/** تطبيع نص للمطابقة: توحيد الحروف العربية، إزالة التشكيل والرموز */
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')  // التشكيل
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')       // أي رمز → مسافة
    .trim()
    .replace(/\s+/g, ' ');
}

/** مفتاح صارم: حروف وأرقام فقط بلا مسافات (للتطابق التام) */
function tightKey(s) {
  return normText(s).replace(/\s+/g, '');
}

/** استخراج "الرموز المميزة" — الأكواد مثل SN-397 أو OEB-104D أو أرقام طويلة */
function extractCodes(s) {
  const out = new Set();
  const text = String(s || '').toUpperCase();
  // نمط كود: حروف + شرطة/مسافة + أرقام (مع لاحقة حروف اختيارية)
  const re = /\b([A-Z]{2,6})[\s\-_]?(\d{2,6}[A-Z]?)\b/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1] + m[2]);
  // أرقام طويلة (باركود)
  for (const num of text.match(/\d{6,}/g) || []) out.add(num);
  return out;
}

function tokens(s) {
  return normText(s).split(' ').filter((t) => t.length >= 2);
}

/**
 * تطبيع كود المنتج لمقارنة صارمة: SN-397 / sn 397 / SN397 ⇒ SN397
 */
function canonCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ⚠️ فحص صارم: هل يحتوي نص القالب على هذا الكود **بالضبط**؟
 *
 * ضروري جداً لتجنّب خطأ خطير رصدناه على الموقع فعلياً:
 * البحث عن "SN-33" يُرجّع "SN-333" و"SN-336" و"SN-338" — وكلها منتجات
 * مختلفة تماماً! الاعتماد على الاحتواء (substring) كان سيسجّل المنتج الخطأ.
 * لذلك نقارن مع مجموعة الأكواد المستخرجة، لا مع النص كسلسلة.
 */
function hasExactCode(label, code) {
  const c = canonCode(code);
  if (!c) return false;
  const codes = label instanceof Set ? label : extractCodes(label);
  return codes.has(c);
}

// ------------------------------------------------------------- بناء الفهرس

/**
 * جلب فهرس الفئة كاملاً (كل الصفحات) — طلبات قليلة مرة واحدة.
 * @param {import('./api').YallaClient} client
 * @param {number} categoryId
 * @param {object} [o]
 * @param {number} [o.pageSize=200]
 * @param {number} [o.maxPages=60]  سقف أمان لحماية السيرفر
 * @param {function} [o.onProgress]
 */
async function buildCategoryIndex(client, categoryId, o = {}) {
  const pageSize = o.pageSize ?? 200;
  const maxPages = o.maxPages ?? 60;
  const budgetMs = o.budgetMs ?? 0; // 0 = بلا سقف زمني
  const onProgress = o.onProgress || (() => {});
  const startedAt = Date.now();

  const templates = [];
  let page = 1;
  let pages = 1;
  let truncated = false;
  let abandoned = false;

  do {
    const res = await client.searchTemplates({ query: '', categoryId, page, limit: pageSize });
    if (res.error && res.error.code && !res.templates.length && page === 1) {
      throw new YallaApiError(res.error.message || 'تعذر جلب قوالب الفئة', { code: res.error.code });
    }
    if (!res.templates.length) break;
    templates.push(...res.templates);
    pages = Number((res.pager && res.pager.pages) || 1);
    onProgress({ page, pages: Math.min(pages, maxPages), loaded: templates.length });

    // حرس زمني: الفئات الضخمة (صفحاتها بطيئة) لا يصحّ أن تُجمّد المهمة ساعات.
    // نقيس متوسط زمن الصفحة ونتخلّى عن الفهرسة مبكراً إن كان الباقي سيتجاوز الميزانية.
    if (budgetMs && page < pages) {
      const elapsed = Date.now() - startedAt;
      const avg = elapsed / page;
      if (elapsed + avg * (Math.min(pages, maxPages) - page) > budgetMs) {
        abandoned = true;
        break;
      }
    }

    if (page >= maxPages && page < pages) { truncated = true; break; }
    page++;
  } while (page <= pages);

  if (abandoned) {
    return { categoryId, abandoned: true, totalPages: pages, loadedPages: page, count: templates.length };
  }

  // خرائط بحث محلية سريعة
  const byTight = new Map();   // مفتاح صارم → قوالب
  const byCode = new Map();    // كود مستخرج → قوالب
  const byId = new Map();      // رقم القالب (template_id) → قالب
  const list = [];

  for (const t of templates) {
    const label = String(t.label || '');
    const entry = {
      id: String(t.value),
      label,
      norm: normText(label),
      tight: tightKey(label),
      codes: extractCodes(label),
      tokens: new Set(tokens(label)),
    };
    list.push(entry);

    if (!byTight.has(entry.tight)) byTight.set(entry.tight, []);
    byTight.get(entry.tight).push(entry);

    if (!byId.has(entry.id)) byId.set(entry.id, entry);

    for (const code of entry.codes) {
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(entry);
    }
  }

  return { categoryId, list, byTight, byCode, byId, count: list.length, truncated };
}

// ------------------------------------------------------------- المطابقة المحلية

/**
 * مطابقة صف مع الفهرس محلياً — بدون أي طلب شبكة.
 * الترتيب: تطابق كود تام ← احتواء الكود في النص ← تطابق تام للاسم
 *          ← احتواء ← تشابه كلمات.
 * @returns {{template:object|null, method:string, score:number, candidates:Array}}
 */
function matchRowLocally(index, row) {
  const idRaw = String(row.productId || '').trim();
  const nameRaw = String(row.productName || '').trim();

  // ---- 1) البحث بالكود (الأولوية العليا كما طلب المستخدم) ----
  if (idRaw) {
    const idCodes = extractCodes(idRaw);
    // الكود نفسه ككلمة واحدة (مثال SN-397 → SN397)
    const idTight = idRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (idTight) idCodes.add(idTight);

    // المستخدم قد يُدخل رقم القالب نفسه (template_id) — تطابق قاطع
    if (index.byId && index.byId.has(idTight)) {
      const hit = index.byId.get(idTight);
      return { template: hit, method: 'template_id', score: 98, candidates: [hit], matchedBy: 'id' };
    }

    for (const code of idCodes) {
      const hit = index.byCode.get(code);
      if (hit && hit.length) {
        return { template: hit[0], method: 'code_exact', score: 100, candidates: hit.slice(0, 5), matchedBy: 'id' };
      }
    }

    // ⚠️ لا نستخدم الاحتواء (substring) للأكواد إطلاقاً:
    // "SN-33" يحتويه "SN-333" و"SN-336" وهي منتجات مختلفة تماماً.
    // بدلاً منه: تطابق تام مع كود كامل فقط (تم فحصه أعلاه)،
    // ثم — لو الكود باركود طويل — نسمح بالاحتواء لأنه مميّز بطبيعته.
    // ⚠️ ولا نسمح بالاحتواء داخل النص كذلك: رصدنا فعلياً قالباً اسمه
    // «وش جى فينوس كيرف بكسل رقم (2)، 57002 - أسود» يظهر عند البحث بـ 57002
    // وهو منتج مختلف تماماً. لذلك نطلب الكود ضمن الأكواد المستخرجة فقط.
    const digitsOnly = idRaw.replace(/\D/g, '');
    if (digitsOnly.length >= 8) {
      const found = index.list.filter((e) => e.codes.has(digitsOnly));
      if (found.length === 1) {
        return { template: found[0], method: 'barcode_contains', score: 85, candidates: found, matchedBy: 'id' };
      }
      if (found.length > 1) {
        return { template: null, method: 'ambiguous', score: 0, candidates: found.slice(0, 5),
          ambiguous: found.slice(0, 5) };
      }
    }
  }

  // ---- 2) البحث بالاسم (خطة بديلة كما طلب المستخدم) ----
  if (nameRaw) {
    const nTight = tightKey(nameRaw);
    const exact = index.byTight.get(nTight);
    if (exact && exact.length) {
      return { template: exact[0], method: 'name_exact', score: 95, candidates: exact.slice(0, 5), matchedBy: 'name' };
    }

    if (nTight.length >= 5) {
      const contains = index.list.filter((e) => e.tight.includes(nTight) || nTight.includes(e.tight));
      if (contains.length) {
        contains.sort((a, b) => Math.abs(a.tight.length - nTight.length) - Math.abs(b.tight.length - nTight.length));
        return { template: contains[0], method: 'name_contains', score: 70, candidates: contains.slice(0, 5), matchedBy: 'name' };
      }
    }

    // تشابه الكلمات (Jaccard) — نطلب تشابهاً عالياً لتجنّب مطابقة خاطئة
    const nameTokens = new Set(tokens(nameRaw));
    if (nameTokens.size >= 2) {
      let best = null;
      let bestSim = 0;
      for (const e of index.list) {
        let inter = 0;
        for (const t of nameTokens) if (e.tokens.has(t)) inter++;
        if (!inter) continue;
        const sim = inter / (nameTokens.size + e.tokens.size - inter);
        if (sim > bestSim) { bestSim = sim; best = e; }
      }
      if (best && bestSim >= 0.6) {
        return {
          template: best, method: 'name_similar', score: Math.round(bestSim * 60),
          candidates: [best], matchedBy: 'name', similarity: Number(bestSim.toFixed(2)),
        };
      }
      // تشابه ضعيف → نرجّعه كـ "اقتراح" فقط بدون اعتماد
      if (best && bestSim >= 0.35) {
        return { template: null, method: 'weak', score: 0, candidates: [best], suggestion: best, similarity: Number(bestSim.toFixed(2)) };
      }
    }
  }

  return { template: null, method: 'none', score: 0, candidates: [] };
}

// ------------------------------------------------------------- بناء جسم الحفظ

/**
 * بناء جسم الحفظ من صف التيمبليت.
 * قواعد الباك إند: price + group_price إجباريان معاً، و group_price
 * تُبنى من getCustomerGroups() (المجموعة 2 = Wholesale).
 */
function buildPayload({ templateId, tpl, row, sellerGroups }) {
  const productData = {};
  for (const attr of Object.values(tpl.attributes || {})) {
    if (attr && attr.attribute_code) productData[attr.attribute_code] = attr.template_value;
  }

  const inventoryData = { backorders: '', quantity: '' };
  if (tpl.qty_editable && row.quantity) inventoryData.quantity = String(row.quantity);

  // السعر: من التيمبليت أولاً، وإلا سعر الموقع كخطة بديلة
  let price = row.price;
  if (!price) {
    const sitePrice = tpl.product && tpl.product.price;
    const n = Number(sitePrice);
    if (Number.isFinite(n) && n > 0) price = String(Math.round(n * 100) / 100);
  }
  if (!price) {
    throw new YallaApiError('لا يوجد سعر — املأ عمود "سعر البيع" في التيمبليت (الباك إند يرفض الحفظ بدون سعر)');
  }

  const groupPrice = row.groupPrice || price;

  const groupIds = (sellerGroups || []).map((g) => String(g.value)).filter(Boolean);
  if (!groupIds.length) {
    throw new YallaApiError('لا توجد مجموعات تسعير متاحة لحسابك — تعذّر بناء سعر الجملة');
  }

  const priceData = {
    price,
    group_price: groupIds.map((gid) => ({ cust_group: gid, price: groupPrice })),
    special_price: row.specialPrice || '',
    special_from_date: null,
    special_to_date: null,
  };

  return {
    payload: { templateId, productData, inventoryData, priceData, configurableInventoryData: {}, configurablePricesData: {} },
    price,
    groupPrice,
  };
}

// ------------------------------------------------------------- رسائل الأسباب

/** ترجمة حالة الصف إلى سبب مفهوم للمستخدم */
const REASONS = {
  saved: 'تم التسجيل بنجاح — بانتظار موافقة الإدارة',
  already_published: 'المنتج مُسجّل بالفعل في حسابك (منشور)',
  already_submitted: 'أُرسل طلب لهذا المنتج من قبل — لم نكرّره',
  not_found: 'لم يُعثر على المنتج في الفئة المختارة — راجع الكود أو الاسم، أو جرّب فئة أخرى',
  no_price: 'عمود "سعر البيع" فارغ — الموقع يرفض التسجيل بدون سعر',
  missing_key: 'الصف لا يحتوي كوداً ولا اسماً',
  save_failed: 'الموقع رفض التسجيل',
  error: 'خطأ غير متوقع',
  skipped_limit: 'تم تخطيه لتجاوز الحد الأقصى للتشغيل الواحد',
};

function reasonFor(rec) {
  if (rec.reason) return rec.reason;
  return REASONS[rec.status] || rec.status;
}

module.exports = {
  buildCategoryIndex,
  matchRowLocally,
  buildPayload,
  normText,
  tightKey,
  extractCodes,
  REASONS,
  reasonFor,
};
