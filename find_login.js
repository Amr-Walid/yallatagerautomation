const { chromium } = require('playwright');

async function findLoginInputs() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();

    console.log('Navigating to https://yallatager.com/ar/account/login...');
    await page.goto('https://yallatager.com/ar/account/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // DUMP ALL TEXT & BUTTONS ON PAGE
    const elements = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, input, div, span, form'));
        return els.map(e => ({
            tag: e.tagName,
            id: e.id,
            class: e.className,
            text: e.innerText ? e.innerText.slice(0, 50).trim() : '',
            type: e.type || '',
            placeholder: e.placeholder || ''
        })).filter(e => e.text.includes('دخول') || e.text.includes('تسجيل') || e.tag === 'INPUT');
    });

    console.log('Relevant elements on login URL:');
    console.log(JSON.stringify(elements, null, 2));

    await page.screenshot({ path: 'login_url_screen.png', fullPage: true });

    await browser.close();
}

findLoginInputs();
