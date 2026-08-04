const { chromium } = require('playwright');

async function testLoginModal() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Opening home page...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    console.log('2. Clicking top account/login link (a[href*="/account/login"])...');
    await page.locator('a[href*="/account/login"]').first().click();

    console.log('3. Waiting for #usernameemail to become visible...');
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    console.log('SUCCESS! Modal login inputs are visible.');

    console.log('4. Filling credentials...');
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');

    console.log('5. Clicking submit button...');
    await page.click('button[type="submit"]:has-text("تسجيل الدخول"), button:has-text("تسجيل الدخول")');
    await page.waitForTimeout(4000);

    console.log('Logged in! URL:', page.url());
    await page.screenshot({ path: 'logged_in.png' });

    await browser.close();
}

testLoginModal();
