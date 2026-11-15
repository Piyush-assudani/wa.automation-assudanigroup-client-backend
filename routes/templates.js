const express = require("express");
const router = express.Router();
const multer = require("multer");
const os = require("os");
const fs = require("fs");
const db = require("../db");
const { getTemplates, createTemplate, deleteTemplate } = require("../services/metaApi");
const { getUserMetaConfig, authenticate } = require("../middleware/authMiddleware");
const { validateTemplatePolicy } = require("../services/metaPolicyGuard");

// Enforce JWT authentication on all template operations
router.use(authenticate);

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// Cache map per tenant WABA to prevent cross-account template leaks
const templateCacheMap = new Map();
const TEMPLATE_CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * GET /api/templates
 * Fetches approved/pending Meta message templates with tenant-scoped caching
 */
router.get("/", async (req, res) => {
  const forceRefresh = req.query.refresh === "true";
  const now = Date.now();

  try {
    const customConfig = await getUserMetaConfig(req);
    const cacheKey = customConfig?.wabaId || "company_default";
    const cached = templateCacheMap.get(cacheKey);

    let templates;
    if (!forceRefresh && cached && now - cached.time < TEMPLATE_CACHE_TTL) {
      templates = cached.data;
    } else {
      templates = await getTemplates(customConfig);
      templateCacheMap.set(cacheKey, { data: templates, time: now });
    }

    // Filter templates for company mode if not personal WABA
    const effectiveUserId = req.targetUserId || req.user?.id;
    let resultTemplates = templates;

    if (!(customConfig && customConfig.wabaId)) {
      const isMaster = req.user?.role === "master_admin" || (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
      const isClientView = Boolean(req.headers["x-client-id"]) || !isMaster;
      if (isClientView && effectiveUserId) {
        const clientTemplatesRes = await db.query(
          "SELECT template_name FROM public.client_templates WHERE user_id = $1",
          [effectiveUserId]
        );
        const allowedNames = new Set(clientTemplatesRes.rows.map((r) => r.template_name.toLowerCase()));
        resultTemplates = templates.filter((t) => allowedNames.has(t.name.toLowerCase()));
      }
    }

    // Query tenant channels & client_templates metadata to determine:
    // 1) Which mobile number it was created for
    // 2) Which mobile numbers can use this template
    let userChannels = [];
    let clientTplsMap = new Map();
    if (effectiveUserId) {
      const userChannelsRes = await db.query(
        `SELECT id, channel_name, phone_number_id, waba_id, display_phone_number, verified_name, is_default
         FROM public.user_whatsapp_channels
         WHERE user_id = $1 OR user_id IN (SELECT parent_client_id FROM public.users WHERE id = $1)
         ORDER BY is_default DESC, created_at ASC`,
        [effectiveUserId]
      ).catch(() => ({ rows: [] }));
      userChannels = userChannelsRes.rows || [];

      const clientTplsRes = await db.query(
        `SELECT template_name, meta_template_id, phone_number_id, display_phone_number, channel_name, waba_id
         FROM public.client_templates
         WHERE user_id = $1`,
        [effectiveUserId]
      ).catch(() => ({ rows: [] }));
      for (const ct of (clientTplsRes.rows || [])) {
        if (ct.template_name) {
          clientTplsMap.set(ct.template_name.toLowerCase(), ct);
        }
      }
    }

    const targetWaba = customConfig?.wabaId;
    const matchingChannels = userChannels.filter(c => !targetWaba || !c.waba_id || c.waba_id === targetWaba);
    const defaultUsableNumbers = matchingChannels.length > 0
      ? matchingChannels.map(c => ({
          phone_number: c.display_phone_number || c.phone_number_id,
          name: c.verified_name || c.channel_name,
          phone_id: c.phone_number_id,
          is_default: c.is_default,
        }))
      : [
          {
            phone_number: customConfig?.displayPhone || "Primary Sender",
            name: customConfig?.verifiedName || "Personal WhatsApp",
            phone_id: customConfig?.phoneId,
            is_default: true,
          },
        ];

    const enrichedTemplates = resultTemplates.map((t) => {
      const tName = (t.name || "").toLowerCase();
      const dbRecord = clientTplsMap.get(tName);

      const createdForNumber = dbRecord?.display_phone_number || customConfig?.displayPhone || userChannels[0]?.display_phone_number || "Default Sender";
      const createdForName = dbRecord?.channel_name || customConfig?.verifiedName || userChannels[0]?.verified_name || "WhatsApp Business";

      return {
        ...t,
        waba_id: targetWaba || dbRecord?.waba_id || null,
        created_for: {
          phone_number: createdForNumber,
          name: createdForName,
          phone_id: dbRecord?.phone_number_id || customConfig?.phoneId || null,
        },
        usable_on: defaultUsableNumbers,
      };
    });

    res.json(enrichedTemplates);
  } catch (err) {
    console.error("❌ Fetch templates error:", err.message);
    const customConfig = await getUserMetaConfig(req).catch(() => null);
    const cacheKey = customConfig?.wabaId || "company_default";
    const cached = templateCacheMap.get(cacheKey);
    if (cached) {
      return res.json(cached.data);
    }
    res.status(500).json({ error: err.message || "Failed to fetch templates from Meta Cloud." });
  }
});

/**
 * POST /api/templates
 * Submit a new message template to Meta for review
 */
router.post("/", upload.single("sampleFile"), async (req, res) => {
  try {
    const { name, language, category, text, headerType, headerText, footerText, buttons, sampleUrl, sender_channel_id } = req.body || {};

    if (!name || !language || !category || !text) {
      return res.status(400).json({ error: "Missing required fields: name, language, category, text." });
    }

    const cleanName = String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const cleanText = String(text).trim();

    if (!cleanName) {
      return res.status(400).json({ error: "Invalid template name format." });
    }

    let parsedButtons = buttons;
    if (typeof buttons === "string") {
      try {
        parsedButtons = JSON.parse(buttons);
      } catch (e) {
        parsedButtons = [];
      }
    }

    // META POLICY COMPLIANCE GUARD
    // Proactively blocks illegal betting, adult content, narcotics, and get-rich-quick scams
    const policyCheck = validateTemplatePolicy({
      headerText,
      bodyText: cleanText,
      footerText,
      buttons: parsedButtons,
    });

    if (!policyCheck.compliant) {
      if (req.file) {
        fs.promises.unlink(req.file.path).catch(() => {});
      }
      return res.status(400).json({
        error: policyCheck.error,
        category: policyCheck.category,
      });
    }

    const customConfig = await getUserMetaConfig(req, sender_channel_id);
    const result = await createTemplate(
      cleanName,
      language,
      category,
      cleanText,
      headerType,
      headerText,
      footerText,
      parsedButtons,
      req.file,
      sampleUrl,
      customConfig
    );

    // Save client template association with exact sender mobile & WABA details
    const effectiveUserId = req.targetUserId || req.user?.id;
    if (effectiveUserId) {
      await db.query(
        `INSERT INTO public.client_templates (user_id, template_name, meta_template_id, language, category, phone_number_id, display_phone_number, channel_name, waba_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, template_name) DO UPDATE SET
           meta_template_id = EXCLUDED.meta_template_id,
           category = EXCLUDED.category,
           phone_number_id = EXCLUDED.phone_number_id,
           display_phone_number = EXCLUDED.display_phone_number,
           channel_name = EXCLUDED.channel_name,
           waba_id = EXCLUDED.waba_id`,
        [
          effectiveUserId,
          cleanName,
          result?.id || null,
          language,
          category,
          customConfig?.phoneId || null,
          customConfig?.displayPhone || null,
          customConfig?.verifiedName || null,
          customConfig?.wabaId || null,
        ]
      ).catch((e) => console.warn("Notice: could not save client template relation:", e.message));
    }

    if (req.file) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }

    // Invalidate template cache so subsequent requests get fresh data
    const cacheKey = customConfig?.wabaId || "company_default";
    templateCacheMap.delete(cacheKey);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (req.file) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
    console.error("❌ Create template error:", err.message);
    res.status(500).json({ error: err.message || "Failed to create template on Meta Cloud." });
  }
});

