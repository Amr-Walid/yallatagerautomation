const { chromium } = require('playwright');

async function printAccountText() {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    console.log('1. Navigating & Logging in...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.locator('a[href*="/account/login"]').first().click();
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });
    await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
    await page.fill('input[type="password"]', 'DR@123456');
    await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
    await page.waitForTimeout(5000);

    console.log('2. Going to /ar/account ...');
    await page.goto('https://yallatager.com/ar/account', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('Current URL:', page.url());

    // Print all div / card texts
    const cards = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a, button, div.card, div[class*="box"], div[class*="vendor"], h1, h2, h3, h4, h5, h6')).map(el => ({
            tag: el.tagName,
            text: el.innerText ? el.innerText.trim() : '',
            href: el.href || ''
        })).filter(el => el.text && el.text.length < 100);
    });

    console.log('Account Page Cards & Titles:');
    console.log(JSON.stringify(cards, null, 2));

    await browser.close();
}

printAccountText();
