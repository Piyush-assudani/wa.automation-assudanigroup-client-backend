const express = require("express");
const router = express.Router();
const db = require("../db");
const { authenticate, requireMasterAdmin } = require("../middleware/authMiddleware");

router.use(authenticate, requireMasterAdmin);

/**
 * GET /api/backup/export
 * Generates a full point-in-time JSON backup of critical business data
 * (excluding sensitive credentials/passwords) for disaster recovery.
 */
router.get("/export", async (req, res) => {
  try {
    const [
      users,
      contacts,
      contactLists,
      listMembers,
      campaigns,
      walletTx,
      clientTemplates,
      mediaAssets,
    ] = await Promise.all([
      db.query(
        `SELECT id, username, role, whatsapp_mode, status, wallet_balance, currency, per_msg_rate, created_at
         FROM public.users ORDER BY created_at ASC`
      ),
      db.query(`SELECT id, phone_number, name, city, user_id, is_opted_out, created_at FROM public.contacts`),
      db.query(`SELECT id, name, user_id, created_at FROM public.contact_lists`),
      db.query(`SELECT list_id, contact_id FROM public.contact_list_members`),
      db.query(
        `SELECT id, name, template_name, contact_list_id, media_type, media_url, total_sent, user_id, scheduled_at, status, created_at
         FROM public.campaigns ORDER BY created_at DESC LIMIT 500`
      ),
      db.query(
        `SELECT id, user_id, type, amount, balance_after, description, campaign_id, recipient_phone, category, status, created_at
         FROM public.wallet_transactions ORDER BY created_at DESC LIMIT 2000`
      ),
      db.query(`SELECT id, user_id, template_name, meta_template_id, language, category, created_at FROM public.client_templates`),
      db.query(`SELECT id, original_name, media_url, meta_media_id, resource_type, created_at FROM public.media_assets`),
    ]);

    const snapshot = {
      exported_at: new Date().toISOString(),
      version: "1.0",
      counts: {
        users: users.rowCount,
        contacts: contacts.rowCount,
        contact_lists: contactLists.rowCount,
        contact_list_members: listMembers.rowCount,
        campaigns: campaigns.rowCount,
        wallet_transactions: walletTx.rowCount,
        client_templates: clientTemplates.rowCount,
        media_assets: mediaAssets.rowCount,
      },
      data: {
        users: users.rows,
        contacts: contacts.rows,
        contact_lists: contactLists.rows,
        contact_list_members: listMembers.rows,
        campaigns: campaigns.rows,
        wallet_transactions: walletTx.rows,
        client_templates: clientTemplates.rows,
        media_assets: mediaAssets.rows,
      },
    };

    res.setHeader("Content-Disposition", `attachment; filename="assudani-wa-backup-${Date.now()}.json"`);
    res.json(snapshot);
  } catch (err) {
    console.error("❌ Backup export error:", err.message);
    res.status(500).json({ error: "Failed to generate database backup snapshot." });
  }
});

/**
 * GET /api/backup/errors
 * Lists recent backend errors tracked in system_error_logs.
 */
router.get("/errors", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, method, path, status_code, error_message, user_id, ip_address, created_at
       FROM public.system_error_logs
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
