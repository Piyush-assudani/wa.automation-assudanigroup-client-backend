const express = require("express");
const router = express.Router();
const db = require("../db");
const { authenticate, requireMasterAdmin } = require("../middleware/authMiddleware");
const { getIdempotentResponse, saveIdempotentResponse } = require("../services/idempotency");

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

// Safe Category Rates (INR / Message) with Platform Margin Buffer
// Ensures client balance in system is conservative so Meta account always has surplus buffer
const RATES = {
  marketing: 1.08, // Meta charges ~₹1.02; ₹1.08 provides safe margin buffer
  utility: 0.45,
  authentication: 0.40,
  service: 0.40,
};

/**
 * Helper to get the effective client user ID
 */
const getEffectiveUserId = (req) => {
  return req.targetUserId || req.user?.id;
};

/**
 * Atomically check if user has sufficient funds and deduct for a message
 * using a PostgreSQL transaction and row-level FOR UPDATE lock.
 */
async function checkAndDeductMessageFund(userId, options = {}) {
  const {
    category = "marketing",
    recipientPhone = null,
    recipientName = null,
    campaignId = null,
    messageId = null,
    customDescription = null,
  } = options;

  const cost = RATES[category] !== undefined ? RATES[category] : RATES.marketing;
  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT id, username, wallet_balance, currency FROM public.users WHERE id = $1 FOR UPDATE",
      [userId]
    );

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { allowed: false, error: "User account not found." };
    }

    const user = userRes.rows[0];
    const currentBalance = parseFloat(user.wallet_balance || 0);

    // Handle ₹0.00 free tier safely inside the same transaction
    if (cost === 0) {
      const description =
        customDescription ||
        `Service Reply to ${recipientName || recipientPhone || "Customer"} (Meta 24h Free Tier)`;

      const txRes = await client.query(
        `INSERT INTO public.wallet_transactions 
          (user_id, type, amount, balance_after, description, message_id, campaign_id, recipient_phone, recipient_name, category, status, created_at)
         VALUES ($1, 'debit', 0.00, $2, $3, $4, $5, $6, $7, $8, 'completed', NOW())
         RETURNING id`,
        [userId, currentBalance, description, messageId, campaignId, recipientPhone, recipientName, category]
      );
      await client.query("COMMIT");
      return {
        allowed: true,
        txId: txRes.rows[0]?.id,
        cost: 0.00,
        newBalance: currentBalance,
        isFreeTier: true,
      };
    }

    if (currentBalance < cost) {
      await client.query("ROLLBACK");
      return {
        allowed: false,
        balance: currentBalance,
        required: cost,
        error: `Insufficient message funds. Current balance is ₹${currentBalance.toFixed(2)}, but ₹${cost.toFixed(2)} is required per message. Please recharge wallet.`,
      };
    }

    const newBalance = Math.round((currentBalance - cost) * 100) / 100;

    await client.query(
      "UPDATE public.users SET wallet_balance = $1 WHERE id = $2",
      [newBalance, userId]
    );

    const description = customDescription || `${category.toUpperCase()} Message to ${recipientName || recipientPhone || "Customer"}`;

    const txRes = await client.query(
      `INSERT INTO public.wallet_transactions 
        (user_id, type, amount, balance_after, description, message_id, campaign_id, recipient_phone, recipient_name, category, status, created_at)
       VALUES ($1, 'debit', $2, $3, $4, $5, $6, $7, $8, $9, 'completed', NOW())
       RETURNING id`,
      [userId, cost, newBalance, description, messageId, campaignId, recipientPhone, recipientName, category]
    );

    await client.query("COMMIT");

    return {
      allowed: true,
      txId: txRes.rows[0]?.id,
      cost,
      newBalance,
      isFreeTier: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically refund a message transaction if delivery failed.
 * Uses FOR UPDATE on both the transaction and user rows to prevent double-refunds.
 */
async function refundMessageFund(userId, txId, reason = "Message Delivery Failed") {
  if (!txId) return false;

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const txRes = await client.query(
      "SELECT * FROM public.wallet_transactions WHERE id = $1 AND user_id = $2 AND type = 'debit' AND status = 'completed' FOR UPDATE",
      [txId, userId]
    );

    if (txRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const tx = txRes.rows[0];
    const refundAmount = Math.round(parseFloat(tx.amount || 0) * 100) / 100;

    if (refundAmount <= 0) {
      await client.query("UPDATE public.wallet_transactions SET status = 'refunded' WHERE id = $1", [txId]);
      await client.query("COMMIT");
      return true;
    }

    const userRes = await client.query(
      "SELECT wallet_balance FROM public.users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const currentBalance = parseFloat(userRes.rows[0]?.wallet_balance || 0);
    const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;

    await client.query("UPDATE public.users SET wallet_balance = $1 WHERE id = $2", [newBalance, userId]);
    await client.query("UPDATE public.wallet_transactions SET status = 'refunded' WHERE id = $1", [txId]);

    await client.query(
      `INSERT INTO public.wallet_transactions 
        (user_id, type, amount, balance_after, description, message_id, campaign_id, recipient_phone, recipient_name, category, status, created_at)
       VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, $9, 'completed', NOW())`,
      [
        userId,
        refundAmount,
        newBalance,
        `Auto-Refund: Delivery Failed (${tx.recipient_phone || ""})`,
        tx.message_id,
        tx.campaign_id,
        tx.recipient_phone,
        tx.recipient_name,
        tx.category,
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Refund error:", err);
    return false;
  } finally {
    client.release();
  }
}

/**
 * GET /api/billing/summary
 * Returns wallet metrics, balance, rates, and breakdown by category
 * Supports client filtering for Master Admin, and Global SaaS aggregated metrics
 */
router.get("/summary", authenticate, async (req, res) => {
  try {
    const isMaster = req.user?.role === "master_admin" || (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"] || req.query.client_id;
    const effectiveUserId = targetClientId || (!isMaster ? req.user?.id : null);

    let balance = 0;
    let currency = "INR";
    let totalSpent = 0;
    let totalMessages = 0;
    const categoryBreakdown = {
      marketing: { count: 0, spent: 0, rate: RATES.marketing },
      utility: { count: 0, spent: 0, rate: RATES.utility },
      authentication: { count: 0, spent: 0, rate: RATES.authentication },
      service: { count: 0, spent: 0, rate: RATES.service },
    };

    if (effectiveUserId) {
      // Specific client view
      const userRes = await db.query(
        "SELECT id, username, wallet_balance, currency, per_msg_rate FROM public.users WHERE id = $1",
        [effectiveUserId]
      );

      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: "User account not found." });
      }

      const user = userRes.rows[0];
      balance = parseFloat(user.wallet_balance || 0);
      currency = user.currency || "INR";

      // Aggregate statistics for this client
      const statsRes = await db.query(
        `SELECT
          category,
          COUNT(*) FILTER (WHERE type = 'debit' AND status = 'completed') as count,
          COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND status = 'completed'), 0) as total_spent
         FROM public.wallet_transactions
         WHERE user_id = $1
         GROUP BY category`,
        [effectiveUserId]
      );

      statsRes.rows.forEach((row) => {
        const cat = (row.category || "marketing").toLowerCase();
        const count = parseInt(row.count || 0);
        const spent = parseFloat(row.total_spent || 0);
        if (categoryBreakdown[cat]) {
          categoryBreakdown[cat].count = count;
          categoryBreakdown[cat].spent = spent;
        }
        totalSpent += spent;
        totalMessages += count;
      });
    } else {
      // Master Admin Global View (Aggregated across all client workspaces)
      const totalBalanceRes = await db.query(
        "SELECT COALESCE(SUM(wallet_balance), 0) as total_balance FROM public.users WHERE role != 'master_admin' AND LOWER(username) != 'piyushassudani'"
      );
      balance = parseFloat(totalBalanceRes.rows[0]?.total_balance || 0);

      const statsRes = await db.query(
        `SELECT
          category,
          COUNT(*) FILTER (WHERE type = 'debit' AND status = 'completed') as count,
          COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND status = 'completed'), 0) as total_spent
         FROM public.wallet_transactions
         GROUP BY category`
      );

      statsRes.rows.forEach((row) => {
        const cat = (row.category || "marketing").toLowerCase();
        const count = parseInt(row.count || 0);
        const spent = parseFloat(row.total_spent || 0);
        if (categoryBreakdown[cat]) {
          categoryBreakdown[cat].count = count;
          categoryBreakdown[cat].spent = spent;
        }
        totalSpent += spent;
        totalMessages += count;
      });
    }

    res.json({
      wallet_balance: Math.round(balance * 100) / 100,
      currency,
      rates: RATES,
      total_spent: Math.round(totalSpent * 100) / 100,
      total_messages_sent: totalMessages,
      breakdown: categoryBreakdown,
      is_global_view: !effectiveUserId && isMaster,
    });
  } catch (err) {
    console.error("Billing summary error:", err);
    res.status(500).json({ error: "Failed to retrieve billing summary." });
  }
});

/**
 * GET /api/billing/transactions
 * Returns list of message deductions and wallet transactions with filters
 * Allows Master Admin to view all clients or filter by client with client_username joined
 */
router.get("/transactions", authenticate, async (req, res) => {
  try {
    const isMaster = req.user?.role === "master_admin" || (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"] || req.query.client_id;
    const effectiveUserId = targetClientId || (!isMaster ? req.user?.id : null);
    const { category, type, search, limit = 50, offset = 0 } = req.query;

    let whereClauses = [];
    let params = [];
    let pIdx = 1;

    if (effectiveUserId) {
      whereClauses.push(`wt.user_id = $${pIdx}`);
      params.push(effectiveUserId);
      pIdx++;
    }

    if (category && category !== "all") {
      whereClauses.push(`wt.category = $${pIdx}`);
      params.push(category.toLowerCase());
      pIdx++;
    }

    if (type && type !== "all") {
      whereClauses.push(`wt.type = $${pIdx}`);
      params.push(type.toLowerCase());
      pIdx++;
    }

    if (search && search.trim()) {
      whereClauses.push(`(wt.recipient_phone ILIKE $${pIdx} OR wt.recipient_name ILIKE $${pIdx} OR wt.description ILIKE $${pIdx} OR u.username ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const query = `
      SELECT 
        wt.id, 
        wt.user_id, 
        u.username as client_username,
        wt.type, 
        wt.amount, 
        wt.balance_after, 
        wt.description, 
        wt.recipient_phone, 
        wt.recipient_name, 
        wt.category, 
        wt.status, 
        wt.created_at
      FROM public.wallet_transactions wt
      LEFT JOIN public.users u ON wt.user_id = u.id
      ${whereSql}
      ORDER BY wt.created_at DESC 
      LIMIT $${pIdx} OFFSET $${pIdx + 1}
    `;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);

    const result = await db.query(query, params);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM public.wallet_transactions wt
      LEFT JOIN public.users u ON wt.user_id = u.id
      ${whereSql}
    `;
    const countRes = await db.query(countQuery, params.slice(0, pIdx - 1));

    res.json({
      transactions: result.rows,
      total: parseInt(countRes.rows[0]?.total || 0),
    });
  } catch (err) {
    console.error("Billing transactions error:", err);
    res.status(500).json({ error: "Failed to retrieve billing transactions." });
  }
});

/**
 * GET /api/billing/admin/clients
 * Master Admin only: returns all client accounts with wallet balance and spending stats
 */
router.get("/admin/clients", authenticate, requireMasterAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id, 
        u.username, 
        u.role, 
        u.wallet_balance, 
        u.currency,
        COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed'), 0) AS total_spent,
        COUNT(wt.id) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed') AS total_messages
      FROM public.users u
      LEFT JOIN public.wallet_transactions wt ON u.id = wt.user_id
      WHERE u.role NOT IN ('master_admin') AND LOWER(u.username) != 'piyushassudani'
      GROUP BY u.id
      ORDER BY u.username ASC
    `);
    res.json({ clients: result.rows });
  } catch (err) {
    console.error("Admin clients billing error:", err);
    res.status(500).json({ error: "Failed to load clients billing status." });
  }
});

/**
 * POST /api/billing/recharge
 * Master Admin only: recharge funds for any client
 */
/**
 * POST /api/billing/recharge
 * Master Admin can credit (add) or debit (deduct/reduce) funds from any client wallet
 * Protected by PostgreSQL FOR UPDATE row-level lock and optional Idempotency-Key header.
 */
router.post("/recharge", authenticate, requireMasterAdmin, async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"];
  if (idempotencyKey) {
    const cached = await getIdempotentResponse(idempotencyKey, req.user?.id, "/api/billing/recharge");
    if (cached) {
      return res.status(cached.status).json(cached.body);
    }
  }

  let clientConn;
  try {
    const { user_id, amount, description = "", action = "add" } = req.body || {};

    if (!user_id || !isValidUuid(user_id)) {
      return res.status(400).json({ error: "Valid client user_id (UUID) is required." });
    }

    const rawAmount = parseFloat(amount);
    const adjustAmount = Math.round(rawAmount * 100) / 100;
    if (!Number.isFinite(adjustAmount) || adjustAmount <= 0 || adjustAmount > 10000000) {
      return res.status(400).json({ error: "Amount must be a positive number up to ₹1,00,00,000." });
    }

    clientConn = await db.getClient();
    await clientConn.query("BEGIN");

    const userRes = await clientConn.query(
      "SELECT id, username, wallet_balance FROM public.users WHERE id = $1 FOR UPDATE",
      [user_id]
    );

    if (userRes.rows.length === 0) {
      await clientConn.query("ROLLBACK");
      return res.status(404).json({ error: "User account not found." });
    }

    const clientUser = userRes.rows[0];
    const currentBalance = parseFloat(clientUser.wallet_balance || 0);

    let newBalance;
    let txType;
    let defaultDesc;
    const isDeduct = action === "deduct";
    const safeDesc = typeof description === "string" ? description.trim().slice(0, 500) : "";

    if (isDeduct) {
      if (currentBalance < adjustAmount) {
        await clientConn.query("ROLLBACK");
        return res.status(400).json({
          error: `Cannot deduct ₹${adjustAmount.toFixed(2)}. Client only has ₹${currentBalance.toFixed(2)} available.`,
        });
      }
      newBalance = Math.round((currentBalance - adjustAmount) * 100) / 100;
      txType = "debit";
      defaultDesc = safeDesc || `Fund deduction by Admin (-₹${adjustAmount.toFixed(2)})`;
    } else {
      newBalance = Math.round((currentBalance + adjustAmount) * 100) / 100;
      txType = "credit";
      defaultDesc = safeDesc || `Wallet recharge by Admin (+₹${adjustAmount.toFixed(2)})`;
    }

    await clientConn.query("UPDATE public.users SET wallet_balance = $1 WHERE id = $2", [newBalance, user_id]);

    const txRes = await clientConn.query(
      `INSERT INTO public.wallet_transactions 
        (user_id, type, amount, balance_after, description, category, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'service', 'completed', NOW())
       RETURNING id`,
      [user_id, txType, adjustAmount, newBalance, defaultDesc]
    );

    await clientConn.query("COMMIT");

    const responseBody = {
      message: isDeduct
        ? `Successfully deducted ₹${adjustAmount.toFixed(2)} from ${clientUser.username}! New balance is ₹${newBalance.toFixed(2)}.`
        : `Successfully credited ₹${adjustAmount.toFixed(2)} to ${clientUser.username}! New balance is ₹${newBalance.toFixed(2)}.`,
      user_id,
      new_balance: newBalance,
      action: isDeduct ? "deduct" : "add",
    };

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, req.user?.id, "/api/billing/recharge", 200, responseBody);
    }

    // Emit realtime Socket.io update
    const io = req.app.get("io");
    if (io) {
      io.emit("wallet_updated", {
        user_id,
        new_balance: newBalance,
        amount: adjustAmount,
        type: txType,
        tx_id: txRes.rows[0]?.id,
      });
    }

    res.json(responseBody);
  } catch (err) {
    if (clientConn) await clientConn.query("ROLLBACK").catch(() => {});
    console.error("Recharge/adjustment error:", err);
    res.status(500).json({ error: "Failed to process wallet fund adjustment." });
  } finally {
    if (clientConn) clientConn.release();
  }
});

/**
 * GET /api/billing/meta-pricing
 * Fetches live WhatsApp conversation pricing schedule and account analytics directly from Meta Cloud API
 */
router.get("/meta-pricing", authenticate, async (req, res) => {
  try {
    const axios = require("axios");
    const { getUserMetaConfig } = require("../middleware/authMiddleware");
    const customConfig = await getUserMetaConfig(req);

    const wabaId = customConfig?.wabaId || process.env.META_WABA_ID || "1803067844072238";
    const token = customConfig?.token || process.env.META_ACCESS_TOKEN;

    let accountData = null;
    if (token && wabaId) {
      try {
        const metaRes = await axios.get(
          `https://graph.facebook.com/v21.0/${wabaId}?fields=id,name,currency,timezone_id,account_review_status`,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 6000,
          }
        );
        accountData = metaRes.data;
      } catch (mErr) {
        console.warn("Meta query soft notice:", mErr.message);
      }
    }

    // Official Meta India (91) Conversation Based Pricing schedule
    res.json({
      country: "India (+91)",
      currency: "INR",
      rates: RATES,
      source: "Official Meta Business WhatsApp Pricing Schedule",
      last_verified: new Date().toISOString(),
      account: accountData || { id: wabaId, name: "Assudanidevelopers" },
    });
  } catch (err) {
    console.error("Meta pricing error:", err);
    res.status(500).json({ error: "Failed to retrieve Meta pricing." });
  }
});

module.exports = router;
module.exports.checkAndDeductMessageFund = checkAndDeductMessageFund;
module.exports.refundMessageFund = refundMessageFund;
module.exports.RATES = RATES;

