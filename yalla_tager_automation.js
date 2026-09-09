#!/usr/bin/env node
'use strict';
/**
 * ================================================================
 *  أتمتة "يلا تاجر" — إضافة منتجات البائع من ملف إكسل
 * ================================================================
 *
 *  لماذا لا نستخدم المتصفح (Playwright)؟
 *  ------------------------------------
 *  موقع yallatager.com مبني على Nuxt 3 مع SSR، وصفحات:
 *      /ar/account/login       -> 302 إلى /ar  (ثم 404 داخل الـ SPA)
 *      /ar/vendor/add-products -> 500 Server Error
 *  السبب خطأ في بناء الموقع نفسه:
 *      "Named export 'VueTelInput' not found. The requested module
 *       'vue3-tel-input' is a CommonJS module..."
 *  فلا توجد صفحة تسجيل دخول يمكن للمتصفح فتحها إطلاقاً، ولهذا كان
 *  السكربت القديم يفشل دائماً (كان يبحث عن #usernameemail في صفحة 404).
 *
 *  الحل: التعامل مع نفس الـ REST API الذي يستخدمه الموقع.
 *
 *  قواعد الحفظ المكتشفة بالتجربة على الباك إند:
 *    • `price` و `group_price` كلاهما إجباري، وإلا:
 *      marketplace_seller_133 "You must add group prices and validate price."
 *    • `group_price` تُبنى من getCustomerGroups() ⇒ المجموعة "2" (Wholesale)،
 *      وليس من template.customer_groups التي تحتوي أيضاً "Blacklist"/7.
 *    • الكمية اختيارية.
 *    • ⚠️ لا يوجد منع تكرار في الباك إند: كل نداء يُنشئ طلباً جديداً،
 *      ولا تظهر الطلبات المعلّقة في getproducts، لذلك نستخدم سجلاً محلياً
 *      (results/submitted.json) + الكتالوج المنشور معاً.
 *
 *  التشغيل:
 *      node yalla_tager_automation.js --dry-run       # بحث فقط بدون حفظ
 *      node yalla_tager_automation.js --price 1000    # حفظ فعلي بسعر محدد
 *      node yalla_tager_automation.js --use-template-price --qty 5
 *      node yalla_tager_automation.js --help
 */

const path = require('path');
const fs = require('fs');
const { YallaClient, YallaApiError } = require('./lib/api');
const { readProductRows } = require('./lib/excel');
const { Logger } = require('./lib/logger');
const { SubmissionState } = require('./lib/state');

// ------------------------------------------------------------------ الإعدادات

const DEFAULTS = {
  email: process.env.YALLA_EMAIL || 'Drmobile2009@gmail.com',
  password: process.env.YALLA_PASSWORD || 'DR@123456',
  excel: 'YALLA.xlsx',
  // الفئات التي يُبحث فيها بالترتيب. "إكسسوارات الموبايل"=5، "ايربودز"=144،
  // "ساعات ذكية"=145، "البنادل والعروض"=33
  categories: [5, 144, 145, 33],
  quantity: '',            // الكمية (فارغة = لا تُرسل — الباك إند يقبل ذلك)
  price: '',               // السعر (إجباري للحفظ إلا مع --use-template-price)
  groupPrice: '',          // سعر مجموعة الجملة (افتراضي = نفس السعر)
  useTemplatePrice: false, // استخدام سعر القالب المعروض بالموقع
  dryRun: false,
  force: false,            // تجاهل سجل التكرار
  limit: 20,               // عدد نتائج البحث لكل صفحة
  delayMs: 400,            // فاصل زمني بين الطلبات
  stateFile: path.join(__dirname, 'results', 'submitted.json'),
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': cfg.help = true; break;
      case '--dry-run': case '-n': cfg.dryRun = true; break;
      case '--email': cfg.email = next(); break;
      case '--password': cfg.password = next(); break;
      case '--excel': cfg.excel = next(); break;
      case '--qty': case '--quantity': cfg.quantity = next(); break;
      case '--price': cfg.price = next(); break;
      case '--group-price': cfg.groupPrice = next(); break;
      case '--use-template-price': cfg.useTemplatePrice = true; break;
      case '--force': cfg.force = true; break;
      case '--categories': cfg.categories = next().split(',').map((s) => Number(s.trim())).filter(Boolean); break;
      case '--limit': cfg.limit = Number(next()); break;
      case '--delay': cfg.delayMs = Number(next()); break;
      default:
        if (a.startsWith('-')) throw new Error(`خيار غير معروف: ${a}`);
    }
  }
  return cfg;
}

