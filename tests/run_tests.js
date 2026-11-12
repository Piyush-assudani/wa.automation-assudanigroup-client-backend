/**
 * Automated Security, RBAC, Billing-Concurrency & Input Validation Test Suite
 * Runs offline with zero external DB/Meta dependencies for fast, deterministic CI.
 */
const assert = require("assert");
const { PassThrough } = require("stream");
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");

// Ensure test JWT_SECRET is set before loading authMiddleware
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_ci_jwt_secret_2026";
process.env.NODE_ENV = "test";

const VALID_MASTER_ID = "11111111-1111-4111-8111-111111111111";
const VALID_CLIENT_ID = "22222222-2222-4222-8222-222222222222";

// --- In-Memory Mock DB with Row-Level Lock & Transaction Simulation ---
const state = {
  users: new Map([
    [
      VALID_MASTER_ID,
      { id: VALID_MASTER_ID, username: "master_owner", role: "master_admin", wallet_balance: "100.00", status: "active" },
    ],
    [
      VALID_CLIENT_ID,
      { id: VALID_CLIENT_ID, username: "client_one", role: "client", wallet_balance: "2.16", status: "active" },
    ],
  ]),
  idempotencyKeys: new Map(),
  billingTransactions: [],
  rowLocks: new Map(),
};

async function acquireLock(key) {
  while (state.rowLocks.get(key)) {
    await new Promise((r) => setTimeout(r, 2));
  }
  state.rowLocks.set(key, true);
}

function releaseLock(key) {
  state.rowLocks.delete(key);
}

function makeMockQuery(lockedKeys = null) {
  return async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") {
      if ((q === "COMMIT" || q === "ROLLBACK") && lockedKeys) {
        for (const k of lockedKeys) releaseLock(k);
        lockedKeys.clear();
      }
      return { rows: [], rowCount: 0 };
    }

    if (q.includes("FROM public.idempotency_keys") || q.includes("FROM idempotency_keys")) {
      const rec = state.idempotencyKeys.get(params[0]);
      return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0 };
    }

    if (q.startsWith("INSERT INTO public.idempotency_keys") || q.startsWith("INSERT INTO idempotency_keys")) {
      state.idempotencyKeys.set(params[0], {
        key: params[0],
        user_id: params[1],
        route: params[2],
        response_status: params[3],
        response_body: typeof params[4] === "string" ? JSON.parse(params[4]) : params[4],
      });
      return { rows: [], rowCount: 1 };
    }

    if (q.includes("FROM public.users WHERE id = $1") || (q.includes("FROM users WHERE id = $1") && q.includes("FOR UPDATE"))) {
      const userId = params[0];
      if (lockedKeys && q.includes("FOR UPDATE")) {
        await acquireLock(userId);
        lockedKeys.add(userId);
      }
      const user = state.users.get(userId);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }

    if (q.includes("wallet_balance FROM") && q.includes("users WHERE id = $1")) {
      const user = state.users.get(params[0]);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }

    if (q.startsWith("UPDATE public.users SET wallet_balance = wallet_balance - $1") || q.startsWith("UPDATE users SET wallet_balance = wallet_balance - $1")) {
      const [amount, userId] = params;
      const user = state.users.get(userId);
      if (user) user.wallet_balance = (Number(user.wallet_balance) - Number(amount)).toFixed(4);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }

    if (q.startsWith("UPDATE public.users SET wallet_balance = $1") || q.startsWith("UPDATE users SET wallet_balance = $1")) {
      const [newBal, userId] = params;
      const user = state.users.get(userId);
      if (user) user.wallet_balance = Number(newBal).toFixed(4);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }

    if (q.startsWith("UPDATE public.users SET wallet_balance = wallet_balance + $1") || q.startsWith("UPDATE users SET wallet_balance = wallet_balance + $1")) {
      const [amount, userId] = params;
      const user = state.users.get(userId);
      if (user) user.wallet_balance = (Number(user.wallet_balance) + Number(amount)).toFixed(4);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }

    if (q.startsWith("INSERT INTO public.wallet_transactions") || q.startsWith("INSERT INTO billing_transactions")) {
      const tx = { id: `tx-${state.billingTransactions.length + 1}`, params };
      state.billingTransactions.push(tx);
      return { rows: [tx], rowCount: 1 };
    }

    if (q.includes("FROM role_permissions")) {
      return { rows: [], rowCount: 0 };
    }

    if (q.includes("FROM media_assets") || q.includes("FROM contacts") || q.includes("FROM campaigns")) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  };
}

