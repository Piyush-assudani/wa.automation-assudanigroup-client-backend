const express = require("express");
const router = express.Router();
const db = require("../db");
const { authenticate, requireMasterAdmin } = require("../middleware/authMiddleware");

// Rates per message category (in INR)
const RATES = {
  marketing: 0.85,
  utility: 0.35,
  authentication: 0.30,
  service: 0.30,
};

/**
 * Helper to get the effective client user ID
 */
const getEffectiveUserId = (req) => {
  return req.targetUserId || req.user?.id;
};

/**
 * Check if user has sufficient funds and deduct for a message
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

  const cost = RATES[category] || 0.85;

  // Fetch current balance
  const userRes = await db.query(
    "SELECT id, username, wallet_balance, currency FROM public.users WHERE id = $1 FOR UPDATE",
    [userId]
  );

  if (userRes.rows.length === 0) {
    return { allowed: false, error: "User account not found." };
  }

  const user = userRes.rows[0];
  const currentBalance = parseFloat(user.wallet_balance || 0);

  if (currentBalance < cost) {
    return {
      allowed: false,
      balance: currentBalance,
      required: cost,
      error: `Insufficient message funds. Current balance is ₹${currentBalance.toFixed(2)}, but ₹${cost.toFixed(2)} is required per message. Please recharge wallet.`,
    };
  }

  const newBalance = Math.round((currentBalance - cost) * 100) / 100;

  // Deduct from wallet
  await db.query(
    "UPDATE public.users SET wallet_balance = $1 WHERE id = $2",
    [newBalance, userId]
  );

  // Record transaction
  const description = customDescription || `${category.toUpperCase()} Message to ${recipientName || recipientPhone || "Customer"}`;

  const txRes = await db.query(
    `INSERT INTO public.wallet_transactions 
      (user_id, type, amount, balance_after, description, message_id, campaign_id, recipient_phone, recipient_name, category, status, created_at)
     VALUES ($1, 'debit', $2, $3, $4, $5, $6, $7, $8, $9, 'completed', NOW())
     RETURNING id`,
    [
      userId,
      cost,
      newBalance,
      description,
      messageId,
      campaignId,
      recipientPhone,
      recipientName,
      category,
    ]
  );

  return {
    allowed: true,
    txId: txRes.rows[0]?.id,
    cost,
    newBalance,
  };
}

/**
 * Refund a message transaction if delivery failed
 */
async function refundMessageFund(userId, txId, reason = "Message Delivery Failed") {
  if (!txId) return false;

  try {
    const txRes = await db.query(
      "SELECT * FROM public.wallet_transactions WHERE id = $1 AND user_id = $2 AND type = 'debit' AND status = 'completed'",
      [txId, userId]
    );

    if (txRes.rows.length === 0) return false;
    const tx = txRes.rows[0];
    const refundAmount = parseFloat(tx.amount);

    const userRes = await db.query(
      "SELECT wallet_balance FROM public.users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const currentBalance = parseFloat(userRes.rows[0]?.wallet_balance || 0);
    const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;

    await db.query("UPDATE public.users SET wallet_balance = $1 WHERE id = $2", [newBalance, userId]);
    await db.query("UPDATE public.wallet_transactions SET status = 'refunded' WHERE id = $1", [txId]);

    await db.query(
      `INSERT INTO public.wallet_transactions 
        (user_id, type, amount, balance_after, description, message_id, campaign_id, recipient_phone, recipient_name, category, status, created_at)
       VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, $9, 'completed', NOW())`,
      [
        userId,
        refundAmount,
        newBalance,
        `Refund: ${reason} (${tx.recipient_phone || ""})`,
        tx.message_id,
        tx.campaign_id,
        tx.recipient_phone,
        tx.recipient_name,
        tx.category,
      ]
    );

    return true;
  } catch (err) {
    console.error("Refund error:", err);
    return false;
  }
}

/**
 * GET /api/billing/summary
 * Returns wallet metrics, balance, rates, and breakdown by category
 */
router.get("/summary", authenticate, async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    const userRes = await db.query(
      "SELECT id, username, wallet_balance, currency, per_msg_rate FROM public.users WHERE id = $1",
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User account not found." });
    }

    const user = userRes.rows[0];
    const balance = parseFloat(user.wallet_balance || 0);

    // Aggregate statistics
    const statsRes = await db.query(
      `SELECT
        category,
        COUNT(*) FILTER (WHERE type = 'debit' AND status = 'completed') as count,
        COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND status = 'completed'), 0) as total_spent
       FROM public.wallet_transactions
       WHERE user_id = $1
       GROUP BY category`,
      [userId]
    );

    const categoryBreakdown = {
      marketing: { count: 0, spent: 0, rate: RATES.marketing },
      utility: { count: 0, spent: 0, rate: RATES.utility },
      authentication: { count: 0, spent: 0, rate: RATES.authentication },
      service: { count: 0, spent: 0, rate: RATES.service },
    };

    let totalSpent = 0;
    let totalMessages = 0;

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

    res.json({
      wallet_balance: balance,
      currency: user.currency || "INR",
      rates: RATES,
      total_spent: Math.round(totalSpent * 100) / 100,
      total_messages_sent: totalMessages,
      breakdown: categoryBreakdown,
    });
  } catch (err) {
    console.error("Billing summary error:", err);
    res.status(500).json({ error: "Failed to retrieve billing summary." });
  }
});

