const express = require("express");
const router = express.Router();
const fs = require("fs");
const db = require("../db");
const { sendTextMessage, sendTemplateMessage, sendMediaMessage, sendMediaById, uploadMediaToMeta } = require("../services/metaApi");
const { uploadFileToCloudinary } = require("../services/cloudinaryService");
const multer = require("multer");
const os = require("os");

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

const isImageUrl = (url) => {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  if (/\s/.test(trimmed)) return false;
  return (
    /\.(jpg|jpeg|png|webp|gif|svg|bmp|ico|tiff|heic)(\?.*)?$/i.test(trimmed) ||
    /googleusercontent\.com|encrypted-tbn[0-9]\.gstatic\.com\/images|images\.unsplash\.com|cdn\.pixabay\.com|res\.cloudinary\.com|lookaside\.fbsbx\.com|mmg\.whatsapp\.net/i.test(trimmed) ||
    /[?&]q=tbn:|[?&]mime=image|[?&]format=(jpg|jpeg|png|webp)/i.test(trimmed)
  );
};

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB file limit
});

/**
 * GET /api/messages/inbound
 * Fetch recent inbound messages across all contacts
 */
router.get("/inbound", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*, c.phone_number, c.name
       FROM messages m
       JOIN contacts c ON m.contact_id = c.id
       WHERE m.direction = 'inbound'
       ORDER BY m.timestamp DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Get inbound messages error:", err);
    res.status(500).json({ error: "Failed to retrieve inbound messages." });
  }
});

/**
 * GET /api/messages/:contactId
 * Fetch paginated messages for a specific contact
 */
router.get("/:contactId", async (req, res) => {
  try {
    const { contactId } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    if (!isValidUuid(contactId)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
    const safeOffset = Math.max(parseInt(offset) || 0, 0);

    const messagesResult = await db.query(
      `SELECT m.*, COALESCE(m.media_url, c.media_url) AS media_url
       FROM messages m
       LEFT JOIN campaigns c ON m.campaign_id = c.id
       WHERE m.contact_id = $1
       ORDER BY m.timestamp ASC NULLS FIRST, m.id ASC
       LIMIT $2 OFFSET $3`,
      [contactId, safeLimit, safeOffset]
    );

    const lastInbound = await db.query(
      `SELECT timestamp FROM messages
       WHERE contact_id = $1 AND direction = 'inbound' AND timestamp IS NOT NULL
       ORDER BY timestamp DESC NULLS LAST
       LIMIT 1`,
      [contactId]
    );

    const lastInboundAt = lastInbound.rows[0]?.timestamp || null;
    const windowOpen = lastInboundAt
      ? Date.now() - new Date(lastInboundAt).getTime() < 24 * 60 * 60 * 1000
      : false;

    const publicBaseUrl = (process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    const normalizedMessages = messagesResult.rows.map(m => ({
      ...m,
      media_url: (publicBaseUrl && m.media_url) ? m.media_url.replace(/http:\/\/localhost:\d+/g, publicBaseUrl) : m.media_url,
    }));

    res.json({
      contact: contactResult.rows[0],
      messages: normalizedMessages,
      window: {
        open: windowOpen,
        last_inbound_at: lastInboundAt,
        expires_at: lastInboundAt
          ? new Date(new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000)
          : null,
      },
    });
  } catch (err) {
    console.error("❌ Get messages error:", err);
    res.status(500).json({ error: "Failed to fetch conversation messages." });
  }
});

/**
 * PUT /api/messages/:contactId/read
 * Mark messages as read for a contact
 */
router.put("/:contactId/read", async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!isValidUuid(contactId)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    const result = await db.query(
      `UPDATE messages 
       SET status = 'read' 
       WHERE contact_id = $1 AND direction = 'inbound' AND status != 'read'
       RETURNING id`,
      [contactId]
    );

    res.json({ success: true, updated_count: result.rowCount });
  } catch (err) {
    console.error("❌ Mark as read error:", err);
    res.status(500).json({ error: "Failed to mark messages as read." });
  }
});

/**
 * POST /api/messages/:contactId
 * Send text message within the 24h window
 */
