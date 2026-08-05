'use strict';
/** اختبار البحث عن كل أكواد الإكسل داخل عدة فئات */
const path = require('path');
const { YallaClient } = require('../lib/api');
const { readProductRows } = require('../lib/excel');

const CATS = [5, 144, 145, 33];

(async () => {
  const c = new YallaClient({ logger: (m) => console.log('   ' + m) });
  const r = await c.login('Drmobile2009@gmail.com', 'DR@123456');
  console.log('login:', JSON.stringify(r));

  const rows = readProductRows(path.join(__dirname, '..', 'YALLA.xlsx'));
  console.log('rows:', rows.length, '\n');

  for (const row of rows) {
    const queries = [...new Set([row.barcode, row.model].filter(Boolean))];
    let hit = null;
    outer: for (const q of queries) {
      for (const cat of CATS) {
        const res = await c.searchTemplates({ query: q, categoryId: cat, limit: 20 });
        if (res.templates.length) {
          hit = { q, cat, t: res.templates };
          break outer;
        }
      }
    }
    const label = `${String(row.barcode).padEnd(14)} | ${String(row.model).padEnd(15)}`;
    if (hit) {
      console.log(`${label} | cat=${hit.cat} via="${hit.q}" => ${hit.t.length} نتيجة`);
      hit.t.forEach((t) => console.log(`${' '.repeat(34)}- ${t.value}  ${t.label.slice(0, 70)}`));
    } else {
      console.log(`${label} | *** لم يوجد ***`);
    }
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