const dbPath = require.resolve("../db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: makeMockQuery(null),
    getClient: async () => {
      const lockedKeys = new Set();
      return {
        query: makeMockQuery(lockedKeys),
        release: () => {
          for (const k of lockedKeys) releaseLock(k);
          lockedKeys.clear();
        },
      };
    },
    pool: { end: async () => {} },
  },
};

// Load modules after DB mock is installed
const { JWT_SECRET } = require("../middleware/authMiddleware");
const billingRouter = require("../routes/billing");
const { RATES, checkAndDeductMessageFund } = billingRouter;
const contactsRouter = require("../routes/contacts");
const mediaRouter = require("../routes/media");
const campaignsRouter = require("../routes/campaigns");
const usersRouter = require("../routes/users");
const backupRouter = require("../routes/backup");
const { withRetry, CircuitBreaker } = require("../services/resilience");

function buildTestApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/contacts", contactsRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/billing", billingRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/backup", backupRouter);

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      return res.status(400).json({ error: "Invalid JSON payload." });
    }
    return res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

function request(app, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new PassThrough();
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = urlPath;
    req.headers = {
      host: "127.0.0.1",
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };

    let rawBody = null;
    if (body !== null) {
      rawBody = typeof body === "string" ? body : JSON.stringify(body);
      req.headers["content-type"] = req.headers["content-type"] || "application/json";
      req.headers["content-length"] = String(Buffer.byteLength(rawBody));
    }

    const res = new http.ServerResponse(req);
    const chunks = [];
    res.assignSocket(socket);
    res.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch (_) {}
      resolve({ status: res.statusCode, body: parsed });
    };
    res.on("error", reject);

    app(req, res);

    if (rawBody !== null) {
      req.push(rawBody);
    }
    req.push(null);
  });
}

function scanForLeakedSecrets(dir, findings = []) {
  const skip = new Set(["node_modules", ".git", "uploads", ".next", "tests", "backups"]);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith(".env")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForLeakedSecrets(fullPath, findings);
    } else if (/\.(js|jsx|ts|tsx|json|md)$/i.test(entry.name)) {
      const content = fs.readFileSync(fullPath, "utf8");
      // Match real Meta Graph API tokens (word-bounded, not inside base64 media blobs)
      if (/(?:^|["'\s=])EAA[A-Za-z0-9]{50,}(?:["'\s]|$)/.test(content)) {
        findings.push(`Potential Meta token in ${fullPath}`);
      }
      // Match real PostgreSQL URIs (excluding <user>:<password> doc placeholders)
      if (/postgres(?:ql)?:\/\/(?!<user>)[^:\s<]+:(?!<password>)[^@\s<]+@/.test(content)) {
        findings.push(`Potential DB credential URI in ${fullPath}`);
      }
    }
  }
  return findings;
}

