'use strict';
/**
 * مولّد وقارئ "تيمبليت الإكسل" الخاص بكل فئة.
 * =====================================================
 * الفكرة: المستخدم يختار الفئة من الواجهة → ننزّله شيت إكسل جاهز
 * بالعواميد المطلوبة → يملأه → يرفعه → نسجّل الأكواد.
 *
 * أعمدة التيمبليت (بالترتيب):
 *   1) كود المنتج (ID / SKU / باركود)   ← البحث الأساسي
 *   2) اسم المنتج                        ← البحث البديل لو الكود مش موجود
 *   3) سعر البيع *                       ← price       (إجباري في الباك إند)
 *   4) سعر الجملة *                      ← group_price (إجباري في الباك إند)
 *   5) الكمية (اختياري)
 *   6) سعر خاص (اختياري)
 *   7) ملاحظات (اختياري — لا تُرسل للموقع)
 *
 * ملاحظة: العمودان 1 و 2 كلاهما موجود لأن الباك إند يبحث نصياً؛
 * لو الكود لم يُعطِ نتيجة نجرّب الاسم تلقائياً.
 */

const xlsx = require('xlsx');

/** تعريف الأعمدة — المصدر الوحيد للحقيقة للكتابة والقراءة */
const COLUMNS = [
  { key: 'productId', header: 'كود المنتج (ID / باركود)', width: 26, required: false,
    hint: 'الكود أو الباركود كما هو في الموقع — يُبحث به أولاً' },
  { key: 'productName', header: 'اسم المنتج', width: 40, required: false,
    hint: 'يُستخدم للبحث لو الكود لم يُعطِ نتيجة' },
  { key: 'price', header: 'سعر البيع *', width: 14, required: true,
    hint: 'إجباري — السعر المعروض للعميل' },
  { key: 'groupPrice', header: 'سعر الجملة *', width: 14, required: true,
    hint: 'إجباري — سعر مجموعة Wholesale' },
  { key: 'quantity', header: 'الكمية (اختياري)', width: 16, required: false,
    hint: 'اتركها فارغة لو مش محتاجها' },
  { key: 'specialPrice', header: 'سعر خاص (اختياري)', width: 16, required: false,
    hint: 'سعر العرض/الخصم — اختياري' },
  { key: 'notes', header: 'ملاحظات (اختياري)', width: 30, required: false,
    hint: 'لأغراضك فقط — لا تُرسل للموقع' },
];

/** مطابِقات مرنة لقراءة الملف حتى لو المستخدم عدّل صياغة العنوان */
const HEADER_MATCHERS = {
  productId: ['كود', 'id', 'sku', 'باركود', 'barcode', 'code'],
  productName: ['اسم', 'name', 'title', 'وصف', 'desc'],
  price: ['سعر البيع', 'price'],
  groupPrice: ['سعر الجملة', 'group', 'جمله', 'wholesale'],
  quantity: ['كمية', 'كميه', 'qty', 'quantity', 'stock'],
  specialPrice: ['سعر خاص', 'special'],
  notes: ['ملاحظات', 'ملاحظه', 'note', 'comment'],
};

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const norm = (v) => clean(v).toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ');

/**
 * بناء ملف التيمبليت لفئة معيّنة.
 * @param {object} o
 * @param {string} o.categoryName اسم الفئة (يظهر في الشيت وورقة التعليمات)
 * @param {number|string} o.categoryId رقم الفئة (يُحفظ داخل الملف للتحقق)
 * @param {Array<object>} [o.samples] عيّنة قوالب من الفئة لملء ورقة "المنتجات المتاحة"
 * @returns {Buffer} محتوى ملف .xlsx
 */
function buildTemplateWorkbook({ categoryName = '', categoryId = '', samples = [] } = {}) {
  const wb = xlsx.utils.book_new();

  // ---------- ورقة 1: البيانات (التي يملأها المستخدم) ----------
  const headerRow = COLUMNS.map((c) => c.header);
  const aoa = [headerRow];
  // صف مثال توضيحي — يُتجاهل عند القراءة لأنه يبدأ بعلامة #
  aoa.push(['# مثال: 6968892300339', '# مثال: اسم المنتج', 1000, 950, '', '', 'امسح صف المثال']);
  for (let i = 0; i < 30; i++) aoa.push(COLUMNS.map(() => ''));

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!cols'] = COLUMNS.map((c) => ({ wch: c.width }));
  ws['!autofilter'] = { ref: xlsx.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: COLUMNS.length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  xlsx.utils.book_append_sheet(wb, ws, 'المنتجات');

  // ---------- ورقة 2: التعليمات ----------
  const info = [
    ['تيمبليت تسجيل المنتجات — يلا تاجر'],
    [''],
    ['الفئة المختارة', categoryName],
    ['رقم الفئة', String(categoryId)],
    ['تاريخ التنزيل', new Date().toISOString().slice(0, 19).replace('T', ' ')],
    [''],
    ['شرح الأعمدة'],
    ['العمود', 'إجباري؟', 'التوضيح'],
    ...COLUMNS.map((c) => [c.header, c.required ? 'إجباري' : 'اختياري', c.hint]),
    [''],
    ['ملاحظات مهمة'],
    ['١', 'املأ "كود المنتج" أو "اسم المنتج" — واحد منهما على الأقل مطلوب لكل صف.'],
    ['٢', 'لو الكود لم يُعطِ نتيجة، النظام يبحث تلقائياً باسم المنتج.'],
    ['٣', 'سعر البيع وسعر الجملة إجباريان — الموقع يرفض الحفظ بدونهما.'],
    ['٤', 'امسح صف المثال (الذي يبدأ بعلامة #) قبل الرفع.'],
    ['٥', 'الصفوف الفارغة تُتجاهل تلقائياً.'],
    ['٦', 'يمكن ترك الكمية فارغة — الموقع يقبلها.'],
  ];
  const wsInfo = xlsx.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 70 }];
  xlsx.utils.book_append_sheet(wb, wsInfo, 'التعليمات');

  // ---------- ورقة 3: عيّنة من المنتجات المتاحة في الفئة ----------
  if (samples && samples.length) {
    const sAoa = [['كود المنتج', 'اسم المنتج', 'سعر الموقع', 'رقم القالب']];
    for (const s of samples) {
      sAoa.push([clean(s.sku || s.id || ''), clean(s.name || ''), clean(s.price || ''), clean(s.templateId || '')]);
    }
    const wsS = xlsx.utils.aoa_to_sheet(sAoa);
    wsS['!cols'] = [{ wch: 24 }, { wch: 50 }, { wch: 14 }, { wch: 12 }];
    xlsx.utils.book_append_sheet(wb, wsS, 'أمثلة من الفئة');
  }

  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** يحدّد فهرس كل عمود من صف العنوان */
