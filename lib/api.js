'use strict';
/**
 * عميل API لموقع "يلا تاجر" (YallaTager)
 * -------------------------------------------------
 * الموقع مبني على Nuxt 3 (SSR) + باك إند Magento عبر REST.
 * صفحات /account/login و /vendor/add-products حالياً واقعة بخطأ SSR
 * ("Named export 'VueTelInput' not found") ولذلك الأتمتة عن طريق المتصفح
 * مستحيلة. الحل: التعامل مع الـ REST API نفسه الذي يستخدمه الموقع.
 */

const API_BASE = process.env.YALLA_API_BASE || 'https://backend.yallatager.com';

// نفس المفاتيح التي يرسلها الموقع من متصفح المستخدم (public keys)
const API_KEY =
  process.env.YALLA_API_KEY ||
  '4d7gHyeww7naMlfjJKakFgJz9ag2fkCE8zfHDdnbnhurtby1a13sy62HvrbqmptkAj1MCHwaJkCEz6p45gptOuv0qsINzkOd8Af7';
const API_CODE = process.env.YALLA_API_CODE || 'cjbthepc92mpecqmtytn';

const ENDPOINTS = {
  login: 'epowercrm/account/login',
  logout: 'epowercrm/account/logout',
  accountData: 'epowercrm/account/getAccountData',
  categoriesByLevel: 'core/categories/getByLevel',
  categoryTree: 'core/categories/getTree',
  sellerTemplates: 'epowermarketplace/seller/gettemplates',
  sellerTemplateData: 'epowermarketplace/seller/getTemplateEditableData',
  sellerCustomerGroups: 'epowermarketplace/seller/getCustomerGroups',
  sellerCreateRequest: 'epowermarketplace/seller/createrequest',
  sellerProducts: 'epowermarketplace/seller/getproducts',
  sellerFormData: 'epowermarketplace/seller/getSellerFormData',
};

/** أخطاء الباك إند المؤقتة التي تستحق إعادة المحاولة */
const RETRYABLE_ERROR_CODES = new Set([
  'marketplace_sellerproduct_100', // "There was a problem while loading products or templates."
]);

const { Throttle } = require('./throttle');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class YallaApiError extends Error {
  constructor(message, { code = null, endpoint = null, response = null } = {}) {
    super(message);
    this.name = 'YallaApiError';
    this.code = code;
    this.endpoint = endpoint;
    this.response = response;
  }
}

class YallaClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.storeView='ar']  اللغة/المتجر (ar | en)
   * @param {number} [opts.retries=4]       عدد المحاولات لكل طلب
   * @param {number} [opts.timeoutMs=60000] مهلة الطلب
   * @param {function} [opts.logger]        دالة لتسجيل الأحداث
   * @param {Throttle} [opts.throttle]      طبقة حماية السيرفر (طابور + كاش + قاطع)
   */
  constructor(opts = {}) {
    this.storeView = opts.storeView || 'ar';
    this.retries = opts.retries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.log = opts.logger || (() => {});
    this.cookies = new Map();
    this.sessionId = null;
    this.account = null;
    this.vendorId = null;
    // طبقة الحماية: لو لم تُمرَّر، ننشئ واحدة بإعدادات لطيفة على السيرفر
    this.throttle = opts.throttle || new Throttle({ onWait: ({ reason, ms }) => {
      if (reason === 'circuit-trip') this.log(`⏸ توقّف مؤقت ${Math.ceil(ms / 1000)}ث لحماية سيرفر يلا تاجر`);
    } });
  }

  /** إحصائيات الاستهلاك — كم طلباً أُرسل وكم وفّرنا */
  get usage() {
    const s = this.throttle.stats;
    return {
      requests: s.requests,
      cachedHits: s.cacheHits,
      failures: s.failures,
      circuitTrips: s.circuitTrips,
      waitedSeconds: Math.round(s.waitedMs / 100) / 10,
    };
  }

  get cookieHeader() {
    return [...this.cookies.values()].join('; ');
  }

  /** تخزين واستبدال الكوكيز القادمة من الرد (مع حذف "deleted") */
  _absorbCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const key = pair.slice(0, idx);
      const val = pair.slice(idx + 1);
      if (!val || val === 'deleted') this.cookies.delete(key);
      else this.cookies.set(key, pair);
    }
  }

  /** الطلب الشبكي الخام — لا يُستدعى مباشرة، يمرّ دائماً عبر call() */
  async _fetchOnce(endpoint, body) {
    const headers = { 'Content-Type': 'application/json', APIKEY: API_KEY, APICODE: API_CODE };
    const cookie = this.cookieHeader;
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(`${API_BASE}/restfulapi/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this._absorbCookies(res);

    if ([502, 503, 504].includes(res.status)) {
      throw new YallaApiError(`الخدمة غير متاحة مؤقتاً (HTTP ${res.status})`, { endpoint });
    }
    if (res.status === 429) {
      throw new YallaApiError('السيرفر يطلب تقليل معدّل الطلبات (HTTP 429)', { endpoint });
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new YallaApiError(`رد غير صالح من الخادم (HTTP ${res.status})`, {
        endpoint,
        response: text.slice(0, 300),
      });
    }
  }

  /**
   * طلب POST إلى الـ REST API — يمرّ إجبارياً عبر طبقة الحماية:
   * طابور تسلسلي + فاصل زمني + ذاكرة مؤقتة + قاطع دائرة.
   * يرجع جسم الرد كـ JSON (بدون رمي استثناء عند success:false).
   *
   * @param {object} [opts]
   * @param {string} [opts.cacheKey] لتخزين النتيجة وتجنّب تكرار الطلب
   */
  async call(endpoint, body = {}, { retries = this.retries, cacheKey = null } = {}) {
    return this.throttle.run(async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const json = await this._fetchOnce(endpoint, body);
          const code = json && json.error && json.error.code;
          if (json && json.success === false && RETRYABLE_ERROR_CODES.has(code) && attempt < retries) {
            this.log(`↻ إعادة محاولة (${attempt}/${retries - 1}) لـ ${endpoint} بسبب ${code}`);
            await sleep(1200 * attempt);
            continue;
          }
          return json;
        } catch (err) {
          lastError = err;
          if (attempt < retries) {
            this.log(`↻ إعادة محاولة (${attempt}/${retries - 1}) لـ ${endpoint}: ${err.message}`);
            await sleep(1200 * attempt);
          }
        }
      }
      throw lastError || new YallaApiError(`فشل الطلب: ${endpoint}`, { endpoint });
    }, { cacheKey, label: endpoint });
  }

  /** يرمي استثناء عند success:false */
  async callStrict(endpoint, body, opts) {
    const json = await this.call(endpoint, body, opts);
    if (!json || json.success !== true) {
      const err = (json && json.error) || {};
      throw new YallaApiError(err.message || `فشل الطلب: ${endpoint}`, {
        code: err.code || null,
        endpoint,
        response: json,
      });
    }
    return json;
  }

  // ------------------------------------------------------------------ الحساب

  async login(email, password) {
    const res = await this.callStrict(ENDPOINTS.login, {
      usernameemail: email,
      password,
      persistent_remember_me: false,
    });
    this.sessionId = res.sessionId || null;
    return res;
  }

  async getAccountData() {
    const res = await this.callStrict(ENDPOINTS.accountData, {});
    this.account = res.account_data || null;
    return res;
  }

  // ------------------------------------------------------------------ الفئات

  async getCategories(level = 2) {
    const res = await this.callStrict(
      ENDPOINTS.categoriesByLevel,
      { store_view: this.storeView, level },
      { cacheKey: `cats:${this.storeView}:${level}` }
    );
    return res.items || [];
  }

  /** شجرة الفئات كاملة (للاختيار في الواجهة) */
  async getCategoryTree() {
    const res = await this.callStrict(
      ENDPOINTS.categoryTree,
      { store_view: this.storeView },
      { cacheKey: `catTree:${this.storeView}` }
    );
    return res.items || res.tree || [];
  }

  // ------------------------------------------------------- قوالب منتجات البائع

  /**
   * البحث في قوالب المنتجات المتاحة للبائع.
   * ⚠️ `category_id` إجباري — بدونه يرد الباك إند بخطأ
   * marketplace_sellerproduct_100 دائماً.
   */
  async searchTemplates({ query, categoryId, page = 1, limit = 20 }) {
    if (categoryId == null) {
      throw new YallaApiError('category_id إجباري في بحث القوالب');
    }
    const res = await this.call(
      ENDPOINTS.sellerTemplates,
      {
        store_view: this.storeView,
        category_id: categoryId,
        query: query || '',
        page,
        limit,
      },
      { cacheKey: `tpl:${this.storeView}:${categoryId}:${query || ''}:${page}:${limit}` }
    );
    if (res && res.success === true) {
      return { templates: res.templates || [], pager: res.pager || null };
    }
    const err = (res && res.error) || {};
    // نتيجة فارغة ≠ خطأ حقيقي
    return { templates: [], pager: null, error: { code: err.code || null, message: err.message || '' } };
  }

  async getTemplateData(templateId) {
    const res = await this.callStrict(
      ENDPOINTS.sellerTemplateData,
      { store_view: this.storeView, template_id: String(templateId) },
      { cacheKey: `tplData:${this.storeView}:${templateId}` }
    );
    return res.template || null;
  }

  /**
   * مجموعات العملاء المسموح للبائع بتسعيرها.
   * ⚠️ هذه هي المصدر الصحيح لـ group_price (ترجع "Wholesale"/2 فقط)،
   * وليس `template.customer_groups` التي ترجع أيضاً "Blacklist"/7.
   * هكذا تفعل صفحة /vendor/add-products بالضبط.
   */
  async getCustomerGroups() {
    const res = await this.call(
      ENDPOINTS.sellerCustomerGroups,
      { store_view: this.storeView },
      { cacheKey: `groups:${this.storeView}` }
    );
    return (res && res.items) || [];
  }

  // ------------------------------------------------------------- بيانات البائع

  /** بيانات التاجر — تُستخدم للحصول على vendor_id (إجباري في getproducts) */
  async getSellerFormData() {
    const res = await this.call(
      ENDPOINTS.sellerFormData,
      { store_view: this.storeView },
      { cacheKey: `sellerForm:${this.storeView}` }
    );
    if (res && res.success === true) {
      this.vendorId = res.vendor_id || null;
      return res;
    }
    const err = (res && res.error) || {};
    throw new YallaApiError(err.message || 'تعذر جلب بيانات التاجر', {
      code: err.code || null,
      endpoint: ENDPOINTS.sellerFormData,
    });
  }

  /** يضمن توفّر vendorId */
  async ensureVendorId() {
    if (!this.vendorId) await this.getSellerFormData();
    return this.vendorId;
  }

  /**
   * سرد منتجات البائع المنشورة (كل الصفحات).
   * ⚠️ `seller_id` إجباري — بدونه يرد الباك إند دائماً
   * marketplace_seller_108 "Cannot load seller."
   *
   * ملاحظة مهمة: الطلبات المعلّقة (التي أُضيفت للتوّ ولم تُعتمد بعد)
   * لا تظهر هنا، لذلك لا يكفي هذا وحده لمنع التكرار.
   */
  async listSellerProducts({ limit = 200, maxPages = 50 } = {}) {
    const sellerId = await this.ensureVendorId();
    const items = [];
    let page = 1;
    let pages = 1;
    do {
      const res = await this.call(ENDPOINTS.sellerProducts, {
        store_view: this.storeView,
        seller_id: sellerId,
        page,
        limit,
      });
      if (!res || !res.items) break;
      pages = Number((res.pager && res.pager.pages) || 1);
      items.push(...res.items);
      page++;
    } while (page <= pages && page <= maxPages);
    return items;
  }

  /** مجموعة أرقام القوالب المنشورة بالفعل — لمنع التكرار */
  async getPublishedTemplateIds(opts) {
    const items = await this.listSellerProducts(opts);
    return new Set(items.map((i) => String(i.template_id)));
  }

  // -------------------------------------------------------------- حفظ المنتج

  /**
   * حفظ/إضافة منتج لحساب البائع (نفس جسم صفحة /vendor/add-products).
   *
   * قواعد الباك إند المكتشفة بالتجربة:
   *   • `price_data.price` و `price_data.group_price` كلاهما **إجباري**؛
   *     نقص أيٍّ منهما ⇒ marketplace_seller_133
   *     "You must add group prices and validate price."
   *   • `group_price` يكفي فيها المجموعة "2" (Wholesale) من getCustomerGroups().
   *   • `inventory_data.quantity` اختيارية (يمكن تركها فارغة).
   *   • ⚠️ لا يوجد منع تكرار: كل نداء يُنشئ طلباً جديداً، فالتحقق مسؤوليتنا.
   */
  async saveProduct({
    templateId,
    productData = {},
    inventoryData = { backorders: '', quantity: '' },
    priceData = { price: '', group_price: [], special_price: '', special_from_date: null, special_to_date: null },
    configurableInventoryData = {},
    configurablePricesData = {},
  }) {
    return this.call(ENDPOINTS.sellerCreateRequest, {
      template_id: String(templateId),
      product_data: productData,
      inventory_data: inventoryData,
      price_data: priceData,
      configurable_inventory_data: configurableInventoryData,
      configurable_prices_data: configurablePricesData,
    });
  }
}

module.exports = { YallaClient, YallaApiError, ENDPOINTS, API_BASE };
