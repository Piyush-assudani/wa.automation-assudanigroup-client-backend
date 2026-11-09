const express = require("express");
const router = express.Router();
const multer = require("multer");
const os = require("os");
const fs = require("fs");
const db = require("../db");
const { getTemplates, createTemplate } = require("../services/metaApi");
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

    // If tenant has configured their own personal Meta WABA, all templates belong to them
    if (customConfig && customConfig.wabaId) {
      return res.json(templates);
    }

    // STRICT CLIENT TEMPLATE ISOLATION FOR COMPANY WABA MODE
    // If client user (or Master Admin viewing a specific client), ONLY return templates owned by this client!
    const effectiveUserId = req.targetUserId || req.user?.id;
    const isMaster = req.user?.role === "master_admin" || (req.user?.username && req.user.username.toLowerCase() === "piyushassudani");
    const isClientView = Boolean(req.headers["x-client-id"]) || !isMaster;

    if (isClientView && effectiveUserId) {
      const clientTemplatesRes = await db.query(
        "SELECT template_name FROM public.client_templates WHERE user_id = $1",
        [effectiveUserId]
      );
      const allowedNames = new Set(clientTemplatesRes.rows.map((r) => r.template_name.toLowerCase()));
      const clientTemplates = templates.filter((t) => allowedNames.has(t.name.toLowerCase()));
      return res.json(clientTemplates);
    }

    res.json(templates);
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
    const { name, language, category, text, headerType, headerText, footerText, buttons, sampleUrl } = req.body || {};

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

    const customConfig = await getUserMetaConfig(req);
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

    // Save client template association
    const effectiveUserId = req.targetUserId || req.user?.id;
    if (effectiveUserId) {
      await db.query(
        `INSERT INTO public.client_templates (user_id, template_name, meta_template_id, language, category)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, template_name) DO UPDATE SET
           meta_template_id = EXCLUDED.meta_template_id,
           category = EXCLUDED.category`,
        [effectiveUserId, cleanName, result?.id || null, language, category]
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
 * Delete template mapping and remove from client templates
 */
router.delete("/:name", async (req, res) => {
  const { name } = req.params;
  const effectiveUserId = req.targetUserId || req.user?.id;

  try {
    if (effectiveUserId) {
      await db.query(
        "DELETE FROM public.client_templates WHERE user_id = $1 AND LOWER(template_name) = LOWER($2)",
        [effectiveUserId, name]
      );
    }

    const customConfig = await getUserMetaConfig(req).catch(() => null);
    const cacheKey = customConfig?.wabaId || "company_default";
    templateCacheMap.delete(cacheKey);

    res.json({ success: true, message: `Template "${name}" removed.` });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(500).json({ error: "Failed to delete template." });
  }
});

module.exports = router;
