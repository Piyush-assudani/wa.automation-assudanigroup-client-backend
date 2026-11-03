# Assudani's WP Automation Backend

This is the high-performance backend service for Assudani's WP Automation. It provides RESTful APIs, real-time Socket.IO events, and webhook handling for managing WhatsApp campaigns, contacts, media, and real-time messaging using the official WhatsApp Cloud API.

## Features

- **WhatsApp Cloud API Integration:** Sends and receives messages, media, and template messages.
- **Webhook Handling:** Listens for inbound messages, delivery statuses, and read receipts with indexed lookup.
- **Campaign Management:** Built-in pacing logic to prevent spam blocks by Meta.
- **Database:** PostgreSQL with indexed lookups for contacts, messages, and campaigns.
- **Media Uploads:** Cloudinary integration for handling inbound and outbound media.
- **Security & Reliability:** IP abuse jail defense, rate limiting, universal permissive CORS, in-memory caching, and resilient edge-case handling.

## Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Environment Variables:** Create a `.env` file with the following variables:
   ```env
   PORT=5001
   NODE_ENV=production
   USE_REDIS=false # Set to true to enable BullMQ pacing
   DATABASE_URL=postgres://<user>:<password>@<host>:5432/postgres
   SUPABASE_URL=https://<your-supabase-url>
   SUPABASE_KEY=<your-supabase-key>
   
   # Meta WhatsApp API
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_BUSINESS_ACCOUNT_ID=...
   META_ACCESS_TOKEN=...
   META_API_VERSION=v17.0
   WEBHOOK_VERIFY_TOKEN=assudani_wp_verify_token_2026
   
   REDIS_URL=redis://localhost:6379
   FRONTEND_URL=http://localhost:3000
   CLOUDINARY_URL=cloudinary://...
   ```

3. **Start the server:**
   ```bash
   npm start
   # or for development with nodemon:
   npm run dev
   ```
