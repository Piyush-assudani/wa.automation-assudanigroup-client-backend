const express = require("express");
const router = express.Router();
const db = require("../db");
const { authenticate } = require("../middleware/authMiddleware");

// In-memory cache for dashboard stats (5-second TTL, can be bypassed with ?nocache=1 or cleared)
const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL = 5 * 1000;

function invalidateDashboardCache() {
  dashboardCache.clear();
}

router.use(authenticate);

router.get("/", async (req, res) => {
  try {
    const { startDate, endDate, nocache } = req.query;

    const isMasterAdmin =
      req.user?.role === "master_admin" ||
      (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"];

    // Multi-tenant Scoping:
    // If master admin without targetClientId, effectiveUserId is null (Global Mode across all clients)
    // If client, effectiveUserId is req.targetUserId || req.user.id
    let effectiveUserId = null;
    if (isMasterAdmin && targetClientId) {
      effectiveUserId = targetClientId;
    } else if (!isMasterAdmin) {
      effectiveUserId = req.targetUserId || req.user?.id;
    }

    const cacheKey = `${effectiveUserId || "global"}_${startDate || "all"}_${endDate || "all"}`;
    if (!nocache && nocache !== "1" && nocache !== "true") {
      const cached = dashboardCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < DASHBOARD_CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    // 1. Total Contacts
    let contactsCount = 0;
    if (effectiveUserId) {
      const resC = await db.query(
        "SELECT COUNT(*) FROM public.contacts WHERE user_id = $1",
        [effectiveUserId]
      );
      contactsCount = parseInt(resC.rows[0]?.count || 0, 10);
    } else {
      const resC = await db.query("SELECT COUNT(*) FROM public.contacts");
      contactsCount = parseInt(resC.rows[0]?.count || 0, 10);
    }

    // 2. Total Contact Lists
    let listsCount = 0;
    if (effectiveUserId) {
      const resL = await db.query(
        "SELECT COUNT(*) FROM public.contact_lists WHERE user_id = $1",
        [effectiveUserId]
      );
      listsCount = parseInt(resL.rows[0]?.count || 0, 10);
    } else {
      const resL = await db.query("SELECT COUNT(*) FROM public.contact_lists");
      listsCount = parseInt(resL.rows[0]?.count || 0, 10);
    }

    // 3. Campaigns count and totals
    let campaignWhere = [];
    let campaignParams = [];
    if (effectiveUserId) {
      campaignParams.push(effectiveUserId);
      campaignWhere.push(`user_id = $${campaignParams.length}`);
    }
    if (startDate && endDate) {
      campaignParams.push(startDate, endDate);
      campaignWhere.push(
        `DATE(created_at) >= $${campaignParams.length - 1} AND DATE(created_at) <= $${campaignParams.length}`
      );
    }
    const campWhereStr = campaignWhere.length > 0 ? `WHERE ${campaignWhere.join(" AND ")}` : "";

    const campaignsRes = await db.query(
      `SELECT 
        COUNT(*) as total_campaigns,
        COALESCE(SUM(total_sent), 0) as total_sent
      FROM public.campaigns
      ${campWhereStr}`,
      campaignParams
    );
    const c = campaignsRes.rows[0] || {};
    const totalCampaigns = parseInt(c.total_campaigns || 0, 10);
    const campaignsSent = parseInt(c.total_sent || 0, 10);

    // 4. Message counts from messages table
    let msgWhere = [];
    let msgParams = [];
    let msgFrom = "public.messages m";

    if (effectiveUserId) {
      msgFrom += " JOIN public.contacts c ON m.contact_id = c.id";
      msgParams.push(effectiveUserId);
      msgWhere.push(`c.user_id = $${msgParams.length}`);
    }
    if (startDate && endDate) {
      msgParams.push(startDate, endDate);
      msgWhere.push(
        `DATE(m.timestamp) >= $${msgParams.length - 1} AND DATE(m.timestamp) <= $${msgParams.length}`
      );
    }
    const msgWhereStr = msgWhere.length > 0 ? `WHERE ${msgWhere.join(" AND ")}` : "";

    const msgsRes = await db.query(
      `SELECT 
        m.direction,
        m.status,
        COUNT(*) as count
      FROM ${msgFrom}
      ${msgWhereStr}
      GROUP BY m.direction, m.status`,
      msgParams
    );

    let totalMessagesSent = 0;
    let totalMessagesReceived = 0;
    let exactSent = 0;
    let exactDelivered = 0;
    let exactRead = 0;
    let exactFailed = 0;

    msgsRes.rows.forEach((row) => {
      const count = parseInt(row.count, 10);
      if (row.direction === "inbound") {
        totalMessagesReceived += count;
      } else {
        totalMessagesSent += count;
        if (row.status === "sent") exactSent += count;
        else if (row.status === "delivered") exactDelivered += count;
        else if (row.status === "read") exactRead += count;
        else if (row.status === "failed") exactFailed += count;
      }
    });

    const finalSent = Math.max(campaignsSent, totalMessagesSent);
    const finalDelivered = exactDelivered + exactRead;
    const finalRead = exactRead;
    const finalFailed = exactFailed;

    let deliveryRate = "0.0";
    if (finalSent > 0) {
      deliveryRate = ((finalDelivered / finalSent) * 100).toFixed(1);
    }

    const payload = {
      totalLeads: contactsCount,
      totalLists: listsCount,
      totalCampaigns,
      totalMessagesSent: finalSent,
      totalMessagesReceived,
      deliveryRate,
      campaignStatus: {
        sent: finalSent,
        delivered: finalDelivered,
        read: finalRead,
        failed: finalFailed,
      },
    };

    // Cache the result
    dashboardCache.set(cacheKey, { timestamp: Date.now(), data: payload });

    res.json(payload);
  } catch (err) {
    console.error("❌ Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to generate dashboard analytics." });
  }
});

module.exports = router;
module.exports.invalidateDashboardCache = invalidateDashboardCache;
