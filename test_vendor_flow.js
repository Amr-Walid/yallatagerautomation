const { chromium } = require('playwright');

async function testVendorURLs() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Home page...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    console.log('2. Login...');
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(4000);

    // Try navigating to candidate vendor dashboard URLs
    const urlsToTest = [
        'https://yallatager.com/ar/vendor',
        'https://yallatager.com/ar/vendor/dashboard',
        'https://yallatager.com/ar/account/vendor',
        'https://yallatager.com/ar/vendor/products',
        'https://yallatager.com/ar/vendor/template'
    ];

    for (const url of urlsToTest) {
        console.log(`\nTesting URL: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2500);
        const title = await page.title();
        const text = await page.innerText('body');
        const hasVendorText = text.includes('شاشة تحكم البائع') || text.includes('أضف منتجات') || text.includes('V283') || text.includes('اختر القالب');
        console.log(`URL: ${page.url()} | Has Vendor Panel: ${hasVendorText}`);
        if (hasVendorText) {
            console.log(`🎯 FOUND VENDOR DASHBOARD AT: ${page.url()}`);
            await page.screenshot({ path: 'found_vendor_dashboard.png', fullPage: true });
        }
    }

    await browser.close();
}

testVendorURLs();
