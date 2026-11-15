const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "enterprise_wp_automation_jwt_secret_2026";

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

// Lightweight TTL cache for RBAC role permissions (minimizes DB reads under load)
const rolePermsCache = new Map();
const ROLE_PERMS_TTL = 60 * 1000;

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Token missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // SaaS Multi-tenant client switching strictly for Master Admin ONLY
    const isMaster = req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"];

    if (targetClientId && isMaster && isValidUuid(targetClientId)) {
      req.targetUserId = targetClientId;
    } else if (req.user.parent_client_id && isValidUuid(req.user.parent_client_id)) {
      // Sub-user/team member operates strictly within their parent client's workspace
      req.targetUserId = req.user.parent_client_id;
    } else {
      req.targetUserId = req.user.id;
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

/**
 * RBAC Permission Middleware: verifies that the authenticated user's role
 * holds the required permission in roles/permissions/role_permissions.
 */
const requirePermission = (permissionName) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }
    const roleName = (req.user.role || "client").toLowerCase();
    if (roleName === "master_admin" || roleName === "owner" || req.user.username?.toLowerCase() === "piyushassudani") {
      return next();
    }

    const now = Date.now();
    let permsSet = null;
    const cached = rolePermsCache.get(roleName);
    if (cached && now - cached.time < ROLE_PERMS_TTL) {
      permsSet = cached.perms;
    } else {
      const db = require("../db");
      const result = await db.query(
        `SELECT p.name
         FROM public.role_permissions rp
         JOIN public.roles r ON rp.role_id = r.id
         JOIN public.permissions p ON rp.permission_id = p.id
         WHERE LOWER(r.name) = $1`,
        [roleName]
      );
      permsSet = new Set(result.rows.map((row) => row.name));
      rolePermsCache.set(roleName, { perms: permsSet, time: now });
    }

    if (!permsSet.has(permissionName)) {
      return res.status(403).json({
        error: `Access denied. Missing required permission: ${permissionName}`,
      });
    }
    next();
  } catch (err) {
    // Fail-closed if permission check errors unexpectedly
    return res.status(403).json({ error: "Access denied. Unable to verify permissions." });
  }
};

const requireMasterAdmin = (req, res, next) => {
  const isMaster = req.user && (req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani"));
  if (!isMaster) {
    return res.status(403).json({ error: "Access denied. Master Admin privileges required." });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  const isMaster = req.user && (req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani"));
  if (!isMaster) {
    return res.status(403).json({ error: "Access denied. Master Admin privileges required." });
  }
  next();
};

const getUserMetaConfig = async (req, specificChannelId = null) => {
  try {
    let effectiveUserId = req?.targetUserId || req?.user?.id;
    if (!effectiveUserId && req?.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.decode(token);
      effectiveUserId = decoded?.id;
    }
    // SaaS Client Switcher header for Master Admin
    if (req?.headers && req.headers["x-client-id"]) {
      effectiveUserId = req.headers["x-client-id"];
    }
    if (!effectiveUserId) return null;

    const db = require("../db");

    // 1. Check if a specific sender channel is explicitly requested
    const targetChannelId =
      specificChannelId ||
      req?.headers?.["x-channel-id"] ||
      req?.query?.channel_id ||
      req?.body?.sender_channel_id;

    if (targetChannelId && targetChannelId !== "company" && isValidUuid(targetChannelId)) {
      const chanRes = await db.query(
        `SELECT id, phone_number_id, access_token, waba_id, display_phone_number, verified_name 
         FROM public.user_whatsapp_channels 
         WHERE id = $1 AND (user_id = $2 OR user_id IN (SELECT parent_client_id FROM public.users WHERE id = $2))`,
        [targetChannelId, effectiveUserId]
      );
      if (chanRes.rows.length > 0) {
        const c = chanRes.rows[0];
        return {
          channelId: c.id,
          phoneId: c.phone_number_id.trim(),
          token: c.access_token.trim(),
          wabaId: c.waba_id ? c.waba_id.trim() : null,
          displayPhone: c.display_phone_number,
          verifiedName: c.verified_name,
        };
      }
    }

    const userRes = await db.query(
      "SELECT whatsapp_mode, meta_phone_number_id, meta_access_token, meta_waba_id, parent_client_id FROM public.users WHERE id = $1",
      [effectiveUserId]
    );
    let user = userRes.rows[0];

    // If sub-login / staff, inherit parent client organization credentials
    if (user && user.parent_client_id) {
      const parentRes = await db.query(
        "SELECT whatsapp_mode, meta_phone_number_id, meta_access_token, meta_waba_id FROM public.users WHERE id = $1",
        [user.parent_client_id]
      );
      if (parentRes.rows[0]) {
        user = parentRes.rows[0];
      }
    }

    // 2. Check if user has a default channel in user_whatsapp_channels
    if (user && user.whatsapp_mode === "personal") {
      const defaultChanRes = await db.query(
        `SELECT id, phone_number_id, access_token, waba_id, display_phone_number, verified_name
         FROM public.user_whatsapp_channels
         WHERE user_id = $1 AND is_default = true
         LIMIT 1`,
        [effectiveUserId]
      );
      if (defaultChanRes.rows.length > 0) {
        const c = defaultChanRes.rows[0];
        return {
          channelId: c.id,
          phoneId: c.phone_number_id.trim(),
          token: c.access_token.trim(),
          wabaId: c.waba_id ? c.waba_id.trim() : null,
          displayPhone: c.display_phone_number,
          verifiedName: c.verified_name,
        };
      }

      if (user.meta_phone_number_id && user.meta_access_token) {
        return {
          phoneId: user.meta_phone_number_id.trim(),
          token: user.meta_access_token.trim(),
          wabaId: user.meta_waba_id ? user.meta_waba_id.trim() : null,
        };
      }
    }
  } catch (err) {
    // fallback to platform company default
  }
  return null;
};

module.exports = authenticate;
module.exports.authenticate = authenticate;
module.exports.requireMasterAdmin = requireMasterAdmin;
module.exports.requireAdmin = requireAdmin;
module.exports.requirePermission = requirePermission;
module.exports.getUserMetaConfig = getUserMetaConfig;
module.exports.JWT_SECRET = JWT_SECRET;

