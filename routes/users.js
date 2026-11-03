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
    const result = await db.query(`
      SELECT id, username, role, whatsapp_mode, meta_display_phone_number, meta_verified_name
      FROM public.users
      ORDER BY 
        CASE WHEN role = 'master_admin' THEN 1 WHEN role = 'admin' THEN 2 ELSE 3 END,
        username ASC
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
      phone_number: "+91 82339 57004",
      phone_id: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
      waba_id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
      verified_name: "Assudani WA Automations (Central Company)",
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

    // If personal mode with new credentials, test against Meta Graph API
    if (mode === "personal" && meta_phone_number_id && meta_access_token) {
      try {
        const metaRes = await getAccountHealth(meta_phone_number_id.trim(), meta_access_token.trim());
        if (metaRes.success && metaRes.data) {
          verifiedName = metaRes.data.verified_name || null;
          displayPhone = metaRes.data.display_phone_number || null;
        }
      } catch (metaErr) {
        return res.status(400).json({
          error: `Meta validation failed: ${metaErr.response?.data?.error?.message || metaErr.message}`,
        });
      }
    }

    let updateQuery;
    let params;

    if (meta_access_token && meta_access_token.trim() !== "") {
      updateQuery = `
        UPDATE public.users 
        SET whatsapp_mode = $1, 
            meta_phone_number_id = COALESCE($2, meta_phone_number_id),
            meta_waba_id = COALESCE($3, meta_waba_id),
            meta_access_token = $4,
            meta_verified_name = COALESCE($5, meta_verified_name),
            meta_display_phone_number = COALESCE($6, meta_display_phone_number)
        WHERE id = $7
        RETURNING id, username, role, whatsapp_mode, meta_display_phone_number;
      `;
      params = [
        mode,
        meta_phone_number_id ? meta_phone_number_id.trim() : null,
        meta_waba_id ? meta_waba_id.trim() : null,
        meta_access_token.trim(),
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
        RETURNING id, username, role, whatsapp_mode, meta_display_phone_number;
      `;
      params = [
        mode,
        meta_phone_number_id ? meta_phone_number_id.trim() : null,
        meta_waba_id ? meta_waba_id.trim() : null,
        effectiveUserId,
      ];
    }

    const updated = await db.query(updateQuery, params);

    return res.json({
      message: `Sender channel successfully switched to ${mode === 'company' ? 'Company Central Number' : 'Personal Meta Cloud API'}!`,
      user: updated.rows[0],
    });
  } catch (err) {
    console.error("Save channel config error:", err);
    return res.status(500).json({ error: "Failed to update channel settings." });
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
        whatsapp_mode, 
        meta_phone_number_id, 
        meta_waba_id,
        meta_display_phone_number,
        meta_verified_name,
        status, 
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

  if (cleanPass.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
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
        role,
        whatsapp_mode,
        meta_phone_number_id,
        meta_waba_id,
        meta_access_token,
        meta_verified_name,
        meta_display_phone_number,
        status,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
      RETURNING id, username, role, whatsapp_mode, meta_display_phone_number, created_at;
    `, [
      cleanUser,
      hashedPassword,
      role === "master_admin" ? "admin" : role, // Prevent creating another master_admin
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
 * Updates an existing user (Master Admin only)
 */
router.put("/:id", requireMasterAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    username,
    password,
    role,
    whatsapp_mode,
    meta_phone_number_id,
    meta_waba_id,
    meta_access_token,
    status = "active",
  } = req.body || {};

  try {
    const existing = await db.query("SELECT * FROM public.users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const current = existing.rows[0];

    // Disallow demoting master admin
    let finalRole = role || current.role;
    if (current.role === "master_admin") {
      finalRole = "master_admin";
    }

    let finalPassword = current.password;
    if (password && password.trim().length >= 6) {
      finalPassword = await bcrypt.hash(password.trim(), 10);
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

    const updateResult = await db.query(`
      UPDATE public.users SET
        username = COALESCE($1, username),
        password = $2,
        role = $3,
        whatsapp_mode = COALESCE($4, whatsapp_mode),
        meta_phone_number_id = COALESCE($5, meta_phone_number_id),
        meta_waba_id = COALESCE($6, meta_waba_id),
        meta_access_token = CASE WHEN $7 IS NOT NULL AND $7 <> '' THEN $7 ELSE meta_access_token END,
        meta_verified_name = COALESCE($8, meta_verified_name),
        meta_display_phone_number = COALESCE($9, meta_display_phone_number),
        status = COALESCE($10, status)
      WHERE id = $11
      RETURNING id, username, role, whatsapp_mode, meta_display_phone_number, status;
    `, [
      username ? username.trim() : null,
      finalPassword,
      finalRole,
      whatsapp_mode || null,
      meta_phone_number_id ? meta_phone_number_id.trim() : null,
      meta_waba_id ? meta_waba_id.trim() : null,
      meta_access_token ? meta_access_token.trim() : null,
      verifiedName,
      displayPhone,
      status,
      id,
    ]);

    return res.json({
      message: "User successfully updated!",
      user: updateResult.rows[0],
    });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({ error: "Failed to update user." });
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

module.exports = router;
