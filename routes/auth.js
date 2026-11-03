const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "enterprise_wp_automation_jwt_secret_2026";

/**
 * POST /api/auth/login
 * Robust, case-insensitive, bcrypt-verified authentication
 */
router.post("/login", async (req, res) => {
  let { username, password } = req.body || {};

  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }

  username = username.trim();
  password = password.trim();

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password cannot be empty." });
  }

  try {
    // Case-insensitive trimmed username lookup
    const result = await db.query(
      "SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER($1) LIMIT 1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = result.rows[0];

    // Verify password via bcrypt or fallback plaintext check
    let isMatch = false;
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
      isMatch = await bcrypt.compare(password, user.password);
    } else {
      isMatch = password === user.password;
      // Upgrade plaintext password to bcrypt hash in the background
      if (isMatch) {
        const upgradedHash = await bcrypt.hash(password, 10);
        db.query("UPDATE users SET password = $1 WHERE id = $2", [upgradedHash, user.id]).catch(() => {});
      }
    }

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        parent_client_id: user.parent_client_id || null,
        whatsapp_mode: user.whatsapp_mode || "company",
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        parent_client_id: user.parent_client_id || null,
        whatsapp_mode: user.whatsapp_mode || "company",
        meta_display_phone_number: user.meta_display_phone_number || null,
        has_personal_meta: !!(user.meta_phone_number_id && user.meta_access_token),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Internal authentication error. Please try again later." });
  }
});

/**
 * PUT /api/auth/profile
 * Update credentials with bcrypt hashing
 */
router.put("/profile", async (req, res) => {
  const { currentUsername, currentPassword, newUsername, newPassword } = req.body || {};

  if (!currentUsername || !currentPassword || !newUsername || !newPassword) {
    return res.status(400).json({ error: "All profile fields are required." });
  }

  try {
    const checkResult = await db.query(
      "SELECT id, password FROM users WHERE LOWER(TRIM(username)) = LOWER($1) LIMIT 1",
      [currentUsername.trim()]
    );

    if (checkResult.rows.length === 0) {
      return res.status(401).json({ error: "Current credentials do not match." });
    }

    const user = checkResult.rows[0];
    let isMatch = false;
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
      isMatch = await bcrypt.compare(currentPassword.trim(), user.password);
    } else {
      isMatch = currentPassword.trim() === user.password;
    }

    if (!isMatch) {
      return res.status(401).json({ error: "Current credentials do not match." });
    }

    const newHashedPassword = await bcrypt.hash(newPassword.trim(), 10);

    await db.query(
      "UPDATE users SET username = $1, password = $2, raw_password = $3 WHERE id = $4",
      [newUsername.trim(), newHashedPassword, newPassword.trim(), user.id]
    );

    res.json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error("Profile update error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Username already exists." });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