async function run() {
  const app = buildTestApp();

  const masterToken = jwt.sign({ id: VALID_MASTER_ID, username: "master_owner", role: "master_admin" }, JWT_SECRET);
  const clientToken = jwt.sign({ id: VALID_CLIENT_ID, username: "client_one", role: "client" }, JWT_SECRET);

  try {
    console.log("1. Testing Zero-Trust Authentication (401 on unauthenticated requests)...");
    for (const [method, p] of [
      ["GET", "/api/contacts"],
      ["GET", "/api/media"],
      ["GET", "/api/billing/summary"],
      ["GET", "/api/backup/export"],
      ["GET", "/api/campaigns"],
      ["GET", "/api/users/clients-dropdown"],
    ]) {
      const res = await request(app, method, p);
      assert.strictEqual(res.status, 401, `${method} ${p} should return 401, got ${res.status}`);
    }

    console.log("2. Testing RBAC Enforcement (403 for non-master client)...");
    const r1 = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { userId: VALID_CLIENT_ID, amount: 50 },
    });
    assert.strictEqual(r1.status, 403, `Client recharge should return 403, got ${r1.status}`);

    const r2 = await request(app, "GET", "/api/backup/export", {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(r2.status, 403, `Client backup export should return 403, got ${r2.status}`);

    const r3 = await request(app, "GET", "/api/users/clients-dropdown", {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(r3.status, 403, `Client users dropdown should return 403, got ${r3.status}`);

    console.log("3. Testing Input Validation & SQLi/Malformed JSON Protection (400, never 500)...");
    const badContact = await request(app, "GET", "/api/contacts/not-a-uuid", {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(badContact.status, 400, `Expected 400 for badContact, got ${badContact.status}: ${JSON.stringify(badContact.body)}`);

    const sqliMedia = await request(app, "DELETE", "/api/media/';%20DROP%20TABLE%20users;--", {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(sqliMedia.status, 400);

    const badClientHeader = await request(app, "GET", "/api/contacts", {
      headers: { Authorization: `Bearer ${masterToken}`, "x-client-id": "invalid-uuid" },
    });
    // Invalid x-client-id is safely ignored and falls back to master's own ID (never 500)
    assert.strictEqual(badClientHeader.status, 200);

    const badJson = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${masterToken}` },
      body: "{bad-json",
    });
    assert.strictEqual(badJson.status, 400);

    const negRecharge = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${masterToken}` },
      body: { user_id: VALID_CLIENT_ID, amount: -50 },
    });
    assert.strictEqual(negRecharge.status, 400);

    const hugeRecharge = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${masterToken}` },
      body: { user_id: VALID_CLIENT_ID, amount: 99999999 },
    });
    assert.strictEqual(hugeRecharge.status, 400);

    console.log("4. Testing Billing Rates, Concurrent Race-Condition Locks & Idempotency...");
    assert.strictEqual(RATES.marketing, 1.08);
    assert.strictEqual(RATES.utility, 0.45);
    assert.strictEqual(RATES.authentication, 0.40);
    assert.strictEqual(RATES.service, 0.40);

    // Client starts with 2.16 -> 5 parallel deductions of 1.08 must allow exactly 2 and reject 3
    const deductions = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        checkAndDeductMessageFund(VALID_CLIENT_ID, {
          category: "marketing",
          recipientPhone: "919999999999",
          customDescription: `Parallel #${idx}`,
        })
      )
    );
    const successes = deductions.filter((d) => d.allowed);
    const failures = deductions.filter((d) => !d.allowed);
    assert.strictEqual(successes.length, 2, `Expected 2 successes, got ${successes.length}`);
    assert.strictEqual(failures.length, 3, `Expected 3 failures, got ${failures.length}`);
    assert.strictEqual(Number(state.users.get(VALID_CLIENT_ID).wallet_balance), 0);

    // Idempotent recharge: calling twice with the same Idempotency-Key must credit only once
    const idemKey = "idem-recharge-test-001";
    const rec1 = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${masterToken}`, "Idempotency-Key": idemKey },
      body: { user_id: VALID_CLIENT_ID, amount: 25 },
    });
    const rec2 = await request(app, "POST", "/api/billing/recharge", {
      headers: { Authorization: `Bearer ${masterToken}`, "Idempotency-Key": idemKey },
      body: { user_id: VALID_CLIENT_ID, amount: 25 },
    });
    assert.strictEqual(rec1.status, 200);
    assert.strictEqual(rec2.status, 200);
    assert.strictEqual(Number(state.users.get(VALID_CLIENT_ID).wallet_balance), 25);

    console.log("5. Testing Concurrency Load Burst (200 parallel requests)...");
    const burst = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0
          ? request(app, "GET", "/api/contacts")
          : request(app, "GET", "/api/contacts/invalid-uuid", {
              headers: { Authorization: `Bearer ${clientToken}` },
            })
      )
    );
    const burst401 = burst.filter((r) => r.status === 401).length;
    const burst400 = burst.filter((r) => r.status === 400).length;
    assert.strictEqual(burst401, 100, `Expected 100 401s, got ${burst401}`);
    assert.strictEqual(burst400, 100, `Expected 100 400s, got ${burst400}`);

    console.log("6. Testing Exponential Backoff & Circuit Breaker...");
    let attempts = 0;
    const retryResult = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("Upstream 503");
          err.response = { status: 503 };
          throw err;
        }
        return "ok";
      },
      { retries: 3, baseDelayMs: 5 }
    );
    assert.strictEqual(retryResult, "ok");
    assert.strictEqual(attempts, 3);

    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });
    assert.strictEqual(breaker.canExecute(), true);
    breaker.recordFailure({ response: { status: 500 } });
    breaker.recordFailure({ response: { status: 500 } });
    assert.strictEqual(breaker.canExecute(), false, "Circuit breaker should open after 2 upstream 500s");

    console.log("7. Scanning repository for hardcoded secrets or DB credentials...");
    const backendRoot = path.resolve(__dirname, "..");
    const frontendAppRoot = path.resolve(__dirname, "../../frontend/app");
    const leaks = [
      ...scanForLeakedSecrets(backendRoot),
      ...(fs.existsSync(frontendAppRoot) ? scanForLeakedSecrets(frontendAppRoot) : []),
    ];
    assert.deepStrictEqual(leaks, [], `Found potential secret leaks: ${leaks.join(", ")}`);

    console.log("✅ ALL SECURITY, RBAC, CONCURRENCY & RESILIENCE TESTS PASSED!");
  } finally {
    // No external server to close
  }
}

run().catch((err) => {
  console.error("❌ TEST FAILURE:", err);
  process.exit(1);
});
