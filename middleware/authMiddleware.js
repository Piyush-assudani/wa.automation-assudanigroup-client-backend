const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "enterprise_wp_automation_jwt_secret_2026";

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Token missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // SaaS Multi-tenant client switching strictly for Master Admin ONLY (piyushassudani)
    const isMaster = req.user.role === "master_admin" || (req.user.username && req.user.username.toLowerCase() === "piyushassudani");
    const targetClientId = req.headers["x-client-id"];

    if (targetClientId && isMaster) {
      req.targetUserId = targetClientId;
    } else if (req.user.parent_client_id) {
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

const getUserMetaConfig = async (req) => {
  try {
    let effectiveUserId = req.targetUserId || req.user?.id;
    if (!effectiveUserId && req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.decode(token);
      effectiveUserId = decoded?.id;
    }
    // SaaS Client Switcher header for Master Admin
    if (req.headers && req.headers["x-client-id"]) {
      effectiveUserId = req.headers["x-client-id"];
    }
    if (!effectiveUserId) return null;

    const db = require("../db");
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

    if (user && user.whatsapp_mode === "personal" && user.meta_phone_number_id && user.meta_access_token) {
      return {
        phoneId: user.meta_phone_number_id.trim(),
        token: user.meta_access_token.trim(),
        wabaId: user.meta_waba_id ? user.meta_waba_id.trim() : null,
      };
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
module.exports.getUserMetaConfig = getUserMetaConfig;

