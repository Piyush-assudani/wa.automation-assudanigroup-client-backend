const express = require("express");
const router = express.Router();
const multer = require("multer");
const db = require("../db");
const {
  processCampaign,
  pauseCampaign,
  resumeCampaignState,
  isCampaignActive,
} = require("../services/campaignProcessor");
const { uploadFileToServer } = require("../services/localStorageService");
const { RATES } = require("./billing");
const { getIdempotentResponse, saveIdempotentResponse } = require("../services/idempotency");
const os = require("os");
const path = require("path");
const xlsx = require("xlsx");
const jwt = require("jsonwebtoken");
const { uploadMediaToMeta, getTemplates, sendTemplateMessage } = require("../services/metaApi");
const { getUserMetaConfig, authenticate, JWT_SECRET } = require("../middleware/authMiddleware");

router.use(authenticate);

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

const uploadMedia = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB limit for video/image promo assets
});

/**
 * POST /api/campaigns
 * Launch broadcast campaign across one or multiple contact lists
 */
router.post("/", uploadMedia.single("mediaFile"), async (req, res) => {
  try {
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey) {
      const cached = await getIdempotentResponse(idempotencyKey, req.user?.id, "/api/campaigns");
      if (cached) {
        return res.status(cached.status).json(cached.body);
      }
    }

    const { name, template_name, language_code, contact_list_ids } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Campaign name is required." });
    }

    if (!template_name || typeof template_name !== "string" || !template_name.trim()) {
      return res.status(400).json({ error: "Template name is required." });
    }

    if (!contact_list_ids) {
      return res.status(400).json({ error: "At least one contact list must be selected." });
    }

    let parsedListIds = [];
    try {
      parsedListIds = typeof contact_list_ids === "string" ? JSON.parse(contact_list_ids) : contact_list_ids;
    } catch (e) {
      parsedListIds = [contact_list_ids];
    }

    if (!Array.isArray(parsedListIds)) {
      parsedListIds = [parsedListIds];
    }

    parsedListIds = parsedListIds.filter(isValidUuid);

    if (parsedListIds.length === 0) {
      return res.status(400).json({ error: "No valid contact lists were selected." });
    }

    // Inspect template to verify header requirements, language, and body parameters
    let paramCount = 0;
    let templateRequiresMediaHeader = false;
    let requiredHeaderFormat = null;
    let resolvedLanguageCode = language_code || "en_US";
    let templateFetched = false;
    const customConfig = await getUserMetaConfig(req);

    try {
      const templates = await getTemplates(customConfig);
      const tpl = (templates || []).find((t) => t.name === template_name.trim());
      if (tpl) {
        templateFetched = true;
        if (tpl.language) {
          resolvedLanguageCode = tpl.language;
        }
        if (tpl.components) {
          const headerComponent = tpl.components.find((c) => c.type === "HEADER");
          if (headerComponent && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerComponent.format)) {
            templateRequiresMediaHeader = true;
            requiredHeaderFormat = headerComponent.format.toLowerCase();
          }

          const bodyComponent = tpl.components.find((c) => c.type === "BODY");
          if (bodyComponent && bodyComponent.text) {
            const matches = bodyComponent.text.match(/\{\{\d+\}\}/g);
            if (matches) paramCount = new Set(matches).size;
          }
        }
      }
    } catch (err) {
      console.warn("Could not fetch templates to check params:", err.message);
    }

    const incomingMediaUrl = req.body.media_url || req.body.existing_media_url || null;
    const incomingMediaId = req.body.media_id || null;

    if (templateFetched && templateRequiresMediaHeader && !req.file && !incomingMediaUrl && !incomingMediaId) {
      return res.status(400).json({
        error: `Template "${template_name.trim()}" requires a ${requiredHeaderFormat} header. Please attach a ${requiredHeaderFormat} file or select from Media Gallery before launching.`,
      });
    }

    let media_id = incomingMediaId || null;
    let media_type = null;
    const publicBaseUrl = (process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    let media_url = incomingMediaUrl ? (publicBaseUrl ? incomingMediaUrl.replace(/http:\/\/localhost:\d+/g, publicBaseUrl) : incomingMediaUrl) : null;

    // Only upload and attach media header if the template actually expects a media header (or if template lookup failed)
    if (req.file && (!templateFetched || templateRequiresMediaHeader)) {
      if (req.file.mimetype.startsWith("image/")) {
        media_type = "image";
      } else if (req.file.mimetype.startsWith("video/")) {
        media_type = "video";
      } else {
        media_type = "document";
      }

      if (templateRequiresMediaHeader && requiredHeaderFormat && media_type !== requiredHeaderFormat) {
        return res.status(400).json({
          error: `Template "${template_name.trim()}" requires a ${requiredHeaderFormat} header, but a ${media_type} file was uploaded.`,
        });
      }

      media_id = await uploadMediaToMeta(req.file.path, req.file.mimetype, customConfig);
      if (!media_id) {
        return res.status(500).json({ error: "Failed to upload media to WhatsApp Meta API." });
      }

      try {
        let resourceType = "auto";
        if (media_type === "image") resourceType = "image";
        if (media_type === "video") resourceType = "video";
        media_url = await uploadFileToServer(req.file.path, "campaigns", resourceType);

        // Also register in media_assets library
        db.query(
          `INSERT INTO media_assets (original_name, media_url, meta_media_id, resource_type)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [req.file.originalname, media_url, media_id, media_type]
        ).catch(() => {});
      } catch (uploadErr) {
        console.warn("Media storage upload skipped, proceeding with Meta ID:", uploadErr.message);
      }
    } else if (incomingMediaUrl) {
      media_type = (req.body.media_type || (requiredHeaderFormat ? requiredHeaderFormat.toLowerCase() : "image"));
    }

    // Fetch distinct members across all chosen contact lists
    const membersResult = await db.query(
      `SELECT DISTINCT c.id, c.phone_number, c.name, c.city
       FROM contact_list_members clm
       JOIN contacts c ON clm.contact_id = c.id
       WHERE clm.list_id = ANY($1::uuid[])`,
      [parsedListIds]
    );

    if (membersResult.rows.length === 0) {
      return res.status(400).json({ error: "Selected contact lists have no recipients or are empty." });
    }

    // META POLICY & HEALTH GUARDRAILS
    const { validateCampaignGuardrails, validateMetaContent } = require("../services/metaPolicyGuard");
    const guardCheck = validateCampaignGuardrails(membersResult.rows.length);
    if (!guardCheck.allowed) {
      return res.status(400).json({ error: guardCheck.error });
    }

    const nameCheck = validateMetaContent(name.trim(), "Campaign Name");
    if (!nameCheck.compliant) {
      return res.status(400).json({ error: nameCheck.error });
    }

    const effectiveUserId = req.targetUserId || req.user?.id || null;

    // WALLET BALANCE ENFORCEMENT
    // Ensure client cannot send even one more message than their funded balance
    if (effectiveUserId) {
      const userRes = await db.query(
        "SELECT wallet_balance FROM public.users WHERE id = $1",
        [effectiveUserId]
      );
      const balance = parseFloat(userRes.rows[0]?.wallet_balance || 0);
      const marketingRate = RATES.marketing || 1.08;
      const requiredCost = Math.round(membersResult.rows.length * marketingRate * 100) / 100;

      if (balance < requiredCost) {
        return res.status(402).json({
          error: `Insufficient wallet balance. This campaign has ${membersResult.rows.length} recipients requiring ₹${requiredCost.toFixed(2)} (at ₹${marketingRate.toFixed(2)}/marketing message), but your available balance is ₹${balance.toFixed(2)}. Please recharge your wallet before launching.`,
          required: requiredCost,
          balance,
        });
      }
    }

    const { scheduled_at, sender_channel_id } = req.body;
    const isScheduled = scheduled_at && new Date(scheduled_at) > new Date();
    const initialStatus = isScheduled ? "scheduled" : "completed";

    // Resolve Sender Channel & Meta API Configuration
    let senderConfig = null;
    let senderChannelId = null;
    let senderPhoneId = null;
    let senderPhone = null;
    let senderName = null;

    if (sender_channel_id && sender_channel_id !== "company" && isValidUuid(sender_channel_id)) {
      const chanRes = await db.query(
        `SELECT id, channel_name, phone_number_id, waba_id, access_token, display_phone_number, verified_name 
         FROM public.user_whatsapp_channels 
         WHERE id = $1 AND (user_id = $2 OR user_id IN (SELECT parent_client_id FROM public.users WHERE id = $2))`,
        [sender_channel_id, effectiveUserId]
      );
      if (chanRes.rows.length > 0) {
        const chan = chanRes.rows[0];
        senderChannelId = chan.id;
        senderPhoneId = chan.phone_number_id;
        senderPhone = chan.display_phone_number || chan.phone_number_id;
        senderName = chan.verified_name || chan.channel_name;
        senderConfig = {
          channelId: chan.id,
          phoneId: chan.phone_number_id.trim(),
          token: chan.access_token.trim(),
          wabaId: chan.waba_id ? chan.waba_id.trim() : null,
          displayPhone: chan.display_phone_number,
          verifiedName: chan.verified_name,
        };
      }
    } else if (sender_channel_id === "company") {
      senderPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
      senderPhone = process.env.COMPANY_WHATSAPP_NUMBER || process.env.META_DISPLAY_PHONE_NUMBER || null;
      senderName = "Company WhatsApp Central";
      senderConfig = null;
    } else {
      senderConfig = await getUserMetaConfig(req);
      if (senderConfig && senderConfig.channelId) {
        senderChannelId = senderConfig.channelId;
        senderPhoneId = senderConfig.phoneId;
        senderPhone = senderConfig.displayPhone || senderConfig.phoneId;
        senderName = senderConfig.verifiedName || "Personal WhatsApp";
      } else if (senderConfig && senderConfig.phoneId) {
        senderPhoneId = senderConfig.phoneId;
        senderPhone = senderConfig.displayPhone || senderConfig.phoneId;
        senderName = senderConfig.verifiedName || "Personal WhatsApp";
      } else {
        senderPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
        senderPhone = process.env.COMPANY_WHATSAPP_NUMBER || process.env.META_DISPLAY_PHONE_NUMBER || null;
        senderName = "Company WhatsApp Central";
      }
    }

    const campaignResult = await db.query(
      `INSERT INTO campaigns (name, template_name, contact_list_id, media_id, media_type, media_url, total_sent, user_id, scheduled_at, status, sender_channel_id, sender_phone_number_id, sender_phone_number, sender_name)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        name.trim().slice(0, 255),
        template_name.trim(),
        parsedListIds[0],
        media_id,
        media_type,
        media_url,
        effectiveUserId,
        isScheduled ? new Date(scheduled_at).toISOString() : null,
        initialStatus,
        senderChannelId,
        senderPhoneId,
        senderPhone,
        senderName,
      ]
    );
    const campaign = campaignResult.rows[0];

    const messages = membersResult.rows.map((member) => {
      const bodyParams = [];
      if (paramCount >= 1) {
        bodyParams.push({ type: "text", text: member.name || "Customer" });
      }
      if (paramCount >= 2) {
        bodyParams.push({ type: "text", text: member.city || "Valued Client" });
      }
      for (let i = 2; i < paramCount; i++) {
        bodyParams.push({ type: "text", text: "Update" });
      }

      const sanitizedPhone = member.phone_number ? String(member.phone_number).replace(/\D/g, "") : "";

      return {
        to: sanitizedPhone,
        contactId: member.id,
        bodyParams,
      };
    });

    if (!isScheduled) {
      const io = req.app.get("io");
      // Run campaign processing asynchronously in background so response returns instantly
      processCampaign(
        messages,
        campaign.id,
        template_name.trim(),
        resolvedLanguageCode,
        io,
        media_id,
        media_type,
        media_url,
        senderConfig,
        senderPhoneId,
        senderPhone
      ).catch((err) => console.error("❌ Background campaign processing error:", err.message));
    }

    // Keep history clean: automatically keep the last 100 campaigns
    db.query(
      `DELETE FROM campaigns 
       WHERE id NOT IN (
         SELECT id FROM campaigns 
         ORDER BY created_at DESC 
         LIMIT 100
       )`
    ).catch(() => {});

    const responseBody = {
      message: isScheduled
        ? `Campaign successfully scheduled for ${new Date(scheduled_at).toLocaleString()}`
        : "Campaign launched and queued for delivery",
      campaign: {
        id: campaign.id,
        name: campaign.name,
        template_name: campaign.template_name,
        total_recipients: messages.length,
        scheduled_at: campaign.scheduled_at,
        status: campaign.status,
        created_at: campaign.created_at,
      },
    };

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, req.user?.id, "/api/campaigns", 201, responseBody);
    }

    res.status(201).json(responseBody);
  } catch (err) {
    console.error("❌ Campaign creation error:", err);
    res.status(500).json({ error: "Failed to create and dispatch campaign." });
  }
});

