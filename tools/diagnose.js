#!/usr/bin/env node
'use strict';
/**
 * أداة تشخيص الاتصال بـ "يلا تاجر".
 * تفحص كل خطوة على حدة لتحديد مكان أي مشكلة مستقبلاً بسرعة.
 *
 *   node tools/diagnose.js
 */
const { YallaClient } = require('../lib/api');

const EMAIL = process.env.YALLA_EMAIL || 'Drmobile2009@gmail.com';
const PASSWORD = process.env.YALLA_PASSWORD || 'DR@123456';

const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31m✘\x1b[0m ' + m);
const step = (m) => console.log('\n\x1b[36m▸ ' + m + '\x1b[0m');

(async () => {
  const c = new YallaClient({ retries: 2 });
  let fatal = false;

  step('1) تسجيل الدخول');
  try {
    const r = await c.login(EMAIL, PASSWORD);
    ok(`نجح — sessionId: ${String(r.sessionId || '').slice(0, 12)}…`);
    ok('الكوكيز: ' + [...c.cookies.keys()].join(', '));
  } catch (e) {
    bad(`فشل: ${e.message} ${e.code || ''}`);
    console.log('    ← تحقّق من البريد/كلمة المرور. حقل الدخول الصحيح اسمه usernameemail.');
    return process.exit(1);
  }

  step('2) بيانات الحساب');
  try {
    const a = await c.getAccountData();
    ok(`${(a.account_data.full_name || '').trim()} — ${a.account_data.email}`);
  } catch (e) { bad(e.message); fatal = true; }

  step('3) حساب التاجر (vendor)');
  try {
    const f = await c.getSellerFormData();
    ok(`vendor_id=${f.vendor_id} | is_vendor=${f.is_vendor} | معتمد=${f.is_approved}`);
    if (!f.is_approved) bad('الحساب غير معتمد — قد تُرفض الإضافات.');
  } catch (e) { bad(e.message); fatal = true; }

  step('4) مجموعات التسعير (مصدر group_price)');
  try {
    const g = await c.getCustomerGroups();
    if (!g.length) { bad('لا توجد مجموعات — الحفظ سيفشل بـ marketplace_seller_133'); fatal = true; }
    else ok(g.map((x) => `${x.value}=${x.label}`).join(' ، '));
  } catch (e) { bad(e.message); fatal = true; }

  step('5) الفئات (المستوى 2)');
  try {
    const cats = await c.getCategories(2);
    ok(`${cats.length} فئة`);
    for (const id of [5, 144, 145, 33]) {
      const f = cats.find((x) => String(x.entity_id) === String(id));
      console.log(`      ${id} = ${f ? f.name.trim() : '\x1b[31mغير موجودة\x1b[0m'}`);
    }
  } catch (e) { bad(e.message); }

  step('6) البحث في القوالب (category_id إجباري)');
  try {
    const r = await c.searchTemplates({ query: '6968892300155', categoryId: 5 });
    if (r.templates.length) ok(`وُجد ${r.templates.length}: #${r.templates[0].value}`);
    else bad(`لا نتائج ${r.error ? '— ' + r.error.code : ''}`);
    const bare = await c.call('epowermarketplace/seller/gettemplates', { store_view: 'ar', query: '6968892300155' });
    console.log(`      بدون category_id ⇒ ${bare.success ? 'نجح' : 'فشل (' + (bare.error || {}).code + ') ← متوقّع'}`);
  } catch (e) { bad(e.message); }

  step('7) المنتجات المنشورة (seller_id إجباري)');
  try {
    const ids = await c.getPublishedTemplateIds();
    ok(`${ids.size} قالب منشور`);
  } catch (e) { bad(e.message); }

  step('8) تأكيد قاعدة السعر الإجبارية (بدون إنشاء منتج)');
  try {
    const r = await c.saveProduct({ templateId: '53676' });
    if (r.success === false && (r.error || {}).code === 'marketplace_seller_133') {
      ok('الباك إند يرفض الحفظ بدون سعر كما هو متوقّع (القاعدة سارية).');
    } else if (r.success) {
      bad('⚠ تم إنشاء منتج غير مقصود! راجع results/submitted.json');
    } else {
      bad(`رد غير متوقّع: ${JSON.stringify(r.error)}`);
    }
  } catch (e) { bad(e.message); }

  console.log(fatal ? '\n\x1b[31mتوجد مشاكل تمنع الإضافة.\x1b[0m' : '\n\x1b[32mكل شيء سليم ✓\x1b[0m');
  process.exit(fatal ? 1 : 0);
})();
