'use strict';
/**
 * قراءة أكواد المنتجات من ملف الإكسل.
 *
 * تنسيق YALLA.xlsx:
 *   العمود A = "كود المنتج"  -> الباركود (SKU) مثال 6968892300339
 *   العمود B = "cod"         -> كود الموديل  مثال SN-397
 *   العمود C = "desc,"       -> الوصف
 *   العمود D = ملاحظة (not live)
 *
 * السكربت القديم كان يقرأ العمود A فقط، والعمود A في بعض الصفوف
 * غير مطابق لأي منتج في الموقع (مثال 1804834123459)، وهذا أحد
 * أسباب فشل عمليات البحث.
 */
const xlsx = require('xlsx');

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * @returns {Array<{row:number, barcode:string, model:string, desc:string, note:string, queries:string[]}>}
 */
function readProductRows(filePath, { sheetName = null } = {}) {
  const wb = xlsx.readFile(filePath);
  const sheet = wb.Sheets[sheetName || wb.SheetNames[0]];
  if (!sheet) throw new Error(`لم يتم العثور على الشيت في ${filePath}`);

  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!raw.length) return [];

  // تخطي صف العنوان إذا وُجد
  const first = raw[0].map((c) => clean(c).toLowerCase());
  const hasHeader =
    first.some((c) => c.includes('كود') || c === 'cod' || c.startsWith('desc') || c.includes('sku'));
  const body = hasHeader ? raw.slice(1) : raw;

  const out = [];
  body.forEach((r, i) => {
    const barcode = clean(r[0]);
    const model = clean(r[1]);
    const desc = clean(r[2]);
    const note = clean(r[3]);
    if (!barcode && !model) return; // صف فارغ

    // ترتيب أفضلية البحث: الباركود أولاً (أدق) ثم كود الموديل
    const queries = [...new Set([barcode, model].filter(Boolean))];
    out.push({
      row: (hasHeader ? i + 2 : i + 1),
      barcode,
      model,
      desc,
      note,
      queries,
      label: model || barcode,
    });
  });
  return out;
}

module.exports = { readProductRows };
