const { chromium } = require('playwright');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

async function runAutomation() {
    console.log('====================================================');
    console.log('🚀 بدأ تشغيل اسكربت أتمتة موقع "يلا تاجر" (YallaTager)');
    console.log('====================================================\n');

    // 1. قراءة ملف الأكسيل
    const excelPath = path.join(__dirname, 'YALLA.xlsx');
    console.log(`📂 جاري قراءة ملف الأكسيل: ${excelPath}`);
    
    let productCodes = [];
    try {
        const workbook = xlsx.readFile(excelPath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        
        productCodes = rawRows
            .slice(1)
            .map(row => row[0])
            .filter(code => code !== undefined && code !== null && String(code).trim() !== '');

        console.log(`✅ تم العثور على ${productCodes.length} كود منتج في الملف.`);
        console.log('الأكواد المكتشفة:', productCodes);
    } catch (err) {
        console.error('❌ خطأ في قراءة ملف الأكسيل:', err.message);
        return;
    }

    if (productCodes.length === 0) {
        console.log('⚠️ لا يوجد أكواد منتجات لمعالجتها.');
        return;
    }

    // 2. إعداد المتصفح والحساب المحفوظ
    const authPath = path.join(__dirname, 'auth_state.json');
    const launchOptions = { headless: false, slowMo: 200 };
    const contextOptions = { viewport: { width: 1280, height: 800 } };
    
    if (fs.existsSync(authPath)) {
        contextOptions.storageState = authPath;
        console.log('🔐 تم تحميل جلسة تسجيل الدخول المحفوظة.');
    }

    console.log('\n🌐 جاري فتح المتصفح...');
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
        // 3. الانتقال للموقع وتأكيد الدخول
        console.log('🔗 جاري الانتقال لموقع يلا تاجر...');
        await page.goto('https://yallatager.com/ar', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        const emailInput = page.locator('#usernameemail');
        const loginLink = page.locator('a[href*="/account/login"]').first();

        if (await loginLink.isVisible()) {
            console.log('👤 جاري تسجيل الدخول بالحساب...');
            await loginLink.click();
            await page.waitForTimeout(2000);

            if (await emailInput.isVisible()) {
                await emailInput.fill('Drmobile2009@gmail.com');
                await page.fill('input[type="password"]', 'DR@123456');
                await page.click('button:has-text("يلا سجل الدخول"), button.btn-mainAction');
                await page.waitForTimeout(5000);
                
                await context.storageState({ path: authPath }).catch(() => {});
                console.log('✅ تم تسجيل الدخول وحفظ الجلسة.');
            }
        }

        // 4. الانتقال إلى "افتح متجرك"
        console.log('\n🏪 جاري الانتقال إلى "افتح متجرك"...');
        const openStoreBtn = page.locator('a:has-text("افتح متجرك"), span:has-text("افتح متجرك")').first();
        if (await openStoreBtn.isVisible()) {
            await openStoreBtn.scrollIntoViewIfNeeded();
            await openStoreBtn.click();
            await page.waitForTimeout(4000);
        } else {
            await page.goto('https://yallatager.com/ar/vendor', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(4000);
        }

        // 5. النقر على "أضف منتجات"
        console.log('➕ جاري النقر على "أضف منتجات"...');
        const addProductLink = page.locator('a:has-text("أضف منتجات"), span:has-text("أضف منتجات")').first();
        if (await addProductLink.isVisible()) {
            await addProductLink.click();
            await page.waitForTimeout(4000);
        }

        // 6. اختيار الفئة "إكسسوارات الموبايل"
        console.log('📱 جاري اختيار الفئة "إكسسوارات الموبايل"...');
        const categoryDropdown = page.locator('.p-dropdown, select, div:has-text("اختر الفئة")').first();
        if (await categoryDropdown.isVisible()) {
            await categoryDropdown.click();
            await page.waitForTimeout(1000);
            
            const mobileOption = page.locator('li:has-text("إكسسوارات الموبايل"), option:has-text("إكسسوارات الموبايل")').first();
            if (await mobileOption.isVisible()) {
                await mobileOption.click();
                console.log('✅ تم اختيار فئة "إكسسوارات الموبايل".');
                await page.waitForTimeout(2000);
            }
        }

        // 7. المعالجة التكرارية لكل منتج
        console.log('\n====================================================');
        console.log('📦 جاري بدء البحث والتسريل لكل منتج...');
        console.log('====================================================');

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < productCodes.length; i++) {
            const code = String(productCodes[i]).trim();
            console.log(`\n[${i + 1}/${productCodes.length}] 🔍 البحث عن كود المنتج: ${code}`);

            try {
                // البحث بكود المنتج
                const searchInput = page.locator('input[placeholder*="بحث بالاسم"], input[placeholder*="الكود"], input[placeholder*="بحث"]').last();
                if (await searchInput.isVisible()) {
                    await searchInput.focus();
                    await searchInput.fill('');
                    await searchInput.fill(code);
                    await page.waitForTimeout(400);

                    // الضغط على زر البحث أو Enter
                    const searchBtn = page.locator('button:has-text("أبحث"), a:has-text("أبحث"), div:has-text("أبحث")').first();
                    if (await searchBtn.isVisible()) {
                        await searchBtn.click();
                    } else {
                        await searchInput.press('Enter');
                    }
                    await page.waitForTimeout(3500);
                }

                // النقر على كارت النتيجة الأولى
                const firstResult = page.locator(`.p-card, div[class*="product"], div[style*="cursor"], :text("${code}")`).first();
                if (await firstResult.isVisible()) {
                    console.log('📌 تم إيجاد المنتج، جاري النقر عليه...');
                    await firstResult.click();
                    await page.waitForTimeout(2000);

                    // الضغط على زر "أحفظ المنتج" أو "أضف المنتج"
                    const saveBtn = page.locator('button:has-text("أحفظ المنتج"), button:has-text("أضف المنتج")').first();
                    if (await saveBtn.isVisible()) {
                        await saveBtn.click();
                        console.log(`✅ [نجاح] تم حفظ/إضافة المنتج: ${code}`);
                        successCount++;
                        await page.waitForTimeout(3000);
                    } else {
                        console.log(`⚠️ زر الحفظ لم يظهر للمنتج: ${code}`);
                        failCount++;
                    }
                } else {
                    console.log(`⚠️ لم يتم العثور على نتيجة لكود المنتج: ${code}`);
                    failCount++;
                }

            } catch (productError) {
                console.error(`❌ خطأ أثناء معالجة المنتج ${code}:`, productError.message);
                failCount++;
            }
        }

        console.log('\n====================================================');
        console.log('🎉 اكتملت العملية لجميع المنتجات!');
        console.log(`📊 عدد المنتجات المضافة بنجاح: ${successCount}`);
        console.log(`⚠️ عدد المنتجات المتبقية/غير المضافة: ${failCount}`);
        console.log('====================================================');

    } catch (err) {
        console.error('❌ خطأ رئيسي أثناء تشغيل الأتمتة:', err.message);
    } finally {
        console.log('\n🔒 العملية مكتملة.');
    }
}

runAutomation();
