const express = require("express");
const router = express.Router();
const db = require("../db");

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

const cleanPhoneNumber = (raw) => {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "91" + digits.slice(1);
  } else if (digits.length === 10) {
    digits = "91" + digits;
  }
  return digits;
};

/**
 * GET /api/contacts
 * Returns list of contacts with latest message preview and unread counts
 */
router.get("/", async (req, res) => {
  try {
    const effectiveUserId = req.targetUserId || (req.user?.role !== "master_admin" ? req.user?.id : null);
    let whereClause = "";
    let params = [];
    if (effectiveUserId) {
      whereClause = "WHERE c.user_id = $1";
      params.push(effectiveUserId);
    }

    const result = await db.query(
      `SELECT
        c.id,
        c.phone_number,
        c.name,
        c.created_at,
        c.user_id,
        m.message_body as last_message,
        m.direction as last_message_direction,
        m.timestamp as last_message_time,
        (
          SELECT COUNT(*)
          FROM messages m2
          WHERE m2.contact_id = c.id
            AND m2.direction = 'inbound'
            AND m2.status IS DISTINCT FROM 'read'
        ) as unread_count,
        (
          SELECT timestamp
          FROM messages m3
          WHERE m3.contact_id = c.id
            AND m3.direction = 'inbound'
            AND m3.timestamp IS NOT NULL
          ORDER BY m3.timestamp DESC
          LIMIT 1
        ) as last_inbound_time
      FROM contacts c
      LEFT JOIN LATERAL (
        SELECT message_body, direction, timestamp
        FROM messages
        WHERE contact_id = c.id
        ORDER BY timestamp DESC NULLS LAST
        LIMIT 1
      ) m ON true
      ${whereClause}
      ORDER BY m.timestamp DESC NULLS LAST`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ List contacts error:", err);
    res.status(500).json({ error: "Failed to fetch contact directory." });
  }
});

/**
 * GET /api/contacts/:id
 * Retrieve specific contact details and 24h window status
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    const result = await db.query(`SELECT * FROM contacts WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const lastInbound = await db.query(
      `SELECT timestamp FROM messages
       WHERE contact_id = $1 AND direction = 'inbound' AND timestamp IS NOT NULL
       ORDER BY timestamp DESC NULLS LAST
       LIMIT 1`,
      [id]
    );

    const contact = result.rows[0];
    contact.last_inbound_at = lastInbound.rows[0]?.timestamp || null;
    contact.window_open = lastInbound.rows[0]?.timestamp
      ? Date.now() - new Date(lastInbound.rows[0].timestamp).getTime() < 24 * 60 * 60 * 1000
      : false;

    res.json(contact);
  } catch (err) {
    console.error("❌ Contact detail error:", err);
    res.status(500).json({ error: "Failed to retrieve contact details." });
  }
});

/**
 * POST /api/contacts
 * Add a new contact
 */
router.post("/", async (req, res) => {
  try {
    const { name, phone_number, city } = req.body || {};
    if (!phone_number) {
      return res.status(400).json({ error: "Phone number is required." });
    }

    const cleanedPhone = cleanPhoneNumber(phone_number);

    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: "Please enter a valid 10 to 15-digit phone number." });
    }

    const checkResult = await db.query("SELECT id FROM contacts WHERE phone_number = $1", [cleanedPhone]);
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ error: "A contact with this phone number already exists." });
    }

    const effectiveUserId = req.targetUserId || req.user?.id || null;
    const safeName = (typeof name === "string" ? name.trim().slice(0, 255) : "") || "Unknown";
    const safeCity = typeof city === "string" ? city.trim().slice(0, 255) : "";

    const result = await db.query(
      "INSERT INTO contacts (name, phone_number, city, user_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [safeName, cleanedPhone, safeCity, effectiveUserId]
    );

    res.status(201).json({ message: "Contact added successfully", contact: result.rows[0] });
  } catch (err) {
    console.error("❌ Add contact error:", err);
    res.status(500).json({ error: "Failed to add contact. Please try again." });
  }
});

/**
 * PUT /api/contacts/:id
 * Update contact details
 */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    const { name, phone_number, city } = req.body || {};

    if (!phone_number) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const cleanedPhone = cleanPhoneNumber(phone_number);
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: "Please enter a valid 10 to 15-digit phone number." });
    }

    // Check if another contact has this phone number
    const checkResult = await db.query("SELECT id FROM contacts WHERE phone_number = $1 AND id != $2", [
      cleanedPhone,
      id,
    ]);
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ error: "Another contact with this phone number already exists" });
    }

    const safeName = (typeof name === "string" ? name.trim().slice(0, 255) : "") || "Unknown";
    const safeCity = typeof city === "string" ? city.trim().slice(0, 255) : "";

    const result = await db.query(
      "UPDATE contacts SET name = $1, phone_number = $2, city = $3 WHERE id = $4 RETURNING *",
      [safeName, cleanedPhone, safeCity, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json({ message: "Contact updated successfully", contact: result.rows[0] });
  } catch (err) {
    console.error("❌ Update contact error:", err);
    res.status(500).json({ error: "Failed to update contact." });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete contact and associations safely
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid contact ID format." });
    }

    await db.query("DELETE FROM contact_list_members WHERE contact_id = $1", [id]);
    await db.query("DELETE FROM messages WHERE contact_id = $1", [id]);
    const result = await db.query("DELETE FROM contacts WHERE id = $1 RETURNING *", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json({ message: "Contact deleted successfully" });
  } catch (err) {
    console.error("❌ Contact deletion error:", err);
    res.status(500).json({ error: "Failed to delete contact." });
  }
});

module.exports = router;