router.post("/:contactId", async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!isValidUuid(contactId)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    let { message } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message text cannot be empty." });
    }

    message = message.trim();
    if (message.length > 4096) {
      return res.status(400).json({ error: "Message exceeds WhatsApp 4096 character limit." });
    }

    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }
    const contact = contactResult.rows[0];

    // Check 24-hour service window
    const lastInbound = await db.query(
      `SELECT timestamp FROM messages
       WHERE contact_id = $1 AND direction = 'inbound' AND timestamp IS NOT NULL
       ORDER BY timestamp DESC NULLS LAST
       LIMIT 1`,
      [contactId]
    );

    if (!lastInbound.rows[0]) {
      return res.status(403).json({
        error: "No inbound messages from this contact. Send an approved template to start the conversation.",
        window_closed: true,
      });
    }

    const lastInboundTime = new Date(lastInbound.rows[0].timestamp);
    const hoursSinceLastInbound = (Date.now() - lastInboundTime.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastInbound >= 24) {
      return res.status(403).json({
        error: "24-hour window closed. Send a template message to restart the conversation.",
        window_closed: true,
        last_inbound_at: lastInbound.rows[0].timestamp,
        hours_ago: Math.round(hoursSinceLastInbound),
      });
    }

    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    const isImage = isImageUrl(trimmedMessage);

    let result;
    if (isImage) {
      result = await sendMediaMessage(contact.phone_number, trimmedMessage, "image");
    } else {
      result = await sendTextMessage(contact.phone_number, message);
    }

    if (!result.success) {
      return res.status(502).json({
        error: "Failed to send message via Meta API",
        details: result.error,
      });
    }

    const displayBody = isImage ? "[Image]" : message;
    const mediaUrl = isImage ? trimmedMessage : null;

    const msgResult = await db.query(
      `INSERT INTO messages (contact_id, direction, message_body, media_url, meta_message_id, status, timestamp)
       VALUES ($1, 'outbound', $2, $3, $4, 'sent', NOW())
       RETURNING *`,
      [contactId, displayBody, mediaUrl, result.messageId]
    );

    const savedMessage = msgResult.rows[0];

    const io = req.app.get("io");
    if (io) {
      io.emit("new_message", {
        id: savedMessage.id,
        contact_id: contactId,
        contact_phone: contact.phone_number,
        contact_name: contact.name,
        direction: "outbound",
        message_body: displayBody,
        media_url: mediaUrl,
        meta_message_id: result.messageId,
        status: "sent",
        timestamp: savedMessage.timestamp,
      });
    }

    res.status(201).json(savedMessage);
  } catch (err) {
    console.error("❌ Send message error:", err);
    res.status(500).json({ error: "Failed to send message." });
  }
});

/**
 * POST /api/messages/:contactId/template
 * Send approved Meta template to contact (works outside 24h window)
 */
router.post("/:contactId/template", async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!isValidUuid(contactId)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    const { template_name, language_code = "en_US", components = [] } = req.body || {};

    if (!template_name || typeof template_name !== "string" || !template_name.trim()) {
      return res.status(400).json({ error: "template_name is required" });
    }

    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }
    const contact = contactResult.rows[0];

    const result = await sendTemplateMessage(
      contact.phone_number,
      template_name.trim(),
      language_code,
      Array.isArray(components) ? components : []
    );

    if (!result.success) {
      return res.status(502).json({
        error: "Failed to send template via Meta API",
        details: result.error,
      });
    }

    let templateMediaUrl = null;
    if (Array.isArray(components)) {
      const headerComp = components.find((c) => c?.type?.toLowerCase() === "header");
      const mediaParam = headerComp?.parameters?.find((p) =>
        ["image", "video", "document"].includes(p?.type?.toLowerCase())
      );
      if (mediaParam) {
        const typeKey = mediaParam.type.toLowerCase();
        templateMediaUrl = mediaParam[typeKey]?.link || null;
      }
    }

    const msgResult = await db.query(
      `INSERT INTO messages (contact_id, direction, message_body, media_url, meta_message_id, status, timestamp)
       VALUES ($1, 'outbound', $2, $3, $4, 'sent', NOW())
       RETURNING *`,
      [contactId, `[Template: ${template_name.trim()}]`, templateMediaUrl, result.messageId]
    );

    const savedMessage = msgResult.rows[0];

    const io = req.app.get("io");
    if (io) {
      io.emit("new_message", {
        id: savedMessage.id,
        contact_id: contactId,
        contact_phone: contact.phone_number,
        contact_name: contact.name,
        direction: "outbound",
        message_body: `[Template: ${template_name.trim()}]`,
        media_url: templateMediaUrl,
        meta_message_id: result.messageId,
        status: "sent",
        timestamp: savedMessage.timestamp,
      });
    }

    res.status(201).json(savedMessage);
  } catch (err) {
    console.error("❌ Send template error:", err);
    res.status(500).json({ error: "Failed to dispatch template message." });
  }
});

