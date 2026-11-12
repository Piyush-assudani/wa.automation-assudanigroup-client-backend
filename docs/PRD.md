# Product Requirements Document (PRD) — Assudani WA Automations

## 1. Product Overview
**Assudani WA Automations** is a multi-tenant SaaS platform for WhatsApp Cloud API marketing campaigns, template management, contact list segmentation, real-time two-way customer chat, and prepaid wallet billing.

## 2. Target Users & Roles (RBAC)
- **Master Admin (`master_admin` / Owner):** Full platform governance, client workspace provisioning, wallet recharges/deductions, global analytics, system error logs, and database JSON backup exports.
- **Client Manager (`client` / Manager):** Manages their own WhatsApp Business channel (Company Channel or Custom Meta Cloud API), uploads contacts/media, creates/syncs Meta templates, launches campaigns, and replies in live chat.
- **Staff / Clerk (`staff` / Clerk):** Operates day-to-day campaign launches, contact management, and live chat without destructive admin/billing privileges.
- **Read-Only / Teacher (`teacher`):** Views analytics, contacts, and chat transcripts without modifying billing or user accounts.

## 3. Core Functional Modules
1. **Authentication & Session Management:** Stateless JWT authentication (`Authorization: Bearer <token>`) with bcrypt password hashing and password visibility toggles across all auth forms.
2. **Multi-Tenant Channel Isolation:** Supports either shared Company Channel or per-client Custom Meta Cloud API (`whatsapp_mode`, `meta_phone_id`, `meta_waba_id`, `meta_token`) with strict `user_id` isolation across templates, contacts, campaigns, media, and inbound callbacks.
3. **Contact Lists & Auto-Detection:** CSV/XLSX upload with automatic header/column detection, real-time Socket.IO progress/list updates, and strict tenant scoping.
4. **Media Library & Templates:** Server-side storage + Meta Cloud API media upload supporting images, videos (`MP4`), and documents, with live WhatsApp preview.
5. **Campaign Engine:** Immediate or scheduled dispatch, pre-flight wallet balance verification, atomic per-message deduction/refund on Meta failure, and Excel delivery export.
6. **Prepaid Wallet & Billing Ledger:** Real-time balance tracking (`marketing`, `utility`, `authentication`, `service`), atomic row-level locked deductions/recharges, and itemized ledger history.
7. **Live Chat & Webhooks:** Real-time inbound/outbound WhatsApp messaging via Meta webhooks + Socket.IO, scoped strictly to contacts messaged by that tenant.
8. **Resilience & Offline Awareness:** Network status banner, `visibilitychange` socket auto-reconnection, and graceful error/success notifications.
