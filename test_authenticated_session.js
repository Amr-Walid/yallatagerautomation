const { chromium } = require('playwright');
const path = require('path');

async function testAuthSession() {
    const authStatePath = path.join(__dirname, 'auth_state.json');
    console.log('Loading session from auth_state.json...');

    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const context = await browser.newContext({
        storageState: authStatePath,
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    console.log('1. Navigating to home page with saved login session...');
    await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('2. Clicking "افتح متجرك" in footer...');
    const openStoreBtn = page.locator('a:has-text("افتح متجرك")').first();
    if (await openStoreBtn.isVisible()) {
        await openStoreBtn.scrollIntoViewIfNeeded();
        await openStoreBtn.click();
        await page.waitForTimeout(4000);
    }
    console.log('URL after clicking "افتح متجرك":', page.url());
    await page.screenshot({ path: 'auth_step1_vendor.png', fullPage: true });

    // Click "أضف منتجات"
    console.log('3. Clicking "أضف منتجات"...');
    const addProductLink = page.locator('a:has-text("أضف منتجات"), span:has-text("أضف منتجات")').first();
    if (await addProductLink.isVisible()) {
        await addProductLink.click();
        await page.waitForTimeout(4000);
        console.log('URL after clicking "أضف منتجات":', page.url());
        await page.screenshot({ path: 'auth_step2_add_products.png', fullPage: true });
    } else {
        console.log('"أضف منتجات" not found directly, page body text preview:');
        console.log((await page.innerText('body')).slice(0, 500));
    }

    await browser.close();
}

testAuthSession();
