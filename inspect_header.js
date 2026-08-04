const { chromium } = require('playwright');

async function inspectHeader() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    const headerElements = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('header *')).map(el => ({
            tag: el.tagName,
            class: el.className,
            text: el.innerText ? el.innerText.trim() : '',
            href: el.href || '',
            id: el.id || ''
        })).filter(item => item.text || item.href || item.class || item.id);
    });

    console.log('Header elements:', JSON.stringify(headerElements, null, 2));

    await browser.close();
}

inspectHeader();
