# Security & Compliance Architecture — Assudani WA Automations

## 1. Authentication & Authorization
- **JWT Verification:** All protected routes require `Authorization: Bearer <token>` verified against a single shared `JWT_SECRET` in `backend/middleware/authMiddleware.js`.
- **RBAC:** Role-based and permission-based middleware (`requireMasterAdmin`, `requireAdmin`, `requirePermission`) enforces least-privilege access.
- **Tenant Isolation:** Non-master users are strictly scoped by `req.effectiveUserId` across contacts, contact lists, media assets, campaigns, billing, and live chat callbacks. `x-client-id` impersonation headers are validated as UUIDs and honored only for `master_admin`.

## 2. Network, Rate Limiting & Abuse Protection
- **Proxy Trust:** `app.set("trust proxy", 1)` ensures accurate client IP resolution behind Vercel/Nginx/Cloudflare proxies.
- **Rate Limiting & IP Jail:** Global `/api` rate limiter, strict `/api/auth` limiter, and automatic IP violation tracking with periodic 15-minute memory pruning.
- **CORS:** Configured with `origin: true, credentials: true` for seamless frontend-backend communication without wildcard credential errors.

## 3. Input Validation & Injection Prevention
- **SQL Injection:** All database queries use parameterized `$1, $2, ...` bindings via `pg`.
- **UUID & Bounds Validation:** Route parameters (`:id`, `userId`, `x-client-id`) are validated with strict UUID regexes; financial recharge/deduct amounts are bounded positive numbers.
- **File Uploads:** Multer enforces file size limits (64MB) and cleans up temporary files after processing.

## 4. Data Privacy & Reliability
- **No Hardcoded Secrets:** Credentials live strictly in environment variables (`.env`, excluded via `.gitignore`).
- **Auditability & Backups:** `system_error_logs` records unhandled 5xx failures; `GET /api/backup/export` provides on-demand JSON backups for Master Admins.
