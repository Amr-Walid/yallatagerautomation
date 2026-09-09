'use strict';
/**
 * سجل محلّي للقوالب التي أرسلنا لها طلب إضافة بالفعل.
 *
 * لماذا؟ لأن الباك إند لا يمنع التكرار إطلاقاً: كل نداء لـ
 * `epowermarketplace/seller/createrequest` يُنشئ طلباً جديداً بـ entity_id
 * جديد حتى لو كان نفس القالب ونفس السعر. والأسوأ أن الطلبات المعلّقة
 * (status=2) لا تظهر في `getproducts` إلا بعد اعتمادها، فلا يمكن الاعتماد
 * على الكتالوج وحده لمنع التكرار.
 *
 * الحل: ملف JSON محلّي يسجّل كل قالب أُرسل بنجاح.
 */
const fs = require('fs');
const path = require('path');

class SubmissionState {
  /** @param {string} file مسار ملف الحالة */
  constructor(file) {
    this.file = file;
    this.data = { version: 1, submissions: {} };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.submissions) this.data = parsed;
      }
    } catch {
      /* ملف تالف — نبدأ من جديد */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /** هل أُرسل هذا القالب من قبل؟ */
  has(templateId) {
    return Object.prototype.hasOwnProperty.call(this.data.submissions, String(templateId));
  }

  get(templateId) {
    return this.data.submissions[String(templateId)] || null;
  }

  /** تسجيل إرسال ناجح */
  add(templateId, info = {}) {
    this.data.submissions[String(templateId)] = {
      ...info,
      submittedAt: new Date().toISOString(),
    };
    this.save();
  }

  get size() {
    return Object.keys(this.data.submissions).length;
  }
}

module.exports = { SubmissionState };
