const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../db");
const { uploadExcelToSupabase } = require("../services/supabaseService");

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
});

/**
 * GET /api/contact_lists
 * List all saved contact sheets with member counts
 */
router.get("/", async (req, res) => {
  try {
    const effectiveUserId = req.targetUserId || (req.user?.role !== "master_admin" ? req.user?.id : null);
    let whereClause = "";
    let params = [];
    if (effectiveUserId) {
      whereClause = "WHERE cl.user_id = $1";
      params.push(effectiveUserId);
    }

    const result = await db.query(
      `SELECT cl.*, COUNT(clm.contact_id) as member_count
       FROM contact_lists cl
       LEFT JOIN contact_list_members clm ON cl.id = clm.list_id
       ${whereClause}
       GROUP BY cl.id
       ORDER BY cl.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ List contact_lists error:", err);
    res.status(500).json({ error: "Failed to load contact lists." });
  }
});

/**
 * POST /api/contact_lists
 * Upload and parse Excel / CSV contact sheet
 */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const { name } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "List name is required." });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "Please select an Excel (.xlsx, .xls) or CSV file." });
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (parseErr) {
      return res.status(400).json({ error: "Unable to parse Excel file. The file may be corrupt or encrypted." });
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({ error: "The uploaded spreadsheet does not contain any sheets." });
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return res.status(400).json({ error: "Spreadsheet sheet is empty or unreadable." });
    }

    let fileUrl = null;
    try {
      const safeFilename = `${Date.now()}-${(req.file.originalname || "contacts.xlsx").replace(/[^a-zA-Z0-9.-]/g, "_")}`;
      fileUrl = await uploadExcelToSupabase(req.file.buffer, safeFilename);
    } catch (uploadErr) {
      console.warn("Supabase storage upload skipped/failed:", uploadErr.message);
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "The uploaded file contains no data rows." });
    }

    // Auto-detect header column indices
    let nameIdx = -1;
    let phoneIdx = -1;
    let cityIdx = -1;

    const firstRow = rows[0] || [];
    firstRow.forEach((cell, idx) => {
      const val = String(cell || "").toLowerCase().trim();
      if (/phone|mobile|whatsapp|contact_no|cell|mob|tel/i.test(val) && phoneIdx === -1) {
        phoneIdx = idx;
      } else if (/name|customer|client|contact_name|person/i.test(val) && nameIdx === -1) {
        nameIdx = idx;
      } else if (/city|location|state|district|address/i.test(val) && cityIdx === -1) {
        cityIdx = idx;
      }
    });

    const startRow = phoneIdx !== -1 || nameIdx !== -1 ? 1 : 0;
    const contactsToSave = [];

    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !Array.isArray(row) || row.length === 0) continue;

      let extractedPhone = "";
      let extractedName = "";
      let extractedCity = "";

      if (phoneIdx !== -1 && row[phoneIdx] !== undefined) {
        extractedPhone = String(row[phoneIdx] || "").trim();
      }
      if (nameIdx !== -1 && row[nameIdx] !== undefined) {
        extractedName = String(row[nameIdx] || "").trim();
      }
      if (cityIdx !== -1 && row[cityIdx] !== undefined) {
        extractedCity = String(row[cityIdx] || "").trim();
      }

      // If phone wasn't detected by header, scan cells for a 10-15 digit string
      if (!extractedPhone) {
        for (let col = 0; col < row.length; col++) {
          const raw = String(row[col] || "").trim();
          const digits = raw.replace(/\D/g, "");
          if (digits.length >= 10 && digits.length <= 15) {
            extractedPhone = digits;
            if (!extractedName && col > 0 && typeof row[col - 1] === "string") {
              extractedName = String(row[col - 1]).trim();
            } else if (!extractedName && col + 1 < row.length && typeof row[col + 1] === "string") {
              extractedName = String(row[col + 1]).trim();
            }
            break;
          }
        }
      }

      const cleanPhone = cleanPhoneNumber(extractedPhone);
      if (cleanPhone.length >= 10 && cleanPhone.length <= 15) {
        contactsToSave.push({
          name: (extractedName || `Contact ${cleanPhone.slice(-4)}`).slice(0, 255),
          phone: cleanPhone,
          city: (extractedCity || "").slice(0, 255),
        });
      }
    }

    if (contactsToSave.length === 0) {
      return res.status(400).json({
        error: "No valid 10 to 15-digit phone numbers could be extracted from the uploaded file.",
      });
    }

    // Deduplicate within the file
    const uniqueMap = new Map();
    for (const c of contactsToSave) {
      if (!uniqueMap.has(c.phone)) {
        uniqueMap.set(c.phone, c);
      }
    }
    const uniqueContacts = Array.from(uniqueMap.values());

    const effectiveUserId = req.targetUserId || req.user?.id || null;
    const listResult = await db.query(
      `INSERT INTO contact_lists (name, file_url, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim().slice(0, 255), fileUrl, effectiveUserId]
    );
    const list = listResult.rows[0];

    let addedCount = 0;
    for (const contact of uniqueContacts) {
      try {
        const contactResult = await db.query(
          `INSERT INTO contacts (phone_number, name, city, user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (phone_number) DO UPDATE SET 
             name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
             city = COALESCE(NULLIF(EXCLUDED.city, ''), contacts.city),
             user_id = COALESCE(contacts.user_id, EXCLUDED.user_id)
           RETURNING id`,
          [contact.phone, contact.name, contact.city, effectiveUserId]
        );

        const contactId = contactResult.rows[0].id;
        await db.query(
          `INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [list.id, contactId]
        );
        addedCount++;
      } catch (insertErr) {
        console.warn("Failed to insert contact member:", insertErr.message);
      }
    }

    res.status(201).json({
      message: "Contact list saved successfully",
      list: {
        id: list.id,
        name: list.name,
        member_count: addedCount,
        created_at: list.created_at,
      },
    });
  } catch (err) {
    console.error("❌ Contact list creation error:", err);
    res.status(500).json({ error: "Failed to process contact list upload." });
  }
});

/**
 * POST /api/contact_lists/manual
 * Create an empty list for manual contact entry
 */
router.post("/manual", express.json(), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "List name is required" });
    }

    const listResult = await db.query(
      `INSERT INTO contact_lists (name) VALUES ($1) RETURNING *`,
      [name.trim().slice(0, 255)]
    );

    res.status(201).json({
      message: "Empty contact list created successfully",
      list: {
        id: listResult.rows[0].id,
        name: listResult.rows[0].name,
        member_count: 0,
        created_at: listResult.rows[0].created_at,
      },
    });
  } catch (err) {
    console.error("❌ Manual list creation error:", err);
    res.status(500).json({ error: "Failed to create empty list." });
  }
});

/**
 * GET /api/contact_lists/:id/contacts
 * Retrieve all contacts assigned to a specific list
 */
router.get("/:id/contacts", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid contact list ID format." });
    }

    const result = await db.query(
      `SELECT c.id, c.phone_number, c.name, c.city, c.created_at,
        (SELECT EXISTS (
          SELECT 1 FROM messages m 
          WHERE m.contact_id = c.id 
          AND m.status = 'failed' 
          AND m.error_message ILIKE '%undeliverable%'
        )) as not_on_wp
       FROM contact_list_members clm
       JOIN contacts c ON clm.contact_id = c.id
       WHERE clm.list_id = $1
       ORDER BY c.created_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ List contacts error:", err);
    res.status(500).json({ error: "Failed to fetch list contacts." });
  }
});

/**
 * POST /api/contact_lists/:id/contacts
 * Manually add a single contact to a list
 */
router.post("/:id/contacts", async (req, res) => {
  try {
    const { id: list_id } = req.params;

    if (!isValidUuid(list_id)) {
      return res.status(400).json({ error: "Invalid contact list ID format." });
    }

    const { name, phone_number, city } = req.body || {};

    if (!phone_number) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const cleanedPhone = cleanPhoneNumber(phone_number);
    if (cleanedPhone.length < 10 || cleanedPhone.length > 15) {
      return res.status(400).json({ error: "Please enter a valid 10 to 15-digit phone number." });
    }

    const safeName = (typeof name === "string" ? name.trim().slice(0, 255) : "") || "Unknown";
    const safeCity = typeof city === "string" ? city.trim().slice(0, 255) : "";

    const contactResult = await db.query(
      `INSERT INTO contacts (phone_number, name, city)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) DO UPDATE SET 
         name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
         city = COALESCE(NULLIF(EXCLUDED.city, ''), contacts.city)
       RETURNING id`,
      [cleanedPhone, safeName, safeCity]
    );
    const contactId = contactResult.rows[0].id;

    await db.query(
      `INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [list_id, contactId]
    );

    res.status(201).json({ message: "Contact added to list successfully" });
  } catch (err) {
    console.error("❌ Add contact to list error:", err);
    res.status(500).json({ error: "Failed to add contact to list." });
  }
});

/**
 * DELETE /api/contact_lists/:id
 * Delete contact list and dissociate members
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid contact list ID format." });
    }

    // Remove members from list association first
    await db.query(`DELETE FROM contact_list_members WHERE list_id = $1`, [id]);
    const result = await db.query(`DELETE FROM contact_lists WHERE id = $1 RETURNING id`, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Contact list not found." });
    }

    res.json({ message: "Contact list deleted successfully" });
  } catch (err) {
    console.error("❌ Delete contact list error:", err);
    res.status(500).json({ error: "Failed to delete list." });
  }
});

module.exports = router;
