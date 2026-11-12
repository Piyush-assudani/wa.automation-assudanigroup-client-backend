/**
 * Resilience Utilities: Exponential Backoff with Jitter & Circuit Breaker
 * Protects outbound Meta Cloud API traffic and prevents cascading failures.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientError = (err) => {
  if (!err) return false;
  const status = err.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = err.code;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN"].includes(code);
};

/**
 * Executes an async function with exponential backoff + jitter on transient failures.
 */
async function withRetry(fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientError(err)) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 150);
      const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Lightweight Circuit Breaker for third-party APIs (e.g. Meta Graph API).
 */
class CircuitBreaker {
  constructor({ failureThreshold = 8, cooldownMs = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.openedAt = 0;
  }

  canExecute() {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
  }

  recordFailure(err) {
    if (!isTransientError(err)) return; // Business/4xx errors don't trip circuit
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.warn(`⚡ CircuitBreaker OPENED after ${this.failures} transient failures.`);
    }
  }

  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      cooldownRemainingMs:
        this.state === "OPEN" ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0,
    };
  }
}

module.exports = {
  withRetry,
  CircuitBreaker,
  isTransientError,
};
