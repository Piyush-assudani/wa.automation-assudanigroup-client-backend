# Technical Requirements Document (TRD) — Assudani WA Automations

## 1. Architecture & Tech Stack
- **Frontend:** Next.js (App Router), React, Tailwind CSS, `Plus_Jakarta_Sans` (self-hosted via `next/font/google`), Socket.IO Client.
- **Backend:** Node.js, Express 5, Socket.IO, PostgreSQL (`pg` connection pool), Axios, Multer, `bcryptjs`, `jsonwebtoken`, `express-rate-limit`.
- **External Integrations:** Meta WhatsApp Cloud API (`graph.facebook.com`).

## 2. Database Schema & Indexing
- **Core Tables:** `users`, `contacts`, `contact_lists`, `contact_list_members`, `campaigns`, `messages`, `media_assets`, `webhook_logs`, `billing_transactions`.
- **RBAC & Reliability Tables (`backend/db/migrate_rbac_and_indexes.js`):**
  - `roles`, `permissions`, `role_permissions`, `users.role_id`
  - `idempotency_keys` (prevents duplicate billing recharges or campaign launches on retries/double-clicks)
  - `system_error_logs` (captures 5xx errors and unhandled exceptions with route, method, user, and stack trace)
- **Composite Indexes:** 12 indexes across `messages`, `contacts`, `contact_lists`, `campaigns`, `billing_transactions`, `media_assets`, and `system_error_logs` to minimize DB read/write latency and cloud compute costs.

## 3. Concurrency, Transactions & Idempotency
- **Stateless API:** Authentication relies exclusively on signed JWTs; no server-memory sessions are required, enabling horizontal scaling behind a load balancer.
- **Row-Level Locks:** `checkAndDeductMessageFund`, `refundMessageFund`, and `POST /api/billing/recharge` execute inside `db.getClient()` transactions (`BEGIN ... SELECT ... FOR UPDATE ... COMMIT / ROLLBACK`) to eliminate race conditions under concurrent requests.
- **Idempotency Keys:** `backend/services/idempotency.js` stores and replays responses for `Idempotency-Key` headers on `POST /api/billing/recharge` and `POST /api/campaigns`.

## 4. Resilience & Outbound Traffic Control
- **Meta API Circuit Breaker & Exponential Backoff:** `backend/services/resilience.js` implements `withRetry` (exponential backoff + jitter for 429/5xx/network errors) and `CircuitBreaker` (`metaBreaker`) used by `sendTemplateMessage` and `sendTextMessage`.
- **Startup & Shutdown:** `server.js` runs RBAC/index migrations on boot, prunes the IP violation map every 15 minutes, and handles `SIGTERM`/`SIGINT` gracefully.
- **Backups:** `GET /api/backup/export` (Master Admin only) exports core tables as a structured JSON snapshot.
