const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const db = require("./index");

/**
 * Runs idempotent RBAC tables, idempotency_keys, system_error_logs,
 * and high-concurrency database indexes migration.
 */
async function runRbacAndIndexMigration() {
  console.log("🔄 Running RBAC, Idempotency, Error Tracking & Indexing Migration...");

  const sql = `
    -- ============================================
    -- 1. RBAC System: Roles, Permissions, Role_Permissions
    -- ============================================
    CREATE TABLE IF NOT EXISTS public.roles (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.permissions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.role_permissions (
      role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
      permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL;

    -- Seed Core Roles (Owner/Master Admin, Manager/Client, Clerk/Staff, Teacher/Viewer)
    INSERT INTO public.roles (name, display_name, description) VALUES
      ('master_admin', 'Owner / Master Admin', 'Full platform ownership, global billing, user management, and backups'),
      ('owner', 'Owner', 'Workspace owner with full administrative permissions'),
      ('manager', 'Manager', 'Client manager with campaign, template, contact, and billing view permissions'),
      ('client', 'Client Workspace', 'Standard SaaS client account'),
      ('admin', 'Admin', 'Workspace administrator'),
      ('clerk', 'Clerk / Staff', 'Operational staff with chat, contacts, and campaign execution'),
      ('staff', 'Staff', 'Team member operating under parent client workspace'),
      ('teacher', 'Instructor / Viewer', 'Read-only analytics and messaging access')
    ON CONFLICT (name) DO NOTHING;

    -- Seed Core Permissions
    INSERT INTO public.permissions (name, description) VALUES
      ('view_dashboard', 'View analytics dashboard and delivery funnel'),
      ('manage_contacts', 'Create, upload, edit, and delete contacts and contact lists'),
      ('manage_campaigns', 'View and manage broadcast campaigns'),
      ('launch_campaign', 'Launch or schedule WhatsApp broadcast campaigns'),
      ('create_order', 'Create billing/campaign dispatch orders'),
      ('manage_templates', 'Create and sync Meta WhatsApp templates'),
      ('manage_media', 'Upload and delete media assets'),
      ('view_billing', 'View wallet balance and transaction ledger'),
      ('manage_billing', 'Add or deduct client wallet funds'),
      ('manage_users', 'Create and update user/team accounts'),
      ('delete_user', 'Delete user accounts'),
      ('manage_settings', 'Update Meta API credentials and profile settings'),
      ('manage_backups', 'Export and inspect database backups and error logs')
    ON CONFLICT (name) DO NOTHING;

    -- Map Role -> Permissions cleanly
    -- Master Admin & Owner get ALL permissions
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE r.name IN ('master_admin', 'owner')
    ON CONFLICT DO NOTHING;

    -- Manager / Client / Admin get workspace operational + view_billing permissions (no delete_user / manage_billing)
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE r.name IN ('manager', 'client', 'admin')
      AND p.name IN (
        'view_dashboard', 'manage_contacts', 'manage_campaigns', 'launch_campaign',
        'create_order', 'manage_templates', 'manage_media', 'view_billing', 'manage_settings'
      )
    ON CONFLICT DO NOTHING;

    -- Clerk / Staff get operational messaging & contacts permissions
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE r.name IN ('clerk', 'staff')
      AND p.name IN ('view_dashboard', 'manage_contacts', 'manage_campaigns', 'manage_media', 'create_order')
    ON CONFLICT DO NOTHING;

    -- Teacher gets read/messaging view permissions
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE r.name = 'teacher'
      AND p.name IN ('view_dashboard', 'manage_campaigns')
    ON CONFLICT DO NOTHING;

    -- Backfill users.role_id for existing users
    UPDATE public.users u
    SET role_id = r.id
    FROM public.roles r
    WHERE u.role_id IS NULL AND LOWER(u.role) = r.name;

    -- ============================================
    -- 2. Idempotency Keys & System Error Tracking
    -- ============================================
    CREATE TABLE IF NOT EXISTS public.idempotency_keys (
      key VARCHAR(255) PRIMARY KEY,
      user_id UUID,
      route VARCHAR(255) NOT NULL,
      response_status INTEGER NOT NULL,
      response_body JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON public.idempotency_keys(created_at);

    CREATE TABLE IF NOT EXISTS public.system_error_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      method VARCHAR(16),
      path TEXT,
      status_code INTEGER,
      error_message TEXT,
      user_id UUID,
      ip_address VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_system_error_logs_created ON public.system_error_logs(created_at DESC);

    -- ============================================
    -- 3. High-Concurrency Performance Indexes
    -- ============================================
    CREATE INDEX IF NOT EXISTS idx_users_role_id ON public.users(role_id);
    CREATE INDEX IF NOT EXISTS idx_users_parent_client ON public.users(parent_client_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON public.contacts(user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_user_created ON public.contacts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_lists_user_id ON public.contact_lists(user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_user_created ON public.campaigns(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status_sched ON public.campaigns(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_messages_contact_ts_desc ON public.messages(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_campaign_status ON public.messages(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created ON public.wallet_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_type_status ON public.wallet_transactions(user_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_client_templates_user_name ON public.client_templates(user_id, LOWER(template_name));
  `;

  await db.query(sql);
  console.log("✅ RBAC tables, Idempotency, Error Tracking & Performance Indexes applied!");
}

if (require.main === module) {
  runRbacAndIndexMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Migration failed:", err.message);
      process.exit(1);
    });
}

module.exports = { runRbacAndIndexMigration };