/**
 * GET /api/campaigns
 * List all campaigns with aggregate delivery metrics (scoped to active tenant)
 */
router.get("/", async (req, res) => {
  try {
    const isMaster =
      req.user?.role === "master_admin" ||
      (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"] || req.query.client_id;

    let effectiveUserId = null;
    if (isMaster && targetClientId && targetClientId !== "all") {
      effectiveUserId = targetClientId;
    } else if (!isMaster) {
      effectiveUserId = req.targetUserId || req.user?.id;
    }

    let whereClause = "";
    let params = [];
    if (effectiveUserId) {
      whereClause = "WHERE c.user_id = $1";
      params.push(effectiveUserId);
    }

    const result = await db.query(
      `SELECT
        c.*,
        u.username as client_username,
        COALESCE(ms.total_messages, 0) as total_messages,
        COALESCE(ms.total_delivered, 0) as total_delivered,
        COALESCE(ms.total_read, 0) as total_read,
        COALESCE(ms.total_failed, 0) as total_failed,
        COALESCE(clm.total_recipients, 0) as total_recipients
      FROM public.campaigns c
      LEFT JOIN public.users u ON c.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) as total_messages,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as total_delivered,
          COUNT(CASE WHEN status = 'read' THEN 1 END) as total_read,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as total_failed
        FROM public.messages m
        WHERE m.campaign_id = c.id
      ) ms ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as total_recipients
        FROM public.contact_list_members clm_sub
        WHERE clm_sub.list_id = c.contact_list_id
      ) clm ON true
      ${whereClause}
      ORDER BY c.created_at DESC`,
      params
    );
    const publicBaseUrl = (process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    const rows = result.rows.map(c => ({
      ...c,
      is_running: isCampaignActive(c.id) || c.status === "in_progress",
      media_url: (publicBaseUrl && c.media_url) ? c.media_url.replace(/http:\/\/localhost:\d+/g, publicBaseUrl) : c.media_url,
    }));
    res.json(rows);
  } catch (err) {
    console.error("❌ List campaigns error:", err);
    res.status(500).json({ error: "Failed to list campaigns." });
  }
});

/**
 * GET /api/campaigns/:id
 * Retrieve details and delivery metrics for a specific campaign
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campaignResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const statsResult = await db.query(
      `SELECT
        status,
        COUNT(*) as count
      FROM messages
      WHERE campaign_id = $1
      GROUP BY status`,
      [id]
    );

    const senderBreakdown = await db.query(
      `SELECT
        COALESCE(m.sender_phone_number, c.sender_phone_number, 'Default Channel') as sender_phone_number,
        COALESCE(m.sender_phone_number_id, c.sender_phone_number_id, 'default') as sender_phone_number_id,
        COALESCE(c.sender_name, 'WhatsApp Channel') as sender_name,
        COUNT(*) as total_messages,
        COUNT(*) FILTER (WHERE m.status IN ('sent', 'delivered', 'read')) as total_successful,
        COUNT(*) FILTER (WHERE m.status = 'delivered') as delivered_count,
        COUNT(*) FILTER (WHERE m.status = 'read') as read_count,
        COUNT(*) FILTER (WHERE m.status = 'sent') as sent_count,
        COUNT(*) FILTER (WHERE m.status = 'failed') as failed_count
       FROM messages m
       LEFT JOIN campaigns c ON m.campaign_id = c.id
       WHERE m.campaign_id = $1
       GROUP BY m.sender_phone_number, m.sender_phone_number_id, c.sender_phone_number, c.sender_phone_number_id, c.sender_name
       ORDER BY total_messages DESC`,
      [id]
    );

    const camp = campaignResult.rows[0];
    const publicBaseUrl = (process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    if (camp && camp.media_url && publicBaseUrl) {
      camp.media_url = camp.media_url.replace(/http:\/\/localhost:\d+/g, publicBaseUrl);
    }

    let totalInList = 0;
    if (camp && camp.contact_list_id) {
      const listCountRes = await db.query(
        `SELECT COUNT(*) FROM contact_list_members WHERE list_id = $1`,
        [camp.contact_list_id]
      ).catch(() => ({ rows: [{ count: 0 }] }));
      totalInList = parseInt(listCountRes.rows[0]?.count || 0, 10);
    }
    const totalProcessed = statsResult.rows.reduce((sum, r) => sum + parseInt(r.count || 0, 10), 0);
    const unsentCount = Math.max(0, totalInList - totalProcessed);

    res.json({
      ...camp,
      is_running: isCampaignActive(id) || camp.status === "in_progress",
      stats: statsResult.rows,
      sender_breakdown: senderBreakdown.rows,
      total_in_list: totalInList,
      unsent_count: unsentCount,
    });
  } catch (err) {
    console.error("❌ Campaign detail error:", err);
    res.status(500).json({ error: "Failed to fetch campaign details." });
  }
});

/**
 * GET /api/campaigns/:id/recipients
 * Retrieve individual recipient delivery statuses
 */
router.get("/:id/recipients", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const result = await db.query(
      `SELECT m.id, c.phone_number, c.name, m.status, m.timestamp, m.error_message,
              COALESCE(m.sender_phone_number, 'Default') as sender_phone_number,
              m.sender_phone_number_id
       FROM messages m
       JOIN contacts c ON m.contact_id = c.id
       WHERE m.campaign_id = $1
       ORDER BY m.timestamp DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Campaign recipients error:", err);
    res.status(500).json({ error: "Failed to fetch campaign recipient list." });
  }
});

/**
 * DELETE /api/campaigns/:id
 * Delete campaign and associated messages
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    await db.query("DELETE FROM messages WHERE campaign_id = $1", [id]);
    const result = await db.query("DELETE FROM campaigns WHERE id = $1 RETURNING id", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ message: "Campaign deleted successfully" });
  } catch (err) {
    console.error("❌ Campaign deletion error:", err);
    res.status(500).json({ error: "Failed to delete campaign." });
  }
});

/**
 * POST /api/campaigns/:id/retry
 * Retry sending failed messages (supports category-based retry or specific message IDs)
 */
router.post("/:id/retry", async (req, res) => {
  try {
    const { id } = req.params;
    const { category, message_id, message_ids } = req.body || {};

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campResult.rows[0];

    // Build query for failed messages to retry
    let query = `
      SELECT m.id, m.contact_id, m.error_message, c.phone_number, c.name
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.campaign_id = $1 AND m.status = 'failed'
    `;
    const params = [id];

    if (message_id && isValidUuid(message_id)) {
      query += ` AND m.id = $2`;
      params.push(message_id);
    } else if (Array.isArray(message_ids) && message_ids.length > 0) {
      const validIds = message_ids.filter(isValidUuid);
      if (validIds.length > 0) {
        query += ` AND m.id = ANY($2::uuid[])`;
        params.push(validIds);
      }
    } else if (category && category !== "all" && category !== "failed") {
      if (category === "not-on-whatsapp") {
        query += ` AND (LOWER(COALESCE(m.error_message, '')) LIKE '%undeliverable%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%not on whatsapp%')`;
      } else if (category === "spam-filtered") {
        query += ` AND (LOWER(COALESCE(m.error_message, '')) LIKE '%ecosystem%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%spam%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%re-engagement%')`;
      } else if (category === "rate-limit") {
        query += ` AND (LOWER(COALESCE(m.error_message, '')) LIKE '%rate limit%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%throughput%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%tier%')`;
      } else if (category === "template-mismatch") {
        query += ` AND (LOWER(COALESCE(m.error_message, '')) LIKE '%header%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%parameter%' OR LOWER(COALESCE(m.error_message, '')) LIKE '%template%')`;
      } else if (category === "other-failed") {
        query += ` AND NOT (LOWER(COALESCE(m.error_message, '')) LIKE ANY(ARRAY['%undeliverable%', '%not on whatsapp%', '%ecosystem%', '%spam%', '%re-engagement%', '%rate limit%', '%throughput%', '%tier%', '%header%', '%parameter%']))`;
      }
    }

    const messagesResult = await db.query(query, params);
    const toRetry = messagesResult.rows;

    if (toRetry.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No failed recipients matched the selected criteria.",
        retried: 0,
        successful: 0,
        failed: 0
      });
    }

    const customMetaConfig = await getUserMetaConfig(req);

    // Inspect template to know header/body requirements
    let mediaType = null;
    let hasBodyParam = false;
    try {
      const templates = await getTemplates(customMetaConfig);
      const tpl = (templates || []).find((t) => t.name === campaign.template_name);
      if (tpl?.components) {
        const headerComponent = tpl.components.find((c) => c.type === "HEADER");
        if (headerComponent && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerComponent.format)) {
          mediaType = headerComponent.format.toLowerCase();
        }
        const bodyComp = tpl.components.find((c) => c.type === "BODY");
        if (bodyComp?.text && /\{\{\d+\}\}/.test(bodyComp.text)) {
          hasBodyParam = true;
        }
      }
    } catch (e) {
      console.warn("Could not inspect template for retry:", e.message);
    }

    // Fallback mediaType from URL
    if (!mediaType && (campaign.media_url || campaign.media_id)) {
      const urlLower = (campaign.media_url || "").toLowerCase();
      if (urlLower.endsWith(".mp4") || urlLower.endsWith(".mov")) mediaType = "video";
      else if (urlLower.endsWith(".pdf") || urlLower.endsWith(".doc") || urlLower.endsWith(".docx")) mediaType = "document";
      else mediaType = "image";
    }

    // If retrying all or category-based failed recipients, spawn a NEW dedicated campaign
    if (!message_id) {
      let newCampaignName = `${campaign.name} (Failed Retry Campaign)`;
      const existingNameCheck = await db.query(
        "SELECT id FROM campaigns WHERE name = $1 AND user_id = $2",
        [newCampaignName, campaign.user_id]
      );
      if (existingNameCheck.rows.length > 0) {
        newCampaignName = `${campaign.name} (Failed Retry Campaign - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
      }

      const listName = `${campaign.name} - Failed Recipients (${toRetry.length})`;
      const listRes = await db.query(
        "INSERT INTO contact_lists (name, user_id) VALUES ($1, $2) RETURNING id",
        [listName.slice(0, 255), campaign.user_id]
      );
      const newContactListId = listRes.rows[0].id;

      for (const msg of toRetry) {
        await db.query(
          "INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [newContactListId, msg.contact_id]
        );
      }

      let senderConfig = null;
      let senderChannelId = campaign.sender_channel_id;
      let senderPhoneId = campaign.sender_phone_number_id;
      let senderPhone = campaign.sender_phone_number;
      let senderName = campaign.sender_name;

      if (senderChannelId) {
        const chanRes = await db.query(
          "SELECT * FROM public.user_whatsapp_channels WHERE id = $1",
          [senderChannelId]
        );
        if (chanRes.rows.length > 0) {
          const ch = chanRes.rows[0];
          senderConfig = {
            channelId: ch.id,
            phoneId: ch.phone_number_id.trim(),
            token: ch.access_token.trim(),
            wabaId: ch.waba_id ? ch.waba_id.trim() : null,
            displayPhone: ch.display_phone_number,
            verifiedName: ch.verified_name,
          };
          senderPhoneId = ch.phone_number_id;
          senderPhone = ch.display_phone_number || ch.phone_number_id;
          senderName = ch.verified_name || ch.channel_name;
        }
      }

      if (!senderConfig) {
        senderConfig = await getUserMetaConfig(req);
      }

      const newCampRes = await db.query(
        `INSERT INTO campaigns (
           name, template_name, contact_list_id, media_id, media_type, media_url,
           total_sent, user_id, scheduled_at, status, sender_channel_id,
           sender_phone_number_id, sender_phone_number, sender_name
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, NULL, 'completed', $8, $9, $10, $11)
         RETURNING *`,
        [
          newCampaignName.slice(0, 255),
          campaign.template_name,
          newContactListId,
          campaign.media_id,
          campaign.media_type,
          campaign.media_url,
          campaign.user_id,
          senderChannelId,
          senderPhoneId,
          senderPhone,
          senderName,
        ]
      );
      const newCampaign = newCampRes.rows[0];

      const retryMessages = toRetry.map((msg) => {
        const bodyParams = [];
        if (hasBodyParam) {
          bodyParams.push({ type: "text", text: msg.name || "Customer" });
        }
        return {
          to: msg.phone_number ? String(msg.phone_number).replace(/\D/g, "") : "",
          contactId: msg.contact_id,
          bodyParams,
        };
      });

      const io = req.app.get("io");
      processCampaign(
        retryMessages,
        newCampaign.id,
        newCampaign.template_name,
        campaign.language_code || "en_US",
        io,
        newCampaign.media_id,
        newCampaign.media_type,
        newCampaign.media_url,
        senderConfig,
        senderPhoneId,
        senderPhone
      ).catch((err) => console.error("❌ Background retry campaign processing error:", err.message));

      return res.json({
        success: true,
        message: `Created new retry campaign "${newCampaign.name}" with ${toRetry.length} failed recipients.`,
        new_campaign_id: newCampaign.id,
        new_campaign: newCampaign,
        retried: toRetry.length,
      });
    }

    let successCount = 0;
    let failCount = 0;
    const io = req.app.get("io");

    for (const msg of toRetry) {
      const components = [];
      if (mediaType && (campaign.media_id || campaign.media_url)) {
        components.push({
          type: "header",
          parameters: [
            {
              type: mediaType,
              [mediaType]: campaign.media_id ? { id: campaign.media_id } : { link: campaign.media_url },
            },
          ],
        });
      }

      if (hasBodyParam) {
        components.push({
          type: "body",
          parameters: [{ type: "text", text: msg.name || "Customer" }],
        });
      }

      try {
        const sendRes = await sendTemplateMessage(
          msg.phone_number,
          campaign.template_name,
          campaign.language_code || "en_US",
          components,
          customMetaConfig
        );

        if (sendRes.success) {
          successCount++;
          await db.query(
            `UPDATE messages
             SET status = 'sent', meta_message_id = $1, error_message = NULL, timestamp = NOW()
             WHERE id = $2`,
            [sendRes.messageId || null, msg.id]
          );
        } else {
          failCount++;
          await db.query(
            `UPDATE messages
             SET status = 'failed', error_message = $1, timestamp = NOW()
             WHERE id = $2`,
            [sendRes.error || "Meta dispatch rejected", msg.id]
          );
        }

        if (io) {
          io.emit("campaign_progress", {
            campaignId: id,
            phone: msg.phone_number,
            success: sendRes.success,
            error: sendRes.error || null,
          });
        }
      } catch (err) {
        failCount++;
        await db.query(
          `UPDATE messages SET status = 'failed', error_message = $1, timestamp = NOW() WHERE id = $2`,
          [err.message || "Retry execution error", msg.id]
        );
      }
    }

    if (successCount > 0) {
      await db.query(`UPDATE campaigns SET total_sent = total_sent + $1 WHERE id = $2`, [successCount, id]);
    }

    return res.json({
      success: true,
      message: `Retried ${toRetry.length} recipients: ${successCount} successfully resent, ${failCount} failed.`,
      retried: toRetry.length,
      successful: successCount,
      failed: failCount,
    });
  } catch (err) {
    console.error("❌ Retry campaign error:", err);
    res.status(500).json({ error: "Failed to retry campaign messages." });
  }
});

