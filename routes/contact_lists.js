const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../db");
const { uploadExcelToSupabase } = require("../services/supabaseService");
const { authenticate } = require("../middleware/authMiddleware");

router.use(authenticate);

const isValidUuid = (val) =>
  typeof val === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);

const parseCellPhone = (cell) => {
  if (cell === null || cell === undefined) return "";
  let str = "";
  if (typeof cell === "number") {
    // Avoid scientific notation formatting issues
    str = cell.toLocaleString("fullwide", { useGrouping: false });
    str = str.split(".")[0];
  } else {
    str = String(cell).trim();
    if (/e\+/i.test(str)) {
      const num = Number(str);
      if (!isNaN(num)) {
        str = num.toLocaleString("fullwide", { useGrouping: false }).split(".")[0];
      }
    }
  }
  let digits = str.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "91" + digits.slice(1);
  } else if (digits.length === 10) {
    digits = "91" + digits;
  }
  return digits;
};

const cleanPhoneNumber = (raw) => parseCellPhone(raw);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
});

/**
 * GET /api/contact_lists
 * List all saved contact sheets with member counts
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
      whereClause = "WHERE cl.user_id = $1";
      params.push(effectiveUserId);
    }

    const result = await db.query(
      `SELECT cl.*, u.username as client_username, COUNT(clm.contact_id) as member_count
       FROM public.contact_lists cl
       LEFT JOIN public.users u ON cl.user_id = u.id
       LEFT JOIN public.contact_list_members clm ON cl.id = clm.list_id
       ${whereClause}
       GROUP BY cl.id, u.username
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
 * Upload and parse Excel / CSV contact sheet with intelligent auto-detection and high-speed batching
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
      // Max 3.5s timeout for storage upload so it never blocks or hangs
      fileUrl = await Promise.race([
        uploadExcelToSupabase(req.file.buffer, safeFilename),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Storage timeout")), 3500)),
      ]).catch(() => null);
    } catch (uploadErr) {
      console.warn("Supabase storage upload skipped/failed:", uploadErr.message);
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "The uploaded file contains no data rows." });
    }

    // Step 1: Intelligent Auto-detection of Header Row and Column Indices
    const PHONE_HEADER_REGEX = /(phone|mobile|whatsapp|wa|contact|number|num|cell|mob|tel|ph|calling|caller|kramank|durdwani)/i;
    const NAME_HEADER_REGEX = /(name|customer|client|contact_name|person|full_name|fullname|first_name|naam|user|lead|party)/i;
    const CITY_HEADER_REGEX = /(city|location|state|district|address|town|region|shahar|place|pincode|zip)/i;

    let headerRowIdx = -1;
    let phoneIdx = -1;
    let nameIdx = -1;
    let cityIdx = -1;

    for (let r = 0; r < Math.min(rows.length, 5); r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      let pIdx = -1, nIdx = -1, cIdx = -1;
      row.forEach((cell, idx) => {
        const val = String(cell || "").toLowerCase().trim();
        if (pIdx === -1 && PHONE_HEADER_REGEX.test(val)) pIdx = idx;
        else if (nIdx === -1 && NAME_HEADER_REGEX.test(val)) nIdx = idx;
        else if (cIdx === -1 && CITY_HEADER_REGEX.test(val)) cIdx = idx;
      });
      if (pIdx !== -1 || nIdx !== -1) {
        headerRowIdx = r;
        phoneIdx = pIdx;
        nameIdx = nIdx;
        cityIdx = cIdx;
        break;
      }
    }

    // Step 2: Content-based Auto-detection if headers were missing or ambiguous
    const sampleRows = rows.slice(headerRowIdx !== -1 ? headerRowIdx + 1 : 0, 35);
    if (phoneIdx === -1) {
      const colPhoneCounts = [];
      sampleRows.forEach((row) => {
        if (!Array.isArray(row)) return;
        row.forEach((cell, idx) => {
          const digits = parseCellPhone(cell);
          if (digits.length >= 10 && digits.length <= 15) {
            colPhoneCounts[idx] = (colPhoneCounts[idx] || 0) + 1;
          }
        });
      });
      let maxP = 0;
      colPhoneCounts.forEach((count, idx) => {
        if (count > maxP) {
          maxP = count;
          phoneIdx = idx;
        }
      });
    }

    if (nameIdx === -1) {
      const colTextCounts = [];
      sampleRows.forEach((row) => {
        if (!Array.isArray(row)) return;
        row.forEach((cell, idx) => {
          if (idx === phoneIdx) return;
          const str = String(cell || "").trim();
          if (str.length >= 2 && str.length <= 50 && /[a-zA-Z\u0900-\u097F]/.test(str) && !/^\d+$/.test(str)) {
            colTextCounts[idx] = (colTextCounts[idx] || 0) + 1;
          }
        });
      });
      let maxN = 0;
      colTextCounts.forEach((count, idx) => {
        if (count > maxN) {
          maxN = count;
          nameIdx = idx;
        }
      });
    }

    const dataStartRow = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
    const contactsToSave = [];

    for (let i = dataStartRow; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !Array.isArray(row) || row.length === 0) continue;

      let extractedPhone = phoneIdx !== -1 ? parseCellPhone(row[phoneIdx]) : "";
      let extractedName = nameIdx !== -1 ? String(row[nameIdx] || "").trim() : "";
      let extractedCity = cityIdx !== -1 ? String(row[cityIdx] || "").trim() : "";

      // Fallback: if designated phone cell is empty/invalid, scan all cells in the row
      if (!extractedPhone || extractedPhone.length < 10 || extractedPhone.length > 15) {
        for (let col = 0; col < row.length; col++) {
          if (col === nameIdx || col === cityIdx) continue;
          const candidate = parseCellPhone(row[col]);
          if (candidate.length >= 10 && candidate.length <= 15) {
            extractedPhone = candidate;
            break;
          }
        }
      }

      if (extractedPhone.length >= 10 && extractedPhone.length <= 15) {
        contactsToSave.push({
          phone: extractedPhone,
          name: (extractedName || `Contact ${extractedPhone.slice(-4)}`).slice(0, 255),
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

    // High-speed Batched Bulk Insert in chunks of 500
    const BATCH_SIZE = 500;
    let addedCount = 0;
    for (let i = 0; i < uniqueContacts.length; i += BATCH_SIZE) {
      const chunk = uniqueContacts.slice(i, i + BATCH_SIZE);
      const phones = chunk.map((c) => c.phone);
      const names = chunk.map((c) => c.name);
      const cities = chunk.map((c) => c.city);
      const userIds = chunk.map(() => effectiveUserId);

      const batchQuery = `
        WITH inserted AS (
          INSERT INTO public.contacts (phone_number, name, city, user_id)
          SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::uuid[])
          ON CONFLICT (phone_number) DO UPDATE SET 
            name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
            city = COALESCE(NULLIF(EXCLUDED.city, ''), contacts.city),
            user_id = COALESCE(contacts.user_id, EXCLUDED.user_id)
          RETURNING id
        )
        INSERT INTO public.contact_list_members (list_id, contact_id)
        SELECT $5::uuid, id FROM inserted
        ON CONFLICT DO NOTHING
        RETURNING contact_id;
      `;
      const result = await db.query(batchQuery, [phones, names, cities, userIds, list.id]);
      addedCount += result.rowCount || chunk.length;
    }

    const payload = {
      id: list.id,
      name: list.name,
      member_count: addedCount,
      user_id: effectiveUserId,
      created_at: list.created_at,
    };

    // Real-time Socket.IO Broadcast to all connected clients & dashboards
    const io = req.app.get("io");
    if (io) {
      io.emit("contact_list_created", { list: payload });
    }

    res.status(201).json({
      message: "Contact list saved successfully",
      list: payload,
    });
  } catch (err) {
    console.error("❌ Contact list creation error:", err);
    res.status(500).json({ error: "Failed to process contact list upload: " + (err.message || "") });
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

    const effectiveUserId = req.targetUserId || req.user?.id || null;
    const listResult = await db.query(
      `INSERT INTO contact_lists (name, user_id) VALUES ($1, $2) RETURNING *`,
      [name.trim().slice(0, 255), effectiveUserId]
    );

    const payload = {
      id: listResult.rows[0].id,
      name: listResult.rows[0].name,
      member_count: 0,
      user_id: effectiveUserId,
      created_at: listResult.rows[0].created_at,
    };

    const io = req.app.get("io");
    if (io) {
      io.emit("contact_list_created", { list: payload });
    }

    res.status(201).json({
      message: "Empty contact list created successfully",
      list: payload,
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
    const effectiveUserId = req.targetUserId || req.user?.id || null;

    const contactResult = await db.query(
      `INSERT INTO contacts (phone_number, name, city, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number) DO UPDATE SET 
         name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
         city = COALESCE(NULLIF(EXCLUDED.city, ''), contacts.city),
         user_id = COALESCE(contacts.user_id, EXCLUDED.user_id)
       RETURNING id`,
      [cleanedPhone, safeName, safeCity, effectiveUserId]
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

    const io = req.app.get("io");
    if (io) {
      io.emit("contact_list_deleted", { id });
    }

    res.json({ message: "Contact list deleted successfully" });
  } catch (err) {
    console.error("❌ Delete contact list error:", err);
    res.status(500).json({ error: "Failed to delete list." });
  }
});

module.exports = router;