function usage() {
  console.log(`
أتمتة "يلا تاجر" — إضافة منتجات من ملف إكسل

الاستخدام:
  node yalla_tager_automation.js [الخيارات]

الخيارات:
  -n, --dry-run             البحث والتحقق فقط بدون حفظ أي منتج (موصى به أول مرة)
      --price <سعر>         السعر لكل منتج  ← إجباري للحفظ الفعلي
      --use-template-price  استخدم سعر القالب المعروض بالموقع بدلاً من --price
      --group-price <سعر>   سعر مجموعة الجملة (افتراضي: نفس --price)
      --qty <عدد>           الكمية لكل منتج (اختيارية)
      --force               أضِف حتى لو كان القالب مُرسلاً من قبل (خطر تكرار)
      --email <بريد>        بريد الحساب        (افتراضي: من YALLA_EMAIL)
      --password <كلمة>     كلمة المرور        (افتراضي: من YALLA_PASSWORD)
      --excel <ملف>         ملف الإكسل         (افتراضي: YALLA.xlsx)
      --categories <ids>    أرقام الفئات مفصولة بفواصل (افتراضي: 5,144,145,33)
      --limit <عدد>         عدد نتائج البحث    (افتراضي: 20)
      --delay <مللي>        الفاصل بين الطلبات (افتراضي: 400)
  -h, --help                هذه الرسالة

أمثلة:
  node yalla_tager_automation.js --dry-run
  node yalla_tager_automation.js --price 1000 --qty 5
  node yalla_tager_automation.js --use-template-price
  node yalla_tager_automation.js --price 1200 --group-price 1000

ملاحظات مهمة:
  • تنسيق الإكسل: العمود A = الباركود، العمود B = كود الموديل.
    السكربت يبحث بالباركود أولاً ثم بكود الموديل.
  • البحث يتطلب category_id إجبارياً من الباك إند، لذلك يجرّب السكربت
    كل فئة في القائمة حتى يجد المنتج.
  • السعر إجباري: الباك إند يرفض الحفظ بدون price + group_price معاً
    (الخطأ marketplace_seller_133).
  • ⚠️ الباك إند لا يمنع التكرار! لذلك يحتفظ السكربت بسجل محلي في
    results/submitted.json ويتحقّق أيضاً من الكتالوج المنشور.
  • النتائج تُحفظ في:  results/report-<التاريخ>.json  و  logs/run.log
`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ منطق البحث

/** ترتيب النتائج: تفضيل التطابق الحرفي مع كود الموديل/الباركود */
function rankTemplates(templates, row) {
  const model = (row.model || '').toUpperCase().replace(/\s+/g, '');
  return [...templates].sort((a, b) => score(b) - score(a));
  function score(t) {
    const label = (t.label || '').toUpperCase().replace(/\s+/g, '');
    let s = 0;
    if (model && label.includes(model)) s += 10;
    if (row.barcode && label.includes(row.barcode)) s += 5;
    return s;
  }
}

/**
 * البحث عن قالب المنتج: يجرّب كل استعلام في كل فئة.
 */
async function findTemplate(client, row, cfg, log) {
  const attempts = [];
  for (const query of row.queries) {
    for (const categoryId of cfg.categories) {
      const res = await client.searchTemplates({ query, categoryId, limit: cfg.limit });
      attempts.push({ query, categoryId, count: res.templates.length, error: res.error || null });
      if (res.templates.length) {
        const ranked = rankTemplates(res.templates, row);
        log.dim(`    وُجد عبر "${query}" في الفئة ${categoryId} (${res.templates.length} نتيجة)`);
        return { template: ranked[0], all: ranked, query, categoryId, attempts };
      }
      await sleep(cfg.delayMs);
    }
  }
  return { template: null, all: [], attempts };
}

/** تحويل السعر إلى نص صحيح (الباك إند يقبل أرقاماً صحيحة فقط) */
function normalizePrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n));
}

/** السعر المعروض للقالب على الموقع */
function templatePrice(tpl) {
  return normalizePrice(tpl && tpl.product && tpl.product.price);
}

/**
 * بناء جسم الحفظ.
 *
 * ⚠️ التصحيح الجوهري: `group_price` تُبنى من `sellerGroups` القادمة من
 * getCustomerGroups() (المجموعة "2" Wholesale فقط) — وهو ما تفعله صفحة
 * /vendor/add-products — وليس من `tpl.customer_groups` التي تعيد أيضاً
 * "Blacklist"/7. كما أن `price` و `group_price` إجباريان معاً،
 * وإلا يرفض الباك إند بـ marketplace_seller_133.
 *
 * @param {string} templateId
 * @param {object} tpl        بيانات القالب من getTemplateEditableData
 * @param {object} cfg        الإعدادات
 * @param {Array<{label:string,value:string}>} sellerGroups
 * @returns {{payload:object, price:string, groupPrice:string}}
 * @throws {Error} إذا لم يتوفّر سعر صالح
 */