/**
 * GET /api/billing/transactions
 * Returns list of message deductions and wallet transactions with filters
 */
router.get("/transactions", authenticate, async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { category, type, search, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT id, user_id, type, amount, balance_after, description, 
             recipient_phone, recipient_name, category, status, created_at
      FROM public.wallet_transactions
      WHERE user_id = $1
    `;
    const params = [userId];
    let pIdx = 2;

    if (category && category !== "all") {
      query += ` AND category = $${pIdx}`;
      params.push(category.toLowerCase());
      pIdx++;
    }

    if (type && type !== "all") {
      query += ` AND type = $${pIdx}`;
      params.push(type.toLowerCase());
      pIdx++;
    }

    if (search && search.trim()) {
      query += ` AND (recipient_phone ILIKE $${pIdx} OR recipient_name ILIKE $${pIdx} OR description ILIKE $${pIdx})`;
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${pIdx} OFFSET $${pIdx + 1}`;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);

    const result = await db.query(query, params);

    // Total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total
      FROM public.wallet_transactions
      WHERE user_id = $1
    `;
    const countParams = [userId];
    let cIdx = 2;

    if (category && category !== "all") {
      countQuery += ` AND category = $${cIdx}`;
      countParams.push(category.toLowerCase());
      cIdx++;
    }
    if (type && type !== "all") {
      countQuery += ` AND type = $${cIdx}`;
      countParams.push(type.toLowerCase());
      cIdx++;
    }
    if (search && search.trim()) {
      countQuery += ` AND (recipient_phone ILIKE $${cIdx} OR recipient_name ILIKE $${cIdx} OR description ILIKE $${cIdx})`;
      countParams.push(`%${search.trim()}%`);
      cIdx++;
    }

    const countRes = await db.query(countQuery, countParams);

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
 * POST /api/billing/recharge
 * Master Admin only: recharge funds for any client
 */
router.post("/recharge", authenticate, requireMasterAdmin, async (req, res) => {
  try {
    const { user_id, amount, description = "Admin Wallet Recharge" } = req.body || {};

    if (!user_id) {
      return res.status(400).json({ error: "Client user_id is required." });
    }

    const rechargeAmount = parseFloat(amount);
    if (isNaN(rechargeAmount) || rechargeAmount <= 0) {
      return res.status(400).json({ error: "Recharge amount must be a positive number." });
    }

    const userRes = await db.query(
      "SELECT id, username, wallet_balance FROM public.users WHERE id = $1 FOR UPDATE",
      [user_id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User account not found." });
    }

    const client = userRes.rows[0];
    const currentBalance = parseFloat(client.wallet_balance || 0);
    const newBalance = Math.round((currentBalance + rechargeAmount) * 100) / 100;

    await db.query("UPDATE public.users SET wallet_balance = $1 WHERE id = $2", [newBalance, user_id]);

    await db.query(
      `INSERT INTO public.wallet_transactions 
        (user_id, type, amount, balance_after, description, category, status, created_at)
       VALUES ($1, 'credit', $2, $3, $4, 'service', 'completed', NOW())`,
      [user_id, rechargeAmount, newBalance, description.trim() || `Recharged by Admin (+₹${rechargeAmount.toFixed(2)})`]
    );

    res.json({
      message: `Successfully credited ₹${rechargeAmount.toFixed(2)} to ${client.username}! New balance is ₹${newBalance.toFixed(2)}.`,
      user_id,
      new_balance: newBalance,
    });
  } catch (err) {
    console.error("Recharge error:", err);
    res.status(500).json({ error: "Failed to recharge client wallet." });
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

