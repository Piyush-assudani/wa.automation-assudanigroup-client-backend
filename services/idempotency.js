const db = require("../db");

/**
 * Checks if an Idempotency-Key was already processed.
 * Returns cached { status, body } if found, or null otherwise.
 */
async function getIdempotentResponse(key, userId, route) {
  if (!key || typeof key !== "string" || key.length > 255) return null;
  try {
    const res = await db.query(
      `SELECT response_status, response_body
       FROM public.idempotency_keys
       WHERE key = $1 AND route = $2 AND ($3::uuid IS NULL OR user_id = $3)
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [key.trim(), route, userId || null]
    );
    if (res.rows.length > 0) {
      return {
        status: res.rows[0].response_status,
        body: res.rows[0].response_body,
      };
    }
  } catch (err) {
    // Table may not exist yet during first boot before migration
  }
  return null;
}

/**
 * Saves an Idempotency-Key response atomically (best-effort, non-blocking on failure).
 */
async function saveIdempotentResponse(key, userId, route, status, body) {
  if (!key || typeof key !== "string" || key.length > 255) return;
  try {
    await db.query(
      `INSERT INTO public.idempotency_keys (key, user_id, route, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key.trim(), userId || null, route, status, JSON.stringify(body)]
    );
  } catch (err) {
    // Non-fatal
  }
}

module.exports = {
  getIdempotentResponse,
  saveIdempotentResponse,
};