/**
 * POST /api/messages/:contactId/media
 * Send outbound media file to contact
 */
router.post("/:contactId/media", upload.single("file"), async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!isValidUuid(contactId)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const contactResult = await db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }
    const contact = contactResult.rows[0];

    // Check 24 hour window
    const lastInbound = await db.query(
      `SELECT timestamp FROM messages
       WHERE contact_id = $1 AND direction = 'inbound' AND timestamp IS NOT NULL
       ORDER BY timestamp DESC NULLS LAST LIMIT 1`,
      [contactId]
    );

    if (!lastInbound.rows[0]) {
      return res.status(403).json({ error: "No inbound messages from this contact.", window_closed: true });
    }

    const hoursSinceLastInbound = (Date.now() - new Date(lastInbound.rows[0].timestamp).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastInbound >= 24) {
      return res.status(403).json({ error: "24-hour window closed.", window_closed: true });
    }

    // Determine type
    let resourceType = "auto";
    let metaType = "image";
    let displayBody = "[Image]";

    if (req.file.mimetype.startsWith("image/")) {
      resourceType = "image";
      metaType = "image";
      displayBody = "[Image]";
    } else if (req.file.mimetype.startsWith("video/")) {
      resourceType = "video";
      metaType = "video";
      displayBody = "[Video]";
    } else if (req.file.mimetype.startsWith("audio/")) {
      resourceType = "video";
      metaType = "audio";
      displayBody = "[Audio]";
    } else {
      resourceType = "raw";
      metaType = "document";
      displayBody = "[Document]";
    }

    // 1. Upload to Meta first directly using temp stream
    let metaMediaId = null;
    try {
      metaMediaId = await uploadMediaToMeta(req.file.path, req.file.mimetype);
    } catch (metaErr) {
      console.warn("⚠️ Meta pre-upload failed, will fallback to URL:", metaErr.message);
    }

    // 2. Upload to local server / storage
    const mediaUrl = await uploadFileToCloudinary(req.file.path, "wp_automation/direct", resourceType);

    // 3. Clean up temp multer file
    fs.promises.unlink(req.file.path).catch(() => {});

    // 4. Send via Meta API (prefer Meta Media ID for reliability, fallback to public mediaUrl)
    let result;
    if (metaMediaId) {
      result = await sendMediaById(contact.phone_number, metaMediaId, metaType);
    } else {
      result = await sendMediaMessage(contact.phone_number, mediaUrl, metaType);
    }

    if (!result.success) {
      return res.status(502).json({ error: "Failed to send media via Meta API", details: result.error });
    }

    // Save to database
    const msgResult = await db.query(
      `INSERT INTO messages (contact_id, direction, message_body, media_url, meta_message_id, status, timestamp)
       VALUES ($1, 'outbound', $2, $3, $4, 'sent', NOW()) RETURNING *`,
      [contactId, displayBody, mediaUrl, result.messageId]
    );

    const savedMessage = msgResult.rows[0];

    // Emit via Socket with correct UUID string contactId
    const io = req.app.get("io");
    if (io) {
      io.emit("new_message", {
        id: savedMessage.id,
        contact_id: contactId,
        contact_phone: contact.phone_number,
        contact_name: contact.name,
        direction: "outbound",
        message_body: displayBody,
        media_url: mediaUrl,
        meta_message_id: result.messageId,
        status: "sent",
        timestamp: savedMessage.timestamp,
      });
    }

    res.status(201).json(savedMessage);
  } catch (err) {
    console.error("❌ Send media error:", err);
    res.status(500).json({ error: "Failed to process and send media file." });
  }
});

/**
 * DELETE /api/messages/:messageId
 * Delete a message
 */
router.delete("/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!isValidUuid(messageId)) {
      return res.status(400).json({ error: "Invalid message ID format." });
    }

    const result = await db.query("DELETE FROM messages WHERE id = $1 RETURNING id", [messageId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Message not found" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("message_deleted", { id: result.rows[0].id });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error("❌ Delete message error:", err);
    res.status(500).json({ error: "Failed to delete message." });
  }
});

module.exports = router;