/**
 * DELETE /api/templates/:name
 * Delete template permanently from Meta Cloud API and local database mapping
 */
router.delete("/:name", async (req, res) => {
  const { name } = req.params;
  const hsmId = req.query.hsm_id || req.body?.hsm_id || null;
  const senderChannelId = req.query.channel_id || req.body?.sender_channel_id || null;
  const effectiveUserId = req.targetUserId || req.user?.id;

  try {
    const customConfig = await getUserMetaConfig(req, senderChannelId).catch(() => null);

    // 1. Delete template from Meta WhatsApp Cloud API
    let metaResult = null;
    try {
      metaResult = await deleteTemplate(name, hsmId, customConfig);
    } catch (metaErr) {
      console.warn("⚠️ Meta template deletion error/warning:", metaErr.message);
      // If error is not a 404/not_found, throw error to inform user
      if (!metaErr.message?.toLowerCase().includes("not found")) {
        return res.status(400).json({ error: metaErr.message });
      }
    }

    // 2. Remove client template mapping from PostgreSQL
    if (effectiveUserId) {
      await db.query(
        `DELETE FROM public.client_templates 
         WHERE (user_id = $1 OR user_id IN (SELECT id FROM public.users WHERE parent_client_id = $1)) 
           AND LOWER(template_name) = LOWER($2)`,
        [effectiveUserId, name]
      );
    }

    // 3. Clear cache
    const cacheKey = customConfig?.wabaId || "company_default";
    templateCacheMap.delete(cacheKey);

    res.json({
      success: true,
      message: `Template "${name}" has been permanently deleted from Meta Cloud and your account.`,
      meta: metaResult,
    });
  } catch (err) {
    console.error("❌ Delete template error:", err);
    res.status(500).json({ error: err.message || "Failed to delete template." });
  }
});

module.exports = router;
