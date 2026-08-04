const { chromium } = require('playwright');
const xlsx = require('xlsx');
const path = require('path');

async function testSite() {
    // 1. Read Excel file
    const excelPath = path.join(__dirname, 'YALLA.xlsx');
    const workbook = xlsx.readFile(excelPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    
    // Extract codes from row 1 to end (row 0 is header)
    const productCodes = rawRows
        .slice(1)
        .map(row => row[0])
        .filter(code => code !== undefined && code !== null && String(code).trim() !== '');

    console.log(`Found ${productCodes.length} product codes in YALLA.xlsx:`, productCodes);

    // Launch browser using installed msedge or chrome
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: false, slowMo: 400 });
    } catch {
        browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 400 });
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
        console.log('Navigating to login page...');
        await page.goto('https://yallatager.com/ar/account/login', { waitUntil: 'domcontentloaded' });

        // Login
        console.log('Filling login credentials...');
        await page.locator('input[type="email"], input[name*="email"], input[name*="User"], #Email, input[placeholder*="البريد"]').first().fill('Drmobile2009@gmail.com');
        await page.locator('input[type="password"], input[name*="pass"], #Password, input[placeholder*="كلمة"]').first().fill('DR@123456');
        
        console.log('Clicking login button...');
        await page.locator('button[type="submit"], input[type="submit"], button:has-text("تسجيل الدخول"), .btn-primary').first().click();
        await page.waitForTimeout(4000);

        console.log('Logged in! Current URL:', page.url());

        // Scroll down to "افتح متجرك"
        console.log('Looking for "افتح متجرك"...');
        const openStoreLink = page.locator('a:has-text("افتح متجرك"), text=افتح متجرك').first();
        if (await openStoreLink.isVisible()) {
            await openStoreLink.scrollIntoViewIfNeeded();
            await openStoreLink.click();
            await page.waitForTimeout(4000);
        } else {
            console.log('"افتح متجرك" not directly found by text, searching page links...');
        }

        console.log('Current URL after store link:', page.url());

        // Click "أضف منتجات"
        console.log('Looking for "أضف منتجات"...');
        const addProductsLink = page.locator('a:has-text("أضف منتجات"), text=أضف منتجات').first();
        if (await addProductsLink.isVisible()) {
            await addProductsLink.click();
            await page.waitForTimeout(4000);
        }

        console.log('Current URL after add products link:', page.url());

        // Select Category: "إكسسوارات الموبايل"
        console.log('Selecting category "إكسسوارات الموبايل"...');
        const selectElem = page.locator('select').first();
        if (await selectElem.isVisible()) {
            const options = await selectElem.locator('option').allInnerTexts();
            console.log('Available category options:', options);
            
            // Find option matching "إكسسوارات الموبايل"
            const matchingOpt = options.find(opt => opt.includes('إكسسوارات الموبايل') || opt.includes('اكسسوارات'));
            if (matchingOpt) {
                await selectElem.selectOption({ label: matchingOpt });
                console.log('Selected category option:', matchingOpt);
            }
        }

        // Loop products
        for (let i = 0; i < productCodes.length; i++) {
            const code = String(productCodes[i]).trim();
            console.log(`\n========================================`);
            console.log(`[${i + 1}/${productCodes.length}] Searching for Product Code: ${code}`);
            console.log(`========================================`);

            // Search box
            const searchInput = page.locator('input[placeholder*="بحث"]').first();
            await searchInput.fill(code);
            
            // Search button
            const searchBtn = page.locator('button:has-text("أبحث"), button:has-text("بحث"), input[value*="أبحث"]').first();
            await searchBtn.click();
            await page.waitForTimeout(3000);

            // Print search status or page state
            const pageText = await page.innerText('body');
            if (pageText.includes('عرض') || pageText.includes('منتج')) {
                console.log('Search result found!');
            }

            // Click the result element
            // Click card or text containing code or title
            const resultBox = page.locator(`div:has-text("${code}"), div:has-text("شاحن"), div:has-text("واط"), div[style*="border"], div[class*="card"]`).first();
            if (await resultBox.isVisible()) {
                console.log('Clicking product result box...');
                await resultBox.click();
                await page.waitForTimeout(2000);
            }

            // Click "أحفظ المنتج" or "أضف المنتج"
            const saveBtn = page.locator('button:has-text("أحفظ المنتج"), button:has-text("أضف المنتج")').first();
            if (await saveBtn.isVisible()) {
                await saveBtn.click();
                console.log(`>>> SUCCESS: Product ${code} added/saved!`);
                await page.waitForTimeout(3000);
            } else {
                console.log(`>>> WARN: Save button not visible for ${code}`);
            }
        }

        console.log('\nWorkflow complete!');
    } catch (err) {
        console.error('Error during test execution:', err);
    } finally {
        await browser.close();
    }
}

testSite();
