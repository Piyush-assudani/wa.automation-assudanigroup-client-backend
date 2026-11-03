const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

async function seedUsers() {
  console.log("Connecting to PostgreSQL to seed users...");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const users = [
    {
      username: "Kapilchaudhary",
      password: "Kapilchaudhary@123",
      role: "admin",
    },
    {
      username: "Piyushassudani",
      password: "9413879444",
      role: "admin",
    },
  ];

  try {
    for (const u of users) {
      const hashedPassword = await bcrypt.hash(u.password, 10);
      
      // Upsert: check if user exists (case-insensitive)
      const existing = await pool.query(
        "SELECT id, username FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))",
        [u.username]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          "UPDATE users SET password = $1, role = $2 WHERE id = $3",
          [hashedPassword, u.role, existing.rows[0].id]
        );
        console.log(`✅ Updated credentials for existing user: ${u.username}`);
      } else {
        await pool.query(
          "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
          [u.username, hashedPassword, u.role]
        );
        console.log(`✅ Created new user: ${u.username}`);
      }
    }

    // List all users in DB
    const list = await pool.query("SELECT id, username, role, created_at FROM users ORDER BY created_at ASC");
    console.log("\n--- Current Users in Database ---");
    list.rows.forEach((r, idx) => {
      console.log(`${idx + 1}. Username: "${r.username}" | Role: "${r.role}" | ID: ${r.id}`);
    });
    console.log("---------------------------------\n");

  } catch (err) {
    console.error("❌ Failed to seed users:", err.message);
  } finally {
    await pool.end();
  }
}

seedUsers();