/**
 * POST /api/campaigns/:id/resume
 * Resumes dispatching to remaining unsent contacts in the campaign's contact list
 */
router.post("/:id/resume", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    const campResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campResult.rows[0];

    if (!campaign.contact_list_id) {
      return res.status(400).json({ error: "Campaign does not have an associated contact list to resume." });
    }

    // Find unsent contacts
    const unsentResult = await db.query(
      `SELECT c.id, c.phone_number, c.name, c.city
       FROM contact_list_members clm
       JOIN contacts c ON clm.contact_id = c.id
       WHERE clm.list_id = $1
         AND c.id NOT IN (
           SELECT contact_id FROM messages WHERE campaign_id = $2
         )`,
      [campaign.contact_list_id, id]
    );

    const unsent = unsentResult.rows;
    if (unsent.length === 0) {
      return res.json({
        success: true,
        message: "All recipients in this list have already been sent to.",
        resumed_count: 0,
      });
    }

    const effectiveUserId = campaign.user_id || req.targetUserId || req.user?.id;

    // Check wallet balance
    if (effectiveUserId) {
      const userRes = await db.query("SELECT wallet_balance FROM public.users WHERE id = $1", [effectiveUserId]);
      const balance = parseFloat(userRes.rows[0]?.wallet_balance || 0);
      const marketingRate = RATES.marketing || 1.08;
      const requiredCost = Math.round(unsent.length * marketingRate * 100) / 100;

      if (balance < requiredCost) {
        return res.status(402).json({
          error: `Insufficient wallet balance. Resuming requires ₹${requiredCost.toFixed(2)} for ${unsent.length} remaining recipients, but available balance is ₹${balance.toFixed(2)}.`,
          required: requiredCost,
          balance,
        });
      }
    }

    // Resolve Sender Channel
    let senderConfig = null;
    let senderPhoneId = campaign.sender_phone_number_id || null;
    let senderPhone = campaign.sender_phone_number || null;

    if (campaign.sender_channel_id) {
      const chanRes = await db.query(
        `SELECT id, phone_number_id, access_token, waba_id, display_phone_number, verified_name
         FROM public.user_whatsapp_channels WHERE id = $1`,
        [campaign.sender_channel_id]
      );
      if (chanRes.rows.length > 0) {
        const chan = chanRes.rows[0];
        senderPhoneId = chan.phone_number_id;
        senderPhone = chan.display_phone_number || chan.phone_number_id;
        senderConfig = {
          channelId: chan.id,
          phoneId: chan.phone_number_id.trim(),
          token: chan.access_token.trim(),
          wabaId: chan.waba_id ? chan.waba_id.trim() : null,
          displayPhone: chan.display_phone_number,
          verifiedName: chan.verified_name,
        };
      }
    }

    if (!senderConfig) {
      senderConfig = await getUserMetaConfig(req, campaign.sender_channel_id);
    }

    const messages = unsent.map((member) => ({
      to: member.phone_number ? String(member.phone_number).replace(/\D/g, "") : "",
      contactId: member.id,
      bodyParams: [],
    }));

    const io = req.app.get("io");
    resumeCampaignState(campaign.id);
    processCampaign(
      messages,
      campaign.id,
      campaign.template_name,
      campaign.language_code || "hi",
      io,
      campaign.media_id,
      campaign.media_type,
      campaign.media_url,
      senderConfig,
      senderPhoneId,
      senderPhone
    ).catch((err) => console.error("❌ Background resume campaign processing error:", err.message));

    return res.json({
      success: true,
      message: `Resumed campaign "${campaign.name}" for ${unsent.length} remaining recipients.`,
      resumed_count: unsent.length,
    });
  } catch (err) {
    console.error("❌ Resume campaign error:", err);
    res.status(500).json({ error: "Failed to resume campaign." });
  }
});