function mapHeaders(headerCells) {
  const cells = headerCells.map(norm);
  const idx = {};
  for (const [key, needles] of Object.entries(HEADER_MATCHERS)) {
    idx[key] = -1;
    for (let c = 0; c < cells.length; c++) {
      if (idx[key] !== -1) break;
      if (!cells[c]) continue;
      if (needles.some((n) => cells[c].includes(norm(n)))) {
        // "سعر الجملة" يحتوي "سعر" أيضاً؛ نتجنّب الخطأ بترتيب الفحص
        if (key === 'price' && (cells[c].includes('جمل') || cells[c].includes('خاص') || cells[c].includes('group'))) continue;
        idx[key] = c;
      }
    }
  }
  return idx;
}

/** يحوّل قيمة لسعر صحيح موجب أو null */
function toPrice(v) {
  const s = clean(v).replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * 100) / 100);
}

/**
 * قراءة الملف الذي رفعه المستخدم.
 * @returns {{rows:Array, warnings:string[]}}
 */
function readTemplateRows(filePathOrBuffer) {
  const wb = Buffer.isBuffer(filePathOrBuffer)
    ? xlsx.read(filePathOrBuffer, { type: 'buffer' })
    : xlsx.readFile(filePathOrBuffer);

  // نفضّل ورقة "المنتجات" إن وُجدت، وإلا أول ورقة تحتوي بيانات
  const preferred = wb.SheetNames.find((n) => norm(n).includes('منتج')) || wb.SheetNames[0];
  const sheet = wb.Sheets[preferred];
  if (!sheet) throw new Error('الملف لا يحتوي على أي ورقة بيانات');

  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!raw.length) return { rows: [], warnings: ['الملف فارغ'] };

  // إيجاد صف العنوان (أول صف يُطابق عمودين على الأقل)
  let headerIdx = -1;
  let colIdx = null;
  for (let r = 0; r < Math.min(raw.length, 10); r++) {
    const m = mapHeaders(raw[r].map(clean));
    const matched = Object.values(m).filter((v) => v >= 0).length;
    if (matched >= 2) { headerIdx = r; colIdx = m; break; }
  }

  const warnings = [];
  if (headerIdx === -1) {
    // بلا عنوان: نفترض الترتيب الافتراضي للأعمدة
    warnings.push('لم يُعثر على صف عنوان — تم افتراض ترتيب الأعمدة الافتراضي');
    headerIdx = -1;
    colIdx = {};
    COLUMNS.forEach((c, i) => { colIdx[c.key] = i; });
  }

  const body = raw.slice(headerIdx + 1);
  const at = (r, key) => (colIdx[key] >= 0 ? clean(r[colIdx[key]]) : '');

  const rows = [];
  body.forEach((r, i) => {
    const excelRow = headerIdx + i + 2;
    const productId = at(r, 'productId');
    const productName = at(r, 'productName');

    // تخطي صف المثال والصفوف الفارغة
    if (productId.startsWith('#') || productName.startsWith('#')) return;
    if (!productId && !productName) return;

    const price = toPrice(at(r, 'price'));
    const groupPrice = toPrice(at(r, 'groupPrice'));
    const specialPrice = toPrice(at(r, 'specialPrice'));
    const qtyRaw = at(r, 'quantity').replace(/[^\d]/g, '');

    // ترتيب البحث: الكود أولاً ثم الاسم
    const queries = [...new Set([productId, productName].filter(Boolean))];

    rows.push({
      excelRow,
      productId,
      productName,
      price,
      groupPrice: groupPrice || price, // لو نسي سعر الجملة نستخدم سعر البيع
      specialPrice,
      quantity: qtyRaw || '',
      notes: at(r, 'notes'),
      queries,
      label: productId || productName,
    });
  });

  return { rows, warnings };
}

module.exports = { COLUMNS, buildTemplateWorkbook, readTemplateRows, toPrice };
