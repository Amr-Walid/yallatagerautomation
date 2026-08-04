const { chromium } = require('playwright');

async function findLoginBtn() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const page = await browser.newPage();
    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    // Find all clickable icons/links at top of page
    const topLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a, button, div, span, i')).map(e => ({
            tag: e.tagName,
            class: e.className,
            id: e.id,
            text: e.innerText ? e.innerText.trim() : '',
            href: e.href || '',
            html: e.outerHTML.slice(0, 100)
        })).filter(e => e.href.includes('login') || e.href.includes('account') || e.text.includes('تسجيل') || e.text.includes('حسابي') || e.class.includes('user') || e.class.includes('account') || e.class.includes('login'));
    });

    console.log('Top login/account elements found:', topLinks);

    await browser.close();
}

findLoginBtn();
