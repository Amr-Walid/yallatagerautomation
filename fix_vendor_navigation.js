const { chromium } = require('playwright');

async function checkVendorLinks() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    console.log('1. Home & Login...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(4000);

    console.log('Logged in URL:', page.url());

    // Click "حسابي" or user icon to see account menu or seller links
    console.log('2. Navigating to seller dashboard...');
    // Let's try navigating to https://yallatager.com/ar/vendor
    await page.goto('https://yallatager.com/ar/vendor', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    console.log('URL after /ar/vendor:', page.url());
    await page.screenshot({ path: 'vendor_direct.png', fullPage: true });

    // Print all links on page
    const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
            text: a.innerText ? a.innerText.trim() : '',
            href: a.href || '',
            class: a.className || ''
        })).filter(a => a.text);
    });

    console.log('All links on page:');
    console.log(JSON.stringify(allLinks, null, 2));

    await browser.close();
}

checkVendorLinks();
