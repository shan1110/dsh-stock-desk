/**
 * 缓存与数据源健康度
 *
 * 为什么需要这两件事：
 * 1. 客户端在盘中会按秒轮询，而同一个数据源可以被多个入口同时请求（整页、药丸、agent 工具）。
 *    没有合并（coalesce）就会对同一个 URL 发 N 份并发请求，把免费接口打挂。
 * 2. 三个数据源各自会挂。挂掉时不能让上层拿到「上一次的旧值」当成新值——
 *    行情显示陈旧数据比显示「拿不到」危险得多。
 *
 * @author cai shan
 * @date 2026-10-19 14:12
 */

/** 默认单次请求超时；免费接口在盘中偶发不响应，5 秒足够判定 */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 带 TTL 与并发合并的缓存。
 *
 * 同一个 key 上并发的 loader 只执行一次，其余调用共享这一次的结果。
 * @param {{now?: () => number}} [opts]
 */
export function createCache(opts = {}) {
  const now = opts.now ?? Date.now;
  /** key -> { value, at, ttl } */
  const entries = new Map();
  /** key -> Promise，同一 key 的并发请求共享 */
  const inflight = new Map();
  let hits = 0;
  let misses = 0;

  /**
   * 取一个值，过期则调用 loader 重取。
   *
   * loader 抛错时**不返回旧值**，而是把错误抛给调用方——由调用方决定怎么向用户解释。
   * @param {string} key
   * @param {number} ttlMs
   * @param {(signal: AbortSignal) => Promise<unknown>} loader
   * @param {{signal?: AbortSignal, force?: boolean}} [o]
   */
  async function get(key, ttlMs, loader, o = {}) {
    const hit = entries.get(key);
    if (!o.force && hit && now() - hit.at < hit.ttl) {
      hits++;
      return hit.value;
    }

    const running = inflight.get(key);
    if (running && !o.force) return running;

    misses++;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const task = (async () => {
      try {
        const value = await loader(ctl.signal);
        entries.set(key, { value, at: now(), ttl: ttlMs });
        return value;
      } finally {
        // 只在 inflight 里仍然是本次任务时才删除：force 重取会覆盖同一 key，
        // 旧任务的 finally 不能把新任务从表里摘掉，否则并发会被重复触发
        if (inflight.get(key) === task) inflight.delete(key);
        o.signal?.removeEventListener('abort', onAbort);
      }
    })();

    inflight.set(key, task);
    return task;
  }

  return {
    get,
    /** 让某个 key 立即失效，用于「用户点了刷新」这类显式动作 */
    invalidate(key) { entries.delete(key); },
    stats() {
      return { keys: entries.size, inflight: inflight.size, hits, misses };
    },
  };
}

/**
 * 把网络错误拆成可读的一行。
 *
 * 必要性来自实测：undici 的所有网络失败外层都长成 `TypeError: fetch failed`，
 * 真因藏在 cause 链上，例如 `SocketError(UND_ERR_SOCKET): other side closed`。
 * 只看 message 会把「服务端主动关闭连接」误判成「网络抖了一下」，
 * 而这两者的处置完全相反：前者该退避，后者该重试。
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cur = err.cause;
  for (let i = 0; cur && i < 4; i++) {
    const code = cur.code ?? cur.errno;
    parts.push(`${code ? `${code}: ` : ''}${cur.message ?? cur}`);
    cur = cur.cause;
  }
  return parts.join(' ← ');
}

/**
 * 单个数据源的健康度。
 *
 * 连续失败到阈值后标记为不可用，避免每个请求都先等满超时才回落；一旦某次成功立即恢复。
 *
 * 冷却时间按失败次数翻倍（30s → 60s → 120s → …封顶 600s）。退避不是保守，是实测逼出来的：
 * 开发期连续探测东财约 60 次后，它所有子域开始「连接成功后在 70~90ms 内被服务端关闭」，
 * Python 与 Node 同时复现 —— 说明是 IP 级限流而不是客户端 bug。对限流若仍每 30 秒固定重试一次，
 * 只会把封禁不断刷新，所以必须退避，且退避到上限后也只是低频试探。
 */
export class SourceHealth {
  /**
   * @param {string} name 数据源名，用于向用户展示「哪一家挂了」
   * @param {{threshold?: number, cooldownMs?: number, maxCooldownMs?: number, now?: () => number}} [opts]
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 600000;
    this.now = opts.now ?? Date.now;
    this.failures = 0;
    this.lastError = null;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
  }

  /** 当前退避时长：每超过阈值一次翻一倍 */
  currentCooldownMs() {
    const over = Math.max(0, this.failures - this.threshold);
    return Math.min(this.cooldownMs * 2 ** over, this.maxCooldownMs);
  }

  /** 冷却期内不再尝试，直接判不可用 */
  available() {
    if (this.failures < this.threshold) return true;
    return this.now() - this.lastFailureAt > this.currentCooldownMs();
  }

  /** 还有多久才会再试；已可试或从未失败返回 0 */
  retryInMs() {
    if (this.available()) return 0;
    return Math.max(0, this.currentCooldownMs() - (this.now() - this.lastFailureAt));
  }

  ok() {
    this.failures = 0;
    this.lastError = null;
    this.lastSuccessAt = this.now();
  }

  fail(err) {
    this.failures++;
    this.lastError = describeError(err);
    this.lastFailureAt = this.now();
  }

  snapshot() {
    return {
      name: this.name,
      healthy: this.available() && this.failures < this.threshold,
      failures: this.failures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt || null,
      retryInMs: Math.round(this.retryInMs()),
    };
  }
}

/**
 * 带重试的取数。
 *
 * 免费接口会偶发 `RemoteDisconnected`（同一 URL 上一轮是 200，下一轮直接断连），
 * 一次性失败不代表接口坏了，所以做有限次重试 + 退避。
 *
 * @param {() => Promise<T>} fn
 * @param {{retries?: number, baseDelayMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 220;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('已取消');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(base * 2 ** attempt, opts.signal);
    }
  }
  throw lastErr;
}

/** 可被 AbortSignal 打断的等待 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('已取消'));
    }, { once: true });
  });
}