function buildSavePayload(templateId, tpl, cfg, sellerGroups) {
  // 1) سمات المنتج القابلة للتعديل (فارغة عادةً لأن product_editable=false)
  const productData = {};
  for (const attr of Object.values(tpl.attributes || {})) {
    if (attr && attr.attribute_code) productData[attr.attribute_code] = attr.template_value;
  }

  // 2) المخزون — الكمية اختيارية لدى الباك إند
  const inventoryData = { backorders: '', quantity: '' };
  if (tpl.qty_editable && cfg.quantity !== '') inventoryData.quantity = String(cfg.quantity);

  // 3) تحديد السعر
  let price = cfg.price !== '' ? normalizePrice(cfg.price) : null;
  if (price === null && cfg.useTemplatePrice) price = templatePrice(tpl);
  if (price === null) {
    throw new Error(
      'لا يوجد سعر صالح. استخدم --price <سعر> أو --use-template-price ' +
      '(الباك إند يرفض الحفظ بدون سعر: marketplace_seller_133)'
    );
  }

  // سعر مجموعة الجملة: افتراضياً نفس السعر
  const groupPrice = cfg.groupPrice !== '' ? normalizePrice(cfg.groupPrice) || price : price;

  // 4) group_price من مجموعات البائع المسموح بها (المصدر الصحيح)
  const groupIds = (sellerGroups || []).map((g) => String(g.value)).filter(Boolean);
  if (!groupIds.length) {
    throw new Error('لم تُرجع getCustomerGroups() أي مجموعة عملاء — لا يمكن بناء group_price');
  }

  const priceData = {
    price,
    group_price: groupIds.map((gid) => ({ cust_group: gid, price: groupPrice })),
    special_price: '',
    special_from_date: null,
    special_to_date: null,
  };

  return {
    payload: {
      templateId,
      productData,
      inventoryData,
      priceData,
      configurableInventoryData: {},
      configurablePricesData: {},
    },
    price,
    groupPrice,
  };
}

// ------------------------------------------------------------------ البرنامج

