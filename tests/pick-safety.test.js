/**
 * اختبار أمان المطابقة — يمنع تكرار خطأ حقيقي حدث على الموقع.
 *
 * الحادثة: البحث بالكود 57002 أرجع نتيجة وحيدة هي القالب 40060
 * «وش جى فينوس كيرف بكسل رقم (2)، 57002 - أسود» — منتج مختلف تماماً،
 * صادف أن الرقم موجود داخل اسمه. الأداة قبلته لمجرد أنه نتيجة وحيدة
 * فسجّلت منتجاً خطأ في حساب التاجر (طلب #165656).
 *
 * القاعدة الآن: مع البحث بالكود لا نقبل إلا:
 *   • كود مستخرج مطابق تماماً، أو
 *   • رقم قالب (template_id) مطابق تماماً.
 * أي شيء آخر ⇒ غامض (ambiguous) ولا نسجّل شيئاً.
 */

const assert = require('assert');
const { Job } = require('../lib/job');

// نستخدم النموذج فقط للوصول لـ _pick (لا شبكة ولا حالة)
const pick = Job.prototype._pick;
const call = (templates, row, by) => pick.call({}, templates, row, by);

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log('أمان المطابقة بالكود:');

t('لا تُقبل نتيجة وحيدة يصادف ظهور الرقم داخل اسمها (الحادثة الحقيقية)', () => {
  const templates = [{ value: 40060, label: 'وش جى فينوس كيرف بكسل رقم (2)، 57002 - أسود' }];
  const r = call(templates, { productId: '57002' }, 'id');
  assert.strictEqual(r.template, null, 'كان يجب رفض المنتج الخطأ');
  assert.ok(r.ambiguous && r.ambiguous.length, 'يجب الإبلاغ عن الغموض');
});

t('لا تُقبل نتائج متعددة كلها مصادفات رقمية', () => {
  const templates = [
    { value: 40121, label: 'قاطع فينوس ديمر,1 فاز 10 أمبير 6 كيلو, SJ20 - 157010' },
    { value: 40542, label: 'سوكوميك حامل فيوز 10×38 مم، 32 أمبير، قطب واحد (1P) - 5701001' },
    { value: 40544, label: 'سوكوميك حامل فيوز 10×38 مم، 32 أمبير، 3 أقطاب (3P) - 57010018' },
  ];
  const r = call(templates, { productId: '57010' }, 'id');
  assert.strictEqual(r.template, null);
});

t('SN-33 لا يطابق SN-333 / SN-336 (الحادثة الأقدم)', () => {
  const templates = [
    { value: 1, label: 'شاحن سيارة SN-333 30 وات' },
    { value: 2, label: 'شاحن سيارة SN-336 45 وات' },
  ];
  const r = call(templates, { productId: 'SN-33' }, 'id');
  assert.strictEqual(r.template, null);
});

t('يُقبل الكود المطابق تماماً', () => {
  const templates = [
    { value: 1, label: 'شاحن سيارة SN-333 30 وات' },
    { value: 2, label: 'سماعة رأس SN-33 لاسلكية' },
  ];
  const r = call(templates, { productId: 'SN-33' }, 'id');
  assert.ok(r.template, 'كان يجب قبول التطابق التام');
  assert.strictEqual(r.template.id, '2');
  assert.strictEqual(r.score, 100);
});

t('يُقبل رقم القالب (template_id) عند إدخاله مباشرة', () => {
  const templates = [
    { value: 57009, label: 'إليوس كشاف داون لايت 12 وات - أبيض' },
    { value: 40060, label: 'وش جى فينوس كيرف بكسل رقم (2)، 57009 - أسود' },
  ];
  const r = call(templates, { productId: '57009' }, 'id');
  assert.ok(r.template, 'كان يجب قبول رقم القالب');
  assert.strictEqual(r.template.id, '57009');
});

t('الباركود الطويل يُقبل ككود مستخرج فقط', () => {
  const ok = call([{ value: 9, label: 'منتج ما 2496764659543 - أسود' }],
    { productId: '2496764659543' }, 'id');
  assert.ok(ok.template, 'الباركود الكامل يجب أن يُقبل');

  const bad = call([{ value: 9, label: 'منتج ما 24967646595431111 - أسود' }],
    { productId: '2496764659543' }, 'id');
  assert.strictEqual(bad.template, null, 'باركود أطول ليس نفس المنتج');
});

console.log('\nأمان المطابقة بالاسم:');

t('لا تُقبل نتيجة وحيدة باسم مختلف تماماً', () => {
  const templates = [{ value: 40060, label: 'وش جى فينوس كيرف بكسل رقم (2) - أسود' }];
  const r = call(templates, { productName: 'كشاف داون لايت 12 وات أبيض' }, 'name');
  assert.strictEqual(r.template, null, 'الاسم غير متشابه فلا يُقبل');
});

t('يُقبل الاسم المطابق تماماً', () => {
  const templates = [
    { value: 57009, label: 'إليوس كشاف داون لايت 12 وات - أبيض' },
    { value: 57010, label: 'إليوس كشاف داون لايت 18 وات - أبيض' },
  ];
  const r = call(templates, { productName: 'إليوس كشاف داون لايت 12 وات - أبيض' }, 'name');
  assert.ok(r.template);
  assert.strictEqual(r.template.id, '57009');
});

console.log(`\n${pass} اختباراً ناجحاً${process.exitCode ? ' — مع فشل!' : ' ✓'}`);
