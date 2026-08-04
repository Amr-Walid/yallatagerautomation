# YallaTager Playwright Excel Automation

اسكربت أتمتة لـ **يلا تاجر (YallaTager)** باستخدام **Playwright** وقراءة المنتجات من ملف **Excel**.

## 📌 المميزات:
- قراءة أكواد المنتجات من ملف `YALLA.xlsx` تلقائياً.
- تسجيل الدخول بالحساب تلقائياً أو استرجاع الجلسة المحفوظة.
- الانتقال لشاشة تحكم البائع واختيار فئة "إكسسوارات الموبايل".
- البحث بكود كل منتج وتحديده ثم حفظه تلقائياً.

## 🚀 طريقة التشغيل:

1. تثبيت الحزم والمكتبات:
```bash
npm install
npx playwright install chromium
```

2. تشغيل الاسكربت:
```bash
npm start
```
أو:
```bash
node yalla_tager_automation.js
```
