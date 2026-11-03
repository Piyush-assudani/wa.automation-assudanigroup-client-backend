const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const db = require("./index");

async function runSaaSMigration() {
  console.log("🔄 Running SaaS & Dual Meta API Database Migration...");

  try {
    await db.query(`
      ALTER TABLE public.users 
        ADD COLUMN IF NOT EXISTS whatsapp_mode VARCHAR(50) DEFAULT 'company',
        ADD COLUMN IF NOT EXISTS meta_phone_number_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS meta_waba_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS meta_access_token TEXT,
        ADD COLUMN IF NOT EXISTS meta_verified_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS meta_display_phone_number VARCHAR(255),
        ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);

      -- Ensure Piyushassudani is Master Admin
      UPDATE public.users 
      SET role = 'master_admin', whatsapp_mode = 'company' 
      WHERE LOWER(TRIM(username)) = 'piyushassudani';

      -- Ensure Kapilchaudhary has admin role
      UPDATE public.users 
      SET role = 'admin', whatsapp_mode = 'company' 
      WHERE LOWER(TRIM(username)) = 'kapilchaudhary';
    `);

    console.log("✅ SaaS Migration successfully executed!");

    const users = await db.query("SELECT id, username, role, whatsapp_mode FROM public.users ORDER BY created_at ASC");
    console.log("Current Users in DB:");
    console.table(users.rows);

    process.exit(0);
  } catch (err) {
    console.error("❌ SaaS Migration failed:", err.message);
    process.exit(1);
  }
}

runSaaSMigration();