/**
 * POST /api/campaigns/:id/pause
 * Pauses an actively dispatching campaign
 */
router.post("/:id/pause", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    pauseCampaign(id);
    await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [id]);

    const io = req.app.get("io");
    if (io) {
      io.emit("campaign_status_changed", { campaignId: id, status: "paused" });
    }

    return res.json({
      success: true,
      message: "Campaign paused successfully.",
    });
  } catch (err) {
    console.error("❌ Pause campaign error:", err);
    res.status(500).json({ error: "Failed to pause campaign." });
  }
});

/**
 * GET /api/campaigns/:id/export
 * Export all campaign recipient delivery analytics to Excel (.xlsx)
 * Strictly restricted to Admin & Master Admin
 */
router.get("/:id/export", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid campaign ID format." });
    }

    // Role verification (Admin / Master Admin ONLY)
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : req.query.token;

    let user = null;
    if (token) {
      try {
        user = jwt.verify(token, JWT_SECRET);
      } catch (e) {}
    }

    const isMaster = user && (user.role === "master_admin" || user.username?.toLowerCase() === "piyushassudani");
    const isAdmin = user && (isMaster || user.role === "admin");

    if (!isAdmin) {
      return res.status(403).json({ error: "Access denied. Only Administrators can export campaign data to Excel." });
    }

    const campResult = await db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (campResult.rows.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = campResult.rows[0];

    const result = await db.query(
      `SELECT m.id, c.name, c.phone_number, m.status, m.error_message, m.timestamp,
              COALESCE(m.sender_phone_number, campaign_sender.sender_phone_number, 'Default') as sender_phone_number,
              COALESCE(m.sender_phone_number_id, campaign_sender.sender_phone_number_id, '') as sender_phone_number_id
       FROM messages m
       JOIN contacts c ON m.contact_id = c.id
       LEFT JOIN (SELECT id, sender_phone_number, sender_phone_number_id FROM campaigns WHERE id = $1) campaign_sender ON true
       WHERE m.campaign_id = $1
       ORDER BY m.timestamp DESC`,
      [id]
    );

    const rows = result.rows.map((r, index) => {
      let derivedStatus = r.status ? r.status.toUpperCase() : "PENDING";
      let failureCategory = "N/A";
      const err = (r.error_message || "").toLowerCase();

      if (r.status === "failed") {
        if (err.includes("undeliverable") || err.includes("not on whatsapp")) {
          derivedStatus = "NOT ON WHATSAPP";
          failureCategory = "Invalid / Non-WhatsApp Number (131026)";
        } else if (err.includes("ecosystem") || err.includes("spam") || err.includes("re-engagement")) {
          derivedStatus = "SPAM / BLOCKED";
          failureCategory = "Meta Ecosystem / Spam Rate Limit (131047)";
        } else if (err.includes("rate limit") || err.includes("throughput")) {
          derivedStatus = "RATE LIMIT";
          failureCategory = "Cloud API Rate Limit / Tier Threshold (130429)";
        } else {
          derivedStatus = "FAILED";
          failureCategory = "Meta Dispatch Rejection";
        }
      }

      return {
        "S.No": index + 1,
        "Campaign Name": campaign.name,
        "Template Name": campaign.template_name,
        "Sender Number": r.sender_phone_number,
        "Sender Phone ID": r.sender_phone_number_id,
        "Recipient Name": r.name || "N/A",
        "Phone Number": `+${r.phone_number}`,
        "Delivery Status": derivedStatus,
        "Error Category": failureCategory,
        "Detailed Error Message": r.error_message || "",
        "Last Status Timestamp": r.timestamp ? new Date(r.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "N/A",
      };
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows);

    // Auto-fit column widths
    const colWidths = [
      { wch: 6 },  // S.No
      { wch: 22 }, // Campaign Name
      { wch: 20 }, // Template Name
      { wch: 20 }, // Sender Number
      { wch: 20 }, // Sender Phone ID
      { wch: 22 }, // Recipient Name
      { wch: 18 }, // Phone Number
      { wch: 18 }, // Delivery Status
      { wch: 30 }, // Error Category
      { wch: 45 }, // Detailed Error Message
      { wch: 24 }, // Last Status Timestamp
    ];
    ws["!cols"] = colWidths;

    xlsx.utils.book_append_sheet(wb, ws, "Campaign Analytics");

    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    const safeName = campaign.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeName}_analytics_${Date.now()}.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buffer);
  } catch (err) {
    console.error("❌ Export campaign error:", err);
    res.status(500).json({ error: "Failed to export campaign report to Excel." });
  }
});

module.exports = router;