async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.help) return usage();

  const log = new Logger({ file: path.join(__dirname, 'logs', 'run.log') });
  log.head('أتمتة "يلا تاجر" — إضافة منتجات البائع');
  if (cfg.dryRun) log.warn('وضع المعاينة (--dry-run): لن يتم حفظ أي منتج فعلياً.');

  // 0) التحقق من الإعدادات قبل أي اتصال بالشبكة
  if (!cfg.dryRun && cfg.price === '' && !cfg.useTemplatePrice) {
    log.fail('السعر مطلوب للحفظ الفعلي.');
    log.info('الباك إند يرفض أي حفظ بدون price + group_price معاً');
    log.info('(الخطأ: marketplace_seller_133 "You must add group prices and validate price").');
    log.info('\nاستخدم أحد الخيارين:');
    log.info('  node yalla_tager_automation.js --price 1000');
    log.info('  node yalla_tager_automation.js --use-template-price');
    log.info('\nأو للمعاينة فقط بدون حفظ:');
    log.info('  node yalla_tager_automation.js --dry-run');
    process.exitCode = 1;
    return log.close();
  }

  // 1) قراءة الإكسل
  const excelPath = path.isAbsolute(cfg.excel) ? cfg.excel : path.join(__dirname, cfg.excel);
  if (!fs.existsSync(excelPath)) {
    log.fail(`ملف الإكسل غير موجود: ${excelPath}`);
    process.exitCode = 1;
    return log.close();
  }
  log.step(`قراءة ملف الإكسل: ${path.basename(excelPath)}`);
  const rows = readProductRows(excelPath);
  log.ok(`تم العثور على ${rows.length} صف منتج.`);
  if (!rows.length) return log.close();

  // 2) تسجيل الدخول
  const client = new YallaClient({ logger: (m) => log.dim('    ' + m) });
  log.step(`تسجيل الدخول: ${cfg.email}`);
  try {
    await client.login(cfg.email, cfg.password);
    const acc = await client.getAccountData();
    const name = (acc.account_data && acc.account_data.full_name) || cfg.email;
    log.ok(`تم تسجيل الدخول — مرحباً ${name.trim()}`);
  } catch (err) {
    log.fail(`فشل تسجيل الدخول: ${err.message}${err.code ? ` (${err.code})` : ''}`);
    process.exitCode = 1;
    return log.close();
  }

  // 3) التحقق من كون الحساب تاجراً معتمداً + جلب مجموعات التسعير
  let sellerGroups = [];
  try {
    const form = await client.getSellerFormData();
    if (!form.is_vendor) throw new YallaApiError('الحساب ليس حساب تاجر (vendor)');
    if (!form.is_approved) log.warn('حساب التاجر غير معتمد بعد — قد تُرفض الإضافات.');
    log.ok(`حساب تاجر معتمد — رقم التاجر ${form.vendor_id}`);

    sellerGroups = await client.getCustomerGroups();
    if (!sellerGroups.length) throw new YallaApiError('لا توجد مجموعات تسعير متاحة للبائع');
    log.dim('    مجموعات التسعير: ' + sellerGroups.map((g) => `${g.value}=${g.label}`).join(' ، '));
  } catch (err) {
    log.fail(`فشل التحقق من حساب التاجر: ${err.message}${err.code ? ` (${err.code})` : ''}`);
    process.exitCode = 1;
    return log.close();
  }

  // 4) عرض الفئات المستخدمة
  try {
    const cats = await client.getCategories(2);
    const byId = new Map(cats.map((c) => [String(c.entity_id), c.name.trim()]));
    log.dim('    فئات البحث: ' + cfg.categories.map((id) => `${id}=${byId.get(String(id)) || '?'}`).join(' ، '));
  } catch { /* غير حرج */ }

  // 5) منع التكرار: الكتالوج المنشور + السجل المحلي
  //    (الباك إند لا يمنع التكرار، والطلبات المعلّقة لا تظهر في getproducts)
  const state = new SubmissionState(cfg.stateFile);
  let publishedIds = new Set();
  if (!cfg.dryRun) {
    try {
      log.step('جلب المنتجات المنشورة لمنع التكرار…');
      publishedIds = await client.getPublishedTemplateIds();
      log.ok(`${publishedIds.size} قالب منشور بالحساب، و${state.size} في السجل المحلي.`);
    } catch (err) {
      log.warn(`تعذّر جلب المنتجات المنشورة (${err.message}) — سنعتمد على السجل المحلي فقط.`);
    }
  }

  // 6) معالجة كل منتج
  log.head(`معالجة ${rows.length} منتج`);
  const results = [];
  let okCount = 0, notFound = 0, failed = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tag = `[${i + 1}/${rows.length}]`;
    log.step(`${tag} ${row.model || row.barcode}  (باركود: ${row.barcode || '—'})`);

    const rec = { row: row.row, barcode: row.barcode, model: row.model, status: 'pending' };
    try {
      const found = await findTemplate(client, row, cfg, log);
      if (!found.template) {
        log.warn(`    لم يوجد أي قالب مطابق — تخطي.`);
        rec.status = 'not_found';
        rec.attempts = found.attempts;
        notFound++;
        results.push(rec);
        continue;
      }

      rec.templateId = found.template.value;
      rec.templateLabel = found.template.label;
      rec.matchedQuery = found.query;
      rec.categoryId = found.categoryId;
      rec.otherMatches = found.all.slice(1).map((t) => ({ id: t.value, label: t.label }));

      const templateId = String(found.template.value);
      log.dim(`    القالب #${templateId}: ${found.template.label.slice(0, 80)}`);

      // منع التكرار قبل أي حفظ
      if (!cfg.dryRun && !cfg.force) {
        if (publishedIds.has(templateId)) {
          log.warn('    المنتج مُضاف بالفعل لحسابك (منشور) — تخطي. استخدم --force للتجاوز.');
          rec.status = 'already_published';
          skipped++;
          results.push(rec);
          await sleep(cfg.delayMs);
          continue;
        }
        if (state.has(templateId)) {
          const prev = state.get(templateId);
          log.warn(`    أُرسل طلب لهذا المنتج سابقاً (${(prev.submittedAt || '').slice(0, 10)}) — تخطي.`);
          rec.status = 'already_submitted';
          rec.previousSubmission = prev;
          skipped++;
          results.push(rec);
          await sleep(cfg.delayMs);
          continue;
        }
      }

      // بيانات القالب (لمعرفة الحقول القابلة للتعديل والسعر المرجعي)
      const tpl = await client.getTemplateData(templateId);
      if (!tpl) throw new YallaApiError('تعذر جلب بيانات القالب');
      rec.editable = {
        qty: !!tpl.qty_editable,
        price: !!tpl.price_editable,
        groupPrice: !!tpl.seller_allow_group_price,
        specialPrice: !!tpl.seller_allow_special_price,
      };
      rec.sku = tpl.product && tpl.product.sku;
      rec.templatePrice = templatePrice(tpl);

      if (cfg.dryRun) {
        const willPrice = cfg.price !== '' ? normalizePrice(cfg.price)
          : (cfg.useTemplatePrice ? rec.templatePrice : null);
        log.ok(`    ✓ معاينة — SKU ${rec.sku || '?'} | سعر القالب ${rec.templatePrice || '?'}`
          + ` | السعر المقترح ${willPrice || 'غير محدّد (يلزم --price)'}`);
        rec.status = 'dry_run_ok';
        okCount++;
        results.push(rec);
        await sleep(cfg.delayMs);
        continue;
      }

      // الحفظ الفعلي
      const built = buildSavePayload(templateId, tpl, cfg, sellerGroups);
      rec.price = built.price;
      rec.groupPrice = built.groupPrice;

      const saved = await client.saveProduct(built.payload);
      if (saved && saved.success === true) {
        const obj = saved.object || {};
        rec.requestId = obj.entity_id || null;
        rec.needApproval = !!saved.need_approval;
        log.ok(`    تمت الإضافة ✓ SKU ${rec.sku || '?'} | سعر ${built.price}`
          + ` | جملة ${built.groupPrice}${rec.requestId ? ` | طلب #${rec.requestId}` : ''}`
          + `${rec.needApproval ? ' (بانتظار الموافقة)' : ''}`);
        rec.status = 'saved';
        okCount++;
        // تسجيل فوري لمنع التكرار حتى لو توقّف السكربت لاحقاً
        state.add(templateId, {
          sku: rec.sku, model: row.model, barcode: row.barcode,
          requestId: rec.requestId, price: built.price, groupPrice: built.groupPrice,
        });
      } else {
        const e = (saved && saved.error) || {};
        log.fail(`    فشل الحفظ: ${e.message || 'خطأ غير معروف'}${e.code ? ` (${e.code})` : ''}`);
        if (e.code === 'marketplace_seller_133') {
          log.info('      ⇒ الباك إند يطلب price + group_price معاً. تأكّد من --price.');
        }
        rec.status = 'save_failed';
        rec.error = { code: e.code || null, message: e.message || '' };
        failed++;
      }
    } catch (err) {
      log.fail(`    خطأ: ${err.message}${err.code ? ` (${err.code})` : ''}`);
      rec.status = 'error';
      rec.error = { code: err.code || null, message: err.message };
      failed++;
    }
    results.push(rec);
    await sleep(cfg.delayMs);
  }

  // 7) التقرير
  log.head('الملخص');
  log.info(`إجمالي الصفوف        : ${rows.length}`);
  log.ok(`${cfg.dryRun ? 'جاهزة للإضافة' : 'تمت إضافتها'}    : ${okCount}`);
  if (skipped) log.warn(`مُضافة سابقاً (تخطي) : ${skipped}`);
  if (notFound) log.warn(`غير موجودة بالموقع  : ${notFound}`);
  if (failed) log.fail(`فشلت                : ${failed}`);

  const notFoundRows = results.filter((r) => r.status === 'not_found');
  if (notFoundRows.length) {
    log.info('\nالمنتجات غير الموجودة (تحتاج مراجعة يدوية):');
    notFoundRows.forEach((r) => log.info(`  • ${r.model || '—'}  (باركود ${r.barcode || '—'})`));
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    runAt: new Date().toISOString(),
    dryRun: cfg.dryRun,
    excel: path.basename(excelPath),
    categories: cfg.categories,
    price: cfg.price || (cfg.useTemplatePrice ? 'سعر القالب' : null),
    groupPrice: cfg.groupPrice || null,
    quantity: cfg.quantity || null,
    summary: { total: rows.length, ok: okCount, skipped, notFound, failed },
    results,
  }, null, 2), 'utf8');
  log.info(`\nتقرير مفصّل: ${path.relative(__dirname, outFile)}`);
  if (!cfg.dryRun) log.info(`سجل المُضاف : ${path.relative(__dirname, cfg.stateFile)}`);
  log.close();

  if (failed) process.exitCode = 2;
}

main().catch((err) => {
  console.error('\n✘ خطأ غير متوقع:', err && err.stack ? err.stack : err);
  process.exit(1);
});
