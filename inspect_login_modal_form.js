const { chromium } = require('playwright');

async function inspectModal() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    console.log('1. Opening home page...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    console.log('2. Clicking top account link...');
    await page.locator('a[href*="/account/login"]').first().click();

    console.log('3. Waiting for modal input...');
    await page.waitForSelector('#usernameemail', { state: 'visible', timeout: 10000 });

    const modalElements = await page.evaluate(() => {
        const modal = document.querySelector('.p-dialog, .modal, form, div[role="dialog"]') || document.body;
        return Array.from(modal.querySelectorAll('button, input, a, form')).map(e => ({
            tag: e.tagName,
            type: e.type || '',
            id: e.id || '',
            class: e.className || '',
            text: e.innerText ? e.innerText.trim() : '',
            value: e.value || ''
        }));
    });

    console.log('Modal form elements:', JSON.stringify(modalElements, null, 2));

    await browser.close();
}

inspectModal();
