const db = require("./index");

async function migrate() {
  console.log("🚀 Starting Scheduling & Multi-Tenant Database Migration on Supabase...");

  try {
    // 1. Add user_id, scheduled_at, status to campaigns
    await db.query(`
      ALTER TABLE public.campaigns 
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS scheduled_at timestamp with time zone DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS status character varying DEFAULT 'completed';
    `);
    console.log("✅ campaigns columns added: user_id, scheduled_at, status");

    // 2. Add user_id to contacts
    await db.query(`
      ALTER TABLE public.contacts 
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
    `);
    console.log("✅ contacts column added: user_id");

    // 3. Add user_id to contact_lists
    await db.query(`
      ALTER TABLE public.contact_lists 
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
    `);
    console.log("✅ contact_lists column added: user_id");

    // 4. Add user_id to media_assets if table exists
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'media_assets') THEN
          ALTER TABLE public.media_assets ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("✅ media_assets column added: user_id");

    // 5. Assign existing records to Master Admin user so nothing gets lost or orphaned
    const masterAdmin = await db.query("SELECT id FROM public.users WHERE role = 'master_admin' LIMIT 1");
    if (masterAdmin.rows.length > 0) {
      const masterId = masterAdmin.rows[0].id;
      await db.query("UPDATE public.campaigns SET user_id = $1 WHERE user_id IS NULL", [masterId]);
      await db.query("UPDATE public.contacts SET user_id = $1 WHERE user_id IS NULL", [masterId]);
      await db.query("UPDATE public.contact_lists SET user_id = $1 WHERE user_id IS NULL", [masterId]);
      console.log(`✅ Existing records associated with Master Admin ID: ${masterId}`);
    }

    console.log("🎉 Migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  }
}

migrate();

