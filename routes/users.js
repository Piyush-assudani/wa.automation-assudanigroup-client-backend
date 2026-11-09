const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const axios = require("axios");
const db = require("../db");
const { authenticate, requireMasterAdmin, requireAdmin } = require("../middleware/authMiddleware");
const { getAccountHealth } = require("../services/metaApi");

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/users/clients-dropdown
 * Returns active clients & users for Admin switcher dropdown
 */
router.get("/clients-dropdown", requireAdmin, async (req, res) => {
  try {
    // Only return actual client accounts. Master Admin (Piyush Assudani) is the platform admin, not a client.
    const result = await db.query(`
      SELECT id, username, role, whatsapp_mode, meta_display_phone_number, meta_verified_name
      FROM public.users
      WHERE role NOT IN ('master_admin') AND LOWER(username) != 'piyushassudani'
      ORDER BY username ASC
    `);
    return res.json({ clients: result.rows });
  } catch (err) {
    console.error("Clients dropdown error:", err);
    return res.status(500).json({ error: "Failed to load clients list." });
  }
});

/**
 * GET /api/users/channel-config
 * Returns active sender channel configuration for the logged-in user
 */
router.get("/channel-config", async (req, res) => {
  try {
    const effectiveUserId = req.targetUserId || req.user.id;
    const result = await db.query(
      "SELECT id, username, role, whatsapp_mode, meta_phone_number_id, meta_waba_id, meta_display_phone_number, meta_verified_name FROM public.users WHERE id = $1",
      [effectiveUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // Company default configuration (from environment)
    const companyConfig = {
      phone_number: process.env.COMPANY_WHATSAPP_NUMBER || process.env.META_DISPLAY_PHONE_NUMBER || "",
      phone_id: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      waba_id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      verified_name: "Assudani WA Automations (Company Default)",
    };

    return res.json({
      user_id: user.id,
      username: user.username,
      active_mode: user.whatsapp_mode || "company",
      company: companyConfig,
      personal: {
        is_configured: !!(user.meta_phone_number_id),
        phone_id: user.meta_phone_number_id || "",
        waba_id: user.meta_waba_id || "",
        display_phone_number: user.meta_display_phone_number || "",
        verified_name: user.meta_verified_name || "",
      },
    });
  } catch (err) {
    console.error("Get channel config error:", err);
    return res.status(500).json({ error: "Failed to retrieve channel settings." });
  }
});

/**
 * POST /api/users/channel-config
 * Updates the user's active sending channel ('company' or 'personal') and optional credentials
 */
router.post("/channel-config", async (req, res) => {
  const { mode, meta_phone_number_id, meta_waba_id, meta_access_token } = req.body || {};

  if (mode !== "company" && mode !== "personal") {
    return res.status(400).json({ error: "Mode must be 'company' or 'personal'." });
  }

  try {
    const effectiveUserId = req.targetUserId || req.user.id;
    let verifiedName = null;
    let displayPhone = null;

    const cleanPhoneId = meta_phone_number_id && String(meta_phone_number_id).trim() !== "" ? String(meta_phone_number_id).trim() : null;
    const cleanWabaId = meta_waba_id && String(meta_waba_id).trim() !== "" ? String(meta_waba_id).trim() : null;
    const cleanToken = meta_access_token && String(meta_access_token).trim() !== "" ? String(meta_access_token).trim() : null;

    // If personal mode with new credentials, test against Meta Graph API gracefully
    if (mode === "personal" && cleanPhoneId && cleanToken) {
      try {
        const metaRes = await getAccountHealth(cleanPhoneId, cleanToken);
        if (metaRes.success && metaRes.data) {
          verifiedName = metaRes.data.verified_name || null;
          displayPhone = metaRes.data.display_phone_number || null;
        }
      } catch (metaErr) {
        console.warn("Soft check on Meta health failed:", metaErr.message);
      }
    }

    let updateQuery;
    let params;

    if (cleanToken) {
      updateQuery = `
        UPDATE public.users 
        SET whatsapp_mode = $1, 
            meta_phone_number_id = COALESCE($2, meta_phone_number_id),
            meta_waba_id = COALESCE($3, meta_waba_id),
            meta_access_token = $4,
            meta_verified_name = COALESCE($5, meta_verified_name),
            meta_display_phone_number = COALESCE($6, meta_display_phone_number)
        WHERE id = $7
        RETURNING id, username, role, whatsapp_mode, meta_display_phone_number, meta_verified_name;
      `;
      params = [
        mode,
        cleanPhoneId,
        cleanWabaId,
        cleanToken,
        verifiedName,
        displayPhone,
        effectiveUserId,
      ];
    } else {
      updateQuery = `
        UPDATE public.users 
        SET whatsapp_mode = $1, 
            meta_phone_number_id = COALESCE($2, meta_phone_number_id),
            meta_waba_id = COALESCE($3, meta_waba_id)
        WHERE id = $4
        RETURNING id, username, role, whatsapp_mode, meta_display_phone_number, meta_verified_name;
      `;
      params = [
        mode,
        cleanPhoneId,
        cleanWabaId,
        effectiveUserId,
      ];
    }

    const updated = await db.query(updateQuery, params);

    return res.json({
      message: `WhatsApp channel successfully saved and set to ${mode === 'company' ? 'Company Central Number' : 'Personal Meta Cloud API'}!`,
      user: updated.rows[0],
    });
  } catch (err) {
    console.error("Save channel config error:", err);
    return res.status(500).json({ error: "Failed to update channel settings: " + err.message });
  }
});

/**
 * POST /api/users/test-meta
 * Tests custom Meta credentials directly before saving
 */
router.post("/test-meta", async (req, res) => {
  const { phone_number_id, access_token } = req.body || {};

  if (!phone_number_id || !access_token) {
    return res.status(400).json({ error: "Phone Number ID and Access Token are required." });
  }

  try {
    const metaRes = await getAccountHealth(phone_number_id.trim(), access_token.trim());
    if (metaRes.success && metaRes.data) {
      return res.json({
        success: true,
        message: "Meta credentials verified successfully!",
        data: metaRes.data,
      });
    } else {
      return res.status(400).json({
        success: false,
        error: metaRes.error || "Meta verification returned an error.",
      });
    }
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.response?.data?.error?.message || err.message,
    });
  }
});

