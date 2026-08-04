const { chromium } = require('playwright');
const fs = require('fs');

async function debug() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    console.log('Navigating to login page...');
    await page.goto('https://yallatager.com/ar/account/login', { waitUntil: 'networkidle' });

    await page.screenshot({ path: 'login_page.png', fullPage: true });

    // Print all inputs or forms
    const html = await page.content();
    fs.writeFileSync('page.html', html);
    console.log('Saved login_page.png and page.html');

    const formInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(input => ({
            id: input.id,
            name: input.name,
            type: input.type,
            placeholder: input.placeholder,
            outerHTML: input.outerHTML
        }));
    });
    console.log('All inputs:', formInputs);

    await browser.close();
}

debug();
