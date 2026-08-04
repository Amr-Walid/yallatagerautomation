const { chromium } = require('playwright');

async function testDirectLogin() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Direct goto to https://yallatager.com/ar/account/login ...');
    await page.goto('https://yallatager.com/ar/account/login', { waitUntil: 'networkidle' });

    // Check if #usernameemail is present or if we need to click "تسجيل الدخول"
    console.log('Current URL:', page.url());
    const loginLink = page.locator('a[href*="/account/login"]').first();
    if (await loginLink.isVisible()) {
        console.log('Clicking login link on page...');
        await loginLink.click();
        await page.waitForTimeout(2000);
    }

    console.log('Waiting for #usernameemail...');
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    console.log('Found #usernameemail!');

    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(5000);

    console.log('After login URL:', page.url());
    await page.screenshot({ path: 'after_direct_login.png', fullPage: true });

    // Navigate to Vendor page directly
    console.log('Navigating to https://yallatager.com/ar/vendor ...');
    await page.goto('https://yallatager.com/ar/vendor', { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    console.log('URL at /ar/vendor:', page.url());
    await page.screenshot({ path: 'vendor_direct_screen.png', fullPage: true });

    // Dump all links on vendor screen
    const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({ text: a.innerText ? a.innerText.trim() : '', href: a.href }));
    });
    console.log('Vendor page links:', JSON.stringify(links, null, 2));

    await browser.close();
}

testDirectLogin();
