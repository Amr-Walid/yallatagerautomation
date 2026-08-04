const { chromium } = require('playwright');

async function debugSearchButton() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Home...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    console.log('2. Login...');
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForTimeout(1500);
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(4000);

    console.log('3. Open Store...');
    const openStoreBtn = page.locator('a:has-text("افتح متجرك"), span:has-text("افتح متجرك")').first();
    if (await openStoreBtn.isVisible()) {
        await openStoreBtn.scrollIntoViewIfNeeded();
        await openStoreBtn.click();
        await page.waitForTimeout(3000);
    }

    console.log('4. Add Products...');
    const addProductBtn = page.locator('a:has-text("أضف منتجات"), span:has-text("أضف منتجات")').first();
    if (await addProductBtn.isVisible()) {
        await addProductBtn.click();
        await page.waitForTimeout(3000);
    }

    console.log('5. Category Dropdown...');
    const categoryDropdown = page.locator('.p-dropdown, select, div:has-text("اختر الفئة")').first();
    if (await categoryDropdown.isVisible()) {
        await categoryDropdown.click();
        await page.waitForTimeout(1000);
        const mobileOpt = page.locator('li:has-text("إكسسوارات الموبايل"), option:has-text("إكسسوارات الموبايل")').first();
        if (await mobileOpt.isVisible()) {
            await mobileOpt.click();
            await page.waitForTimeout(2000);
        }
    }

    console.log('Current URL:', page.url());
    await page.screenshot({ path: 'search_section_debug.png', fullPage: true });

    // Print all buttons / divs / icons near the search input
    const searchAreaElements = await page.evaluate(() => {
        const searchInput = document.querySelector('input[placeholder*="بحث بالاسم او الكود"], input[placeholder*="بحث"]');
        if (!searchInput) return 'Search input not found';
        const parent = searchInput.closest('div.grid, form, div.flex, div') || document.body;
        return Array.from(parent.querySelectorAll('button, a, div, span, input')).map(el => ({
            tag: el.tagName,
            class: el.className,
            text: el.innerText ? el.innerText.trim() : '',
            id: el.id,
            outerHTML: el.outerHTML.slice(0, 150)
        }));
    });

    console.log('Search Area Elements:', JSON.stringify(searchAreaElements, null, 2));

    await browser.close();
}

debugSearchButton();
