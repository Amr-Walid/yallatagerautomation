const { chromium } = require('playwright');

async function testSearchExact() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Logging in...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // Wait for Nuxt JS hydration

    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 15000 });

    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(5000);

    console.log('2. Going to Open Store / Vendor page...');
    const openStoreBtn = page.locator('a:has-text("افتح متجرك")').first();
    if (await openStoreBtn.isVisible()) {
        await openStoreBtn.scrollIntoViewIfNeeded();
        await openStoreBtn.click();
        await page.waitForTimeout(4000);
    }

    console.log('3. Clicking "أضف منتجات"...');
    const addProductsBtn = page.locator('a:has-text("أضف منتجات"), span:has-text("أضف منتجات")').first();
    if (await addProductsBtn.isVisible()) {
        await addProductsBtn.click();
        await page.waitForTimeout(4000);
    }

    console.log('4. Selecting Category "إكسسوارات الموبايل"...');
    const dropdown = page.locator('.p-dropdown, select, div:has-text("اختر الفئة")').first();
    if (await dropdown.isVisible()) {
        await dropdown.click();
        await page.waitForTimeout(1000);
        const mobileOpt = page.locator('li:has-text("إكسسوارات الموبايل"), option:has-text("إكسسوارات الموبايل")').first();
        if (await mobileOpt.isVisible()) {
            await mobileOpt.click();
            await page.waitForTimeout(2000);
        }
    }

    console.log('5. Testing search with code 6968892300339 ...');
    // Find search input
    const searchInput = page.locator('input[placeholder*="بحث بالاسم"], input[placeholder*="الكود"], input[placeholder*="بحث"]').last();
    await searchInput.focus();
    await searchInput.fill('6968892300339');
    await page.waitForTimeout(500);

    // Click blue search button "أبحث"
    console.log('Clicking search button "أبحث"...');
    const searchBtn = page.locator('button:has-text("أبحث"), a:has-text("أبحث"), div:has-text("أبحث"), input[value*="أبحث"]').first();
    if (await searchBtn.isVisible()) {
        console.log('Found search button! Clicking...');
        await searchBtn.click();
    } else {
        console.log('Search button not found by text, pressing Enter...');
        await searchInput.press('Enter');
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'search_results_test.png', fullPage: true });

    const bodyText = await page.innerText('body');
    console.log('SearchResult Text found:', bodyText.includes('شاحن') || bodyText.includes('SN-397') || bodyText.includes('نعرض'));

    await browser.close();
}

testSearchExact();