// ============================================
// MASTER ADMIN ONLY USER MANAGEMENT (SaaS)
// ============================================

/**
 * GET /api/users
 * Lists all SaaS users & clients (Master Admin only)
 */
router.get("/", requireMasterAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id, 
        username, 
        role, 
        parent_client_id,
        whatsapp_mode, 
        meta_phone_number_id, 
        meta_waba_id,
        meta_access_token,
        meta_display_phone_number,
        meta_verified_name,
        status, 
        raw_password,
        wallet_balance,
        currency,
        created_at 
      FROM public.users 
      ORDER BY 
        CASE WHEN role = 'master_admin' THEN 1 WHEN role = 'admin' THEN 2 ELSE 3 END,
        created_at ASC
    `);

    return res.json({
      total: result.rows.length,
      users: result.rows,
    });
  } catch (err) {
    console.error("List users error:", err);
    return res.status(500).json({ error: "Failed to fetch users." });
  }
});

/**
 * POST /api/users
 * Creates a new user or client (Master Admin only)
 */
router.post("/", requireMasterAdmin, async (req, res) => {
  const {
    username,
    password,
    role = "client",
    parent_client_id = null,
    whatsapp_mode = "company",
    meta_phone_number_id,
    meta_waba_id,
    meta_access_token,
  } = req.body || {};

  const cleanUser = username?.trim();
  const cleanPass = password?.trim();

  if (!cleanUser || !cleanPass) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  if (cleanPass.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }

  try {
    // Check if username already exists
    const check = await db.query(
      "SELECT id FROM public.users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))",
      [cleanUser]
    );

    if (check.rows.length > 0) {
      return res.status(409).json({ error: `Username "${cleanUser}" already exists.` });
    }

    const hashedPassword = await bcrypt.hash(cleanPass, 10);

    let verifiedName = null;
    let displayPhone = null;

    if (whatsapp_mode === "personal" && meta_phone_number_id && meta_access_token) {
      try {
        const metaRes = await getAccountHealth(meta_phone_number_id.trim(), meta_access_token.trim());
        if (metaRes.success && metaRes.data) {
          verifiedName = metaRes.data.verified_name || null;
          displayPhone = metaRes.data.display_phone_number || null;
        }
      } catch (mErr) {
        console.warn("Optional Meta verification notice:", mErr.message);
      }
    }

    const insertResult = await db.query(`
      INSERT INTO public.users (
        username,
        password,
        raw_password,
        role,
        parent_client_id,
        whatsapp_mode,
        meta_phone_number_id,
        meta_waba_id,
        meta_access_token,
        meta_verified_name,
        meta_display_phone_number,
        status,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)
      RETURNING id, username, role, parent_client_id, whatsapp_mode, meta_display_phone_number, raw_password, created_at;
    `, [
      cleanUser,
      hashedPassword,
      cleanPass,
      role === "master_admin" ? "admin" : role, // Prevent creating another master_admin
      parent_client_id || null,
      whatsapp_mode,
      meta_phone_number_id ? meta_phone_number_id.trim() : null,
      meta_waba_id ? meta_waba_id.trim() : null,
      meta_access_token ? meta_access_token.trim() : null,
      verifiedName,
      displayPhone,
      req.user.username,
    ]);

    return res.status(201).json({
      message: `User "${cleanUser}" successfully created!`,
      user: insertResult.rows[0],
    });
  } catch (err) {
    console.error("Create user error:", err);
    return res.status(500).json({ error: "Failed to create user." });
  }
});

/**
 * PUT /api/users/:id
 * Updates an existing user with full editability across all fields (Master Admin only)
 */
router.put("/:id", requireMasterAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    username,
    password,
    role,
    parent_client_id,
    whatsapp_mode,
    meta_phone_number_id,
    meta_waba_id,
    meta_access_token,
    wallet_balance,
    status = "active",
  } = req.body || {};

  try {
    const existing = await db.query("SELECT * FROM public.users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const current = existing.rows[0];

    // If username is changing, ensure uniqueness
    let finalUsername = current.username;
    if (username && username.trim() !== "" && username.trim().toLowerCase() !== current.username.toLowerCase()) {
      const dupCheck = await db.query(
        "SELECT id FROM public.users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) AND id <> $2",
        [username.trim(), id]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ error: `Username "${username.trim()}" is already taken by another account.` });
      }
      finalUsername = username.trim();
    }

    // Disallow demoting master admin
    let finalRole = role || current.role;
    if (current.role === "master_admin") {
      finalRole = "master_admin";
    }

    let finalPassword = current.password;
    let finalRawPassword = current.raw_password;
    if (password && password.trim().length >= 4) {
      finalPassword = await bcrypt.hash(password.trim(), 10);
      finalRawPassword = password.trim();
    }

    let verifiedName = current.meta_verified_name;
    let displayPhone = current.meta_display_phone_number;

    if (meta_phone_number_id && meta_access_token && meta_access_token.trim() !== "") {
      try {
        const metaRes = await getAccountHealth(meta_phone_number_id.trim(), meta_access_token.trim());
        if (metaRes.success && metaRes.data) {
          verifiedName = metaRes.data.verified_name || null;
          displayPhone = metaRes.data.display_phone_number || null;
        }
      } catch (mErr) {
        console.warn("Optional Meta verification notice:", mErr.message);
      }
    }

    const finalParentClientId = parent_client_id !== undefined ? (parent_client_id || null) : current.parent_client_id;
    const finalWhatsappMode = whatsapp_mode !== undefined && whatsapp_mode !== null ? whatsapp_mode : current.whatsapp_mode;
    const finalPhoneId = meta_phone_number_id !== undefined ? (meta_phone_number_id ? meta_phone_number_id.trim() : null) : current.meta_phone_number_id;
    const finalWabaId = meta_waba_id !== undefined ? (meta_waba_id ? meta_waba_id.trim() : null) : current.meta_waba_id;
    const finalAccessToken = meta_access_token && meta_access_token.trim() !== "" ? meta_access_token.trim() : current.meta_access_token;
    const finalStatus = status !== undefined && status !== null ? status : (current.status || "active");
    const finalBalance = wallet_balance !== undefined && !isNaN(parseFloat(wallet_balance)) ? parseFloat(wallet_balance) : (parseFloat(current.wallet_balance) || 0);

    const updateResult = await db.query(`
      UPDATE public.users SET
        username = $1,
        password = $2,
        raw_password = $3,
        role = $4,
        parent_client_id = $5,
        whatsapp_mode = $6,
        meta_phone_number_id = $7,
        meta_waba_id = $8,
        meta_access_token = $9,
        meta_verified_name = $10,
        meta_display_phone_number = $11,
        status = $12,
        wallet_balance = $13
      WHERE id = $14
      RETURNING id, username, role, parent_client_id, whatsapp_mode, meta_phone_number_id, meta_waba_id, meta_access_token, meta_display_phone_number, meta_verified_name, status, raw_password, wallet_balance, currency;
    `, [
      finalUsername,
      finalPassword,
      finalRawPassword,
      finalRole,
      finalParentClientId,
      finalWhatsappMode,
      finalPhoneId,
      finalWabaId,
      finalAccessToken,
      verifiedName,
      displayPhone,
      finalStatus,
      finalBalance,
      id,
    ]);

    // If balance was modified directly, log an admin adjustment transaction
    if (wallet_balance !== undefined && !isNaN(parseFloat(wallet_balance)) && parseFloat(wallet_balance) !== parseFloat(current.wallet_balance || 0)) {
      const diff = finalBalance - parseFloat(current.wallet_balance || 0);
      await db.query(
        `INSERT INTO public.wallet_transactions 
          (user_id, type, amount, balance_after, description, category, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'service', 'completed', NOW())`,
        [
          id,
          diff >= 0 ? "credit" : "debit",
          Math.abs(diff),
          finalBalance,
          diff >= 0 ? `Admin balance recharge (+₹${diff.toFixed(2)})` : `Admin balance adjustment (-₹${Math.abs(diff).toFixed(2)})`
        ]
      ).catch(() => {});
    }

    return res.json({
      message: "User successfully updated!",
      user: updateResult.rows[0],
    });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({ error: "Failed to update user: " + err.message });
  }
});

/**
 * DELETE /api/users/:id
 * Deletes a user (Master Admin only; cannot delete master admin)
 */
router.delete("/:id", requireMasterAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await db.query("SELECT * FROM public.users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    if (existing.rows[0].role === "master_admin") {
      return res.status(400).json({ error: "Master Admin account cannot be deleted." });
    }

    if (existing.rows[0].id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    await db.query("DELETE FROM public.users WHERE id = $1", [id]);

    return res.json({ message: `User "${existing.rows[0].username}" successfully deleted.` });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "Failed to delete user." });
  }
});

// ============================================
// TEAM MEMBERS / SUB-LOGINS UNDER A CLIENT
// ============================================

/**
 * GET /api/users/team
 * Returns sub-user team logins under the active client organization
 */
router.get("/team", async (req, res) => {
  try {
    const isMaster = req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani");
    const parentId = isMaster
      ? (req.targetUserId || req.user.id)
      : (req.user.parent_client_id || req.user.id);

    const result = await db.query(
      `SELECT id, username, role, status, raw_password, created_at, parent_client_id 
       FROM public.users 
       WHERE parent_client_id = $1 
       ORDER BY created_at ASC`,
      [parentId]
    );

    return res.json({ team: result.rows });
  } catch (err) {
    console.error("Fetch team error:", err);
    return res.status(500).json({ error: "Failed to load team members." });
  }
});

/**
 * POST /api/users/team
 * Creates a sub-user login under the client organization
 */
router.post("/team", async (req, res) => {
  const { username, password } = req.body || {};
  const cleanUser = username?.trim();
  const cleanPass = password?.trim();

  if (!cleanUser || !cleanPass) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  if (cleanPass.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }

  try {
    const isMaster = req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani");
    const parentId = isMaster
      ? (req.body.parent_client_id || req.targetUserId || req.user.id)
      : (req.user.parent_client_id || req.user.id);

    // Verify username uniqueness
    const check = await db.query(
      "SELECT id FROM public.users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))",
      [cleanUser]
    );
    if (check.rows.length > 0) {
      return res.status(409).json({ error: `Username "${cleanUser}" already exists.` });
    }

    const hashedPassword = await bcrypt.hash(cleanPass, 10);
    const result = await db.query(
      `INSERT INTO public.users (username, password, raw_password, role, parent_client_id, status, created_by)
       VALUES ($1, $2, $3, 'user', $4, 'active', $5)
       RETURNING id, username, role, parent_client_id, raw_password, created_at`,
      [cleanUser, hashedPassword, cleanPass, parentId, req.user.username]
    );

    return res.status(201).json({
      message: `Team member login "${cleanUser}" created successfully!`,
      member: result.rows[0],
    });
  } catch (err) {
    console.error("Create team error:", err);
    return res.status(500).json({ error: "Failed to create team member: " + err.message });
  }
});

/**
 * DELETE /api/users/team/:id
 * Deletes a sub-user team login under this client
 */
router.delete("/team/:id", async (req, res) => {
  try {
    const memberId = req.params.id;
    const isMaster = req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani");
    const parentId = isMaster ? null : (req.user.parent_client_id || req.user.id);

    if (parentId) {
      const del = await db.query(
        "DELETE FROM public.users WHERE id = $1 AND parent_client_id = $2 RETURNING id, username",
        [memberId, parentId]
      );
      if (del.rows.length === 0) {
        return res.status(404).json({ error: "Team member not found or access denied." });
      }
      return res.json({ message: `Team member "${del.rows[0].username}" removed.` });
    } else {
      const del = await db.query(
        "DELETE FROM public.users WHERE id = $1 AND role != 'master_admin' RETURNING id, username",
        [memberId]
      );
      return res.json({ message: `Team member "${del.rows[0]?.username}" removed.` });
    }
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete team member." });
  }
});

module.exports = router;
