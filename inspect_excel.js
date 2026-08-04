const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, 'YALLA.xlsx');
const workbook = xlsx.readFile(filePath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1 });

console.log('Raw Sheet Data Matrix:');
rawData.forEach((row, idx) => console.log(`Row ${idx}:`, row));
