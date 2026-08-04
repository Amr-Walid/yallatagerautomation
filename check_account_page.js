const { chromium } = require('playwright');

async function checkAccountPage() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('1. Navigating to home...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('2. Opening login modal...');
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });

    console.log('3. Logging in...');
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(5000);

    console.log('4. Navigating to https://yallatager.com/ar/account ...');
    await page.goto('https://yallatager.com/ar/account', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('URL at /ar/account:', page.url());
    await page.screenshot({ path: 'account_page_screen.png', fullPage: true });

    // Print all links/buttons on account page
    const elements = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a, button, div[class*="menu"], li')).map(el => ({
            tag: el.tagName,
            text: el.innerText ? el.innerText.trim() : '',
            href: el.href || '',
            class: el.className || ''
        })).filter(el => el.text);
    });

    console.log('Account Page Elements:');
    console.log(JSON.stringify(elements, null, 2));

    await browser.close();
}

checkAccountPage();
