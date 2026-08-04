const { chromium } = require('playwright');

async function findVendorRoutes() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

    // Fetch page source and find all paths starting with /ar/vendor
    const html = await page.content();
    const vendorMatches = Array.from(html.matchAll(/\/ar\/vendor[a-zA-Z0-9_\-\/]*/g)).map(m => m[0]);
    const uniqueRoutes = Array.from(new Set(vendorMatches));

    console.log('Discovered vendor routes in HTML:', uniqueRoutes);

    await browser.close();
}

findVendorRoutes();
