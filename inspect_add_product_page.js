const { chromium } = require('playwright');

async function inspectAddProduct() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    console.log('1. Logging in...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button.btn-mainAction, button[type="submit"]');
    await page.waitForTimeout(4000);

    console.log('2. Going to vendor add products page...');
    const openStoreBtn = page.locator('a:has-text("افتح متجرك"), span:has-text("افتح متجرك")').first();
    if (await openStoreBtn.isVisible()) {
        await openStoreBtn.scrollIntoViewIfNeeded();
        await openStoreBtn.click();
        await page.waitForTimeout(3000);
    }
    const addProductLink = page.locator('a:has-text("أضف منتجات"), span:has-text("أضف منتجات")').first();
    if (await addProductLink.isVisible()) {
        await addProductLink.click();
        await page.waitForTimeout(3000);
    }

    console.log('Current Page URL:', page.url());
    await page.screenshot({ path: 'add_product_page_debug.png', fullPage: true });

    // Print all buttons, inputs, selects, links
    const elements = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input, select, a, div[class*="btn"], div[class*="button"], div[class*="search"]')).map(el => ({
            tag: el.tagName,
            id: el.id || '',
            class: el.className || '',
            text: el.innerText ? el.innerText.trim() : '',
            type: el.type || '',
            placeholder: el.placeholder || '',
            outerHTML: el.outerHTML.slice(0, 150)
        }));
    });

    console.log('Add Product Page Elements:');
    console.log(JSON.stringify(elements, null, 2));

    await browser.close();
}

inspectAddProduct();
