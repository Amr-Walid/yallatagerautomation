'use strict';
/**
 * طبقة حماية سيرفر "يلا تاجر" من الإجهاد.
 * ==========================================
 * هدفها: أقل عدد ممكن من الطلبات، وبأقصى لطف ممكن. تحتوي على:
 *
 *  1) طابور تسلسلي (Serial Queue)
 *     طلب واحد فقط في كل لحظة لكل حساب — لا تفريع متزامن مهما كان
 *     عدد الصفوف. ده يمنع أي "burst" على السيرفر.
 *
 *  2) فاصل زمني إجباري (Min Interval)
 *     مسافة زمنية دنيا بين أي طلبين متتاليين، مع "jitter" عشوائي
 *     حتى لا يبدو النمط آلياً منتظماً.
 *
 *  3) ذاكرة مؤقتة (Cache)
 *     نتائج البحث والفئات وبيانات القوالب تُحفظ، فالأكواد المكرّرة
 *     في الإكسل لا تُكلّف السيرفر أي طلب إضافي.
 *
 *  4) قاطع الدائرة (Circuit Breaker)
 *     لو تكررت الأخطاء، نتوقف مؤقتاً تماماً بدل ما نكمل ضرب على سيرفر
 *     متعب. ثم نستأنف تدريجياً.
 *
 *  5) تهدئة تدريجية (Adaptive Backoff)
 *     كل خطأ يزيد الفاصل الزمني تلقائياً، وكل نجاح يقلّله بهدوء.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CircuitOpenError extends Error {
  constructor(waitMs) {
    super(`تم إيقاف الطلبات مؤقتاً لحماية السيرفر. المحاولة بعد ${Math.ceil(waitMs / 1000)} ثانية.`);
    this.name = 'CircuitOpenError';
    this.waitMs = waitMs;
  }
}

class Throttle {
  /**
   * @param {object} [o]
   * @param {number} [o.minIntervalMs=1200]  أدنى فاصل بين الطلبات
   * @param {number} [o.maxIntervalMs=8000]  أقصى فاصل عند التهدئة
   * @param {number} [o.jitterMs=400]        تشويش عشوائي يُضاف للفاصل
   * @param {number} [o.failureThreshold=5]  عدد الأخطاء المتتالية لفتح القاطع
   * @param {number} [o.cooldownMs=30000]    مدة التوقف عند فتح القاطع
   * @param {number} [o.cacheTtlMs=600000]   عمر الذاكرة المؤقتة (10 دقائق)
   * @param {function} [o.onWait]            إشعار عند الانتظار الطويل
   */
  constructor(o = {}) {
    this.minIntervalMs = o.minIntervalMs ?? 1200;
    this.baseIntervalMs = this.minIntervalMs;
    this.maxIntervalMs = o.maxIntervalMs ?? 8000;
    this.jitterMs = o.jitterMs ?? 400;
    this.failureThreshold = o.failureThreshold ?? 5;
    this.cooldownMs = o.cooldownMs ?? 30000;
    this.cacheTtlMs = o.cacheTtlMs ?? 600000;
    this.onWait = o.onWait || (() => {});

    this._chain = Promise.resolve(); // الطابور التسلسلي
    this._lastAt = 0;
    this._consecutiveFailures = 0;
    this._openUntil = 0;
    this._cache = new Map();

    this.stats = { requests: 0, cacheHits: 0, waitedMs: 0, failures: 0, circuitTrips: 0 };
  }

  /** إجمالي ما وفّرناه على السيرفر من طلبات */
  get savedRequests() {
    return this.stats.cacheHits;
  }

  _cacheGet(key) {
    const hit = this._cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.cacheTtlMs) {
      this._cache.delete(key);
      return undefined;
    }
    this.stats.cacheHits++;
    return hit.value;
  }

  _cacheSet(key, value) {
    this._cache.set(key, { at: Date.now(), value });
  }

  /**
   * تنفيذ مهمة داخل الطابور مع احترام كل القيود.
   * @param {function():Promise<any>} task
   * @param {object} [opts]
   * @param {string} [opts.cacheKey] مفتاح الذاكرة المؤقتة
   * @param {string} [opts.label]    وصف للتسجيل
   */
  run(task, opts = {}) {
    const { cacheKey } = opts;

    // ذاكرة مؤقتة: نجيب بدون أي طلب شبكة ولا حتى انتظار الطابور
    if (cacheKey) {
      const cached = this._cacheGet(cacheKey);
      if (cached !== undefined) return Promise.resolve(cached);
    }

    // الطابور: نضيف المهمة لآخر السلسلة فتُنفّذ بالترتيب
    const result = this._chain.then(async () => {
      // إعادة فحص الذاكرة — ربما طلب سابق في الطابور جاب نفس البيانات
      if (cacheKey) {
        const again = this._cacheGet(cacheKey);
        if (again !== undefined) return again;
      }

      // قاطع الدائرة مفتوح؟ ننتظر حتى ينغلق
      const now = Date.now();
      if (this._openUntil > now) {
        const wait = this._openUntil - now;
        this.onWait({ reason: 'circuit', ms: wait });
        this.stats.waitedMs += wait;
        await sleep(wait);
      }

      // الفاصل الزمني الإجباري + تشويش
      const since = Date.now() - this._lastAt;
      const need = this.baseIntervalMs + Math.floor(Math.random() * this.jitterMs);
      if (since < need) {
        const wait = need - since;
        if (wait > 2500) this.onWait({ reason: 'throttle', ms: wait });
        this.stats.waitedMs += wait;
        await sleep(wait);
      }

      this._lastAt = Date.now();
      this.stats.requests++;

      try {
        const value = await task();
        this._onSuccess();
        if (cacheKey) this._cacheSet(cacheKey, value);
        return value;
      } catch (err) {
        this._onFailure();
        throw err;
      }
    });

    // نحافظ على السلسلة سليمة حتى لو فشلت مهمة
    this._chain = result.then(() => {}, () => {});
    return result;
  }

  _onSuccess() {
    this._consecutiveFailures = 0;
    // تقليل الفاصل بهدوء نحو القيمة الأساسية
    if (this.baseIntervalMs > this.minIntervalMs) {
      this.baseIntervalMs = Math.max(this.minIntervalMs, Math.floor(this.baseIntervalMs * 0.85));
    }
  }

  _onFailure() {
    this.stats.failures++;
    this._consecutiveFailures++;
    // تهدئة: نضاعف الفاصل عند كل خطأ
    this.baseIntervalMs = Math.min(this.maxIntervalMs, Math.floor(this.baseIntervalMs * 1.8) || 1000);

    if (this._consecutiveFailures >= this.failureThreshold) {
      this._openUntil = Date.now() + this.cooldownMs;
      this._consecutiveFailures = 0;
      this.stats.circuitTrips++;
      this.onWait({ reason: 'circuit-trip', ms: this.cooldownMs });
    }
  }
}

module.exports = { Throttle, CircuitOpenError };
