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
  const effectiveUserId = req.targetUserId || req.user?.id;
  const targetChannelId = req.query.channel_id || req.headers["x-channel-id"];

  try {
    // 1. Fetch all configured channels for this user/tenant
    let userChannels = [];
    let clientTplsMap = new Map();
    if (effectiveUserId) {
      const userChannelsRes = await db.query(
        `SELECT id, channel_name, phone_number_id, waba_id, access_token, display_phone_number, verified_name, is_default
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

    // Determine configs to query from Meta
    let configsToQuery = [];
    if (targetChannelId && targetChannelId !== "company") {
      const specificChan = userChannels.find((c) => c.id === targetChannelId);
      if (specificChan) {
        configsToQuery.push({
          channelId: specificChan.id,
          phoneId: specificChan.phone_number_id,
          token: specificChan.access_token,
          wabaId: specificChan.waba_id,
          displayPhone: specificChan.display_phone_number,
          verifiedName: specificChan.verified_name,
        });
      }
    } else if (userChannels.length > 0) {
      const seenWabas = new Set();
      for (const ch of userChannels) {
        if (ch.waba_id && ch.access_token && !seenWabas.has(ch.waba_id)) {
          seenWabas.add(ch.waba_id);
          configsToQuery.push({
            channelId: ch.id,
            phoneId: ch.phone_number_id,
            token: ch.access_token,
            wabaId: ch.waba_id,
            displayPhone: ch.display_phone_number,
            verifiedName: ch.verified_name,
          });
        }
      }
    }

    if (configsToQuery.length === 0) {
      const fallbackConfig = await getUserMetaConfig(req);
      if (fallbackConfig) configsToQuery.push(fallbackConfig);
    }

    // 2. Query Meta API for templates across all tenant WABAs
    const rawTemplatesMap = new Map();
    for (const conf of configsToQuery) {
      const cacheKey = conf.wabaId || "company_default";
      const cached = templateCacheMap.get(cacheKey);
      let tpls;
      if (!forceRefresh && cached && now - cached.time < TEMPLATE_CACHE_TTL) {
        tpls = cached.data;
      } else {
        try {
          tpls = await getTemplates(conf);
          templateCacheMap.set(cacheKey, { data: tpls, time: now });
        } catch (err) {
          console.warn(`Could not fetch templates for WABA ${conf.wabaId}:`, err.message);
          tpls = [];
        }
      }

      for (const t of (tpls || [])) {
        const key = `${t.name}_${t.language || "en_US"}`.toLowerCase();
        const existing = rawTemplatesMap.get(key);
        if (!existing) {
          rawTemplatesMap.set(key, { ...t, _wabas: [conf.wabaId], _sourceConf: conf });
        } else {
          if (!existing._wabas.includes(conf.wabaId)) {
            existing._wabas.push(conf.wabaId);
          }
          // If approved on ANY WABA, elevate status to APPROVED immediately!
          if (t.status === "APPROVED" || t.status === "ACTIVE") {
            existing.status = "APPROVED";
            existing.id = t.id || existing.id;
            existing.components = t.components || existing.components;
            existing._sourceConf = conf;
          }
        }
      }
    }

    const mergedTemplates = Array.from(rawTemplatesMap.values());

    // 3. Enrich templates with usable_on channels and creator info
    const enrichedTemplates = mergedTemplates.map((t) => {
      const tName = (t.name || "").toLowerCase();
      const dbRecord = clientTplsMap.get(tName);

      // Usable channels are channels whose waba_id is in t._wabas
      const usableChannels = userChannels
        .filter((c) => t._wabas && t._wabas.includes(c.waba_id))
        .map((c) => ({
          phone_number: c.display_phone_number || c.phone_number_id,
          name: c.verified_name || c.channel_name,
          phone_id: c.phone_number_id,
          is_default: c.is_default,
          channel_id: c.id,
        }));

      const fallbackUsable = userChannels.length > 0
        ? userChannels.map((c) => ({
            phone_number: c.display_phone_number || c.phone_number_id,
            name: c.verified_name || c.channel_name,
            phone_id: c.phone_number_id,
            is_default: c.is_default,
            channel_id: c.id,
          }))
        : [
            {
              phone_number: t._sourceConf?.displayPhone || "Primary Sender",
              name: t._sourceConf?.verifiedName || "Personal WhatsApp",
              phone_id: t._sourceConf?.phoneId,
              is_default: true,
            },
          ];

      const createdForNumber =
        dbRecord?.display_phone_number ||
        t._sourceConf?.displayPhone ||
        userChannels[0]?.display_phone_number ||
        "WhatsApp Business";
      const createdForName =
        dbRecord?.channel_name ||
        t._sourceConf?.verifiedName ||
        userChannels[0]?.verified_name ||
        "WhatsApp Business";

      return {
        ...t,
        status: (t.status === "ACTIVE" || t.status === "APPROVED") ? "APPROVED" : t.status,
        waba_id: dbRecord?.waba_id || t._wabas?.[0] || null,
        created_for: {
          phone_number: createdForNumber,
          name: createdForName,
          phone_id: dbRecord?.phone_number_id || t._sourceConf?.phoneId || null,
        },
        usable_on: usableChannels.length > 0 ? usableChannels : fallbackUsable,
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
