const { chromium } = require('playwright');

async function testFullWorkflow() {
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
        console.log('1. Navigating to https://yallatager.com/ar ...');
        await page.goto('https://yallatager.com/ar', { waitUntil: 'networkidle' });

        console.log('2. Clicking header login icon...');
        const headerLogin = page.locator('.headerAccountIcon, header a[href*="login"], header button, .headerUserIcon').first();
        if (await headerLogin.isVisible()) {
            await headerLogin.click();
        } else {
            console.log('Clicking text "تسجيل الدخول" in header...');
            await page.click('header :text("تسجيل الدخول")');
        }

        console.log('3. Waiting for username input (#usernameemail)...');
        await page.waitForSelector('#usernameemail', { timeout: 10000 });
        console.log('Found #usernameemail! Filling credentials...');
        
        await page.fill('#usernameemail', 'Drmobile2009@gmail.com');
        await page.fill('input[type="password"]', 'DR@123456');

        console.log('4. Clicking login button...');
        await page.click('button[type="submit"]:has-text("تسجيل الدخول"), button:has-text("تسجيل الدخول"), .btn-dark:has-text("تسجيل الدخول")');
        await page.waitForTimeout(4000);
        
        console.log('Logged in successfully! Current URL:', page.url());
        await page.screenshot({ path: 'after_login.png' });

        console.log('5. Clicking "افتح متجرك" in footer...');
        const openStoreBtn = page.locator('a:has-text("افتح متجرك")').first();
        await openStoreBtn.scrollIntoViewIfNeeded();
        await openStoreBtn.click();
        await page.waitForTimeout(4000);
        console.log('URL after clicking "افتح متجرك":', page.url());
        await page.screenshot({ path: 'vendor_dashboard.png' });

        console.log('6. Clicking "أضف منتجات" sidebar link...');
        const addProductLink = page.locator('a:has-text("أضف منتجات"), text=أضف منتجات').first();
        await addProductLink.click();
        await page.waitForTimeout(4000);
        console.log('URL at Add Products:', page.url());
        await page.screenshot({ path: 'add_products_page.png' });

    } catch (err) {
        console.error('Error during test:', err);
    } finally {
        await browser.close();
    }
}

testFullWorkflow();
