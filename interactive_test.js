const { chromium } = require('playwright');

async function testHydratedLogin() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    console.log('1. Navigating to https://yallatager.com/ar ...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
    
    console.log('Waiting for Nuxt JS to hydrate (3s)...');
    await page.waitForTimeout(3000);

    console.log('2. Clicking login link...');
    const loginLink = page.locator('a[href*="/account/login"]').first();
    await loginLink.click();

    console.log('3. Waiting for #usernameemail...');
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 15000 });
    console.log('SUCCESS: #usernameemail visible!');

    console.log('4. Entering login details...');
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');

    console.log('5. Submitting login...');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(5000);

    console.log('Logged in! URL:', page.url());

    // Save session storage state so we don't need to re-login every time!
    await context.storageState({ path: 'auth_state.json' });
    console.log('Saved auth_state.json!');

    await browser.close();
}

testHydratedLogin();
