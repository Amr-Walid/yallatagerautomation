const { chromium } = require('playwright');

async function findSellerLink() {
    const browser = await chromium.launch({ headless: false, slowMo: 400 });
    const page = await browser.newPage();

    console.log('1. Navigating to home page...');
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

    console.log('Logged in URL:', page.url());

    // Print all links in header and top bar now that we are logged in!
    const loggedInLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a, button, div[class*="user"], div[class*="account"]')).map(el => ({
            text: el.innerText ? el.innerText.trim() : '',
            href: el.href || '',
            class: el.className || '',
            outerHTML: el.outerHTML.slice(0, 150)
        })).filter(el => el.text || el.href);
    });

    console.log('All elements after login:');
    console.log(JSON.stringify(loggedInLinks, null, 2));

    await page.screenshot({ path: 'after_login_header.png', fullPage: true });

    await browser.close();
}

findSellerLink();
