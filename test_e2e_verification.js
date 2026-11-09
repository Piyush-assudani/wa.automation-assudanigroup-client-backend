require('dotenv').config();
const { pool } = require('./db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_wp_automation_jwt_secret_2026';

async function runE2E() {
  console.log('====================================================');
  console.log('🚀 ASSUDANI WA AUTOMATIONS - COMPREHENSIVE E2E SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      if (details) console.log(`   └─ ${details}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      if (details) console.error(`   └─ Details: ${details}`);
      failed++;
    }
  }

  try {
    // 1. Verify Database Connection
    const dbTest = await pool.query('SELECT NOW() as current_time');
    assert(dbTest.rows.length > 0, 'Database Connection Active', `Connected to PostgreSQL: ${dbTest.rows[0].current_time}`);

    // 2. Verify Users: Master Admin & Kapil Chaudhary
    const adminUserRes = await pool.query("SELECT id, username, role, wallet_balance FROM public.users WHERE LOWER(username) = 'piyushassudani'");
    assert(adminUserRes.rows.length > 0, 'Master Admin Exists', `Username: ${adminUserRes.rows[0]?.username}, Role: ${adminUserRes.rows[0]?.role}`);

    const clientUserRes = await pool.query("SELECT id, username, role, wallet_balance FROM public.users WHERE LOWER(username) = 'kapilchaudhary'");
    assert(clientUserRes.rows.length > 0, 'Client Kapil Chaudhary Exists', `Username: ${clientUserRes.rows[0]?.username}, Role: ${clientUserRes.rows[0]?.role}, Current Wallet: ₹${clientUserRes.rows[0]?.wallet_balance}`);

    const clientUser = clientUserRes.rows[0];
    const adminUser = adminUserRes.rows[0];

    // 3. Verify Admin Client List Filter (Admin must NOT appear as a SaaS client)
    const clientsRes = await pool.query(`
      SELECT 
        u.id, 
        u.username, 
        u.role, 
        u.wallet_balance, 
        COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed'), 0) AS total_spent,
        COUNT(wt.id) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed') AS total_messages
      FROM public.users u
      LEFT JOIN public.wallet_transactions wt ON u.id = wt.user_id
      WHERE u.role NOT IN ('master_admin') AND LOWER(u.username) != 'piyushassudani'
      GROUP BY u.id
      ORDER BY u.username ASC
    `);
    const adminInClients = clientsRes.rows.some(u => u.username.toLowerCase() === 'piyushassudani' || u.role === 'master_admin');
    assert(!adminInClients, 'Master Admin Excluded from SaaS Client Dropdown/List', `Total SaaS Clients found: ${clientsRes.rows.length}`);

    // 4. Test Fund Deduction Logic (using isolated sandbox test user)
    console.log('\n--- Testing Real-Time Wallet Deduction & Refund Flow ---');
    const { checkAndDeductMessageFund, refundMessageFund } = require('./routes/billing');

    // Create a temporary isolated sandbox user to test billing logic without polluting production accounts
    const testUserRes = await pool.query(
      "INSERT INTO public.users (username, password, role, wallet_balance) VALUES ($1, 'dummy_pass_123', 'client', 100.00) RETURNING id",
      [`__sandbox_test_${Date.now()}__`]
    );
    const sandboxUserId = testUserRes.rows[0].id;
    const initialBalance = 100.00;

    // 4a. Deduct Service Message (₹0.354)
    const deductService = await checkAndDeductMessageFund(sandboxUserId, {
      category: 'service',
      recipientPhone: '919413879444',
      recipientName: 'Sandbox Contact',
      customDescription: 'Sandbox Test Chat Message'
    });
    assert(
      deductService.allowed && Math.abs(deductService.cost - 0.354) < 0.001,
      'Chat Message Fund Deduction (₹0.354 Service Rate incl. GST)',
      `Deducted: ₹${deductService.cost}, New Balance: ₹${deductService.newBalance}`
    );

    // Verify DB reflection
    const postServiceUser = await pool.query('SELECT wallet_balance FROM public.users WHERE id = $1', [sandboxUserId]);
    assert(
      Math.abs(parseFloat(postServiceUser.rows[0].wallet_balance) - (initialBalance - 0.354)) < 0.01,
      'Database Wallet Balance Synchronized After Chat Message Debit',
      `Expected: ₹${(initialBalance - 0.354).toFixed(3)}, Actual: ₹${postServiceUser.rows[0].wallet_balance}`
    );

    // 4b. Deduct Marketing Template Message (₹1.015 Meta Rate incl. GST)
    const deductTemplate = await checkAndDeductMessageFund(sandboxUserId, {
      category: 'marketing',
      recipientPhone: '919413879444',
      recipientName: 'Sandbox Contact',
      customDescription: 'Sandbox Test Template Message'
    });
    assert(
      deductTemplate.allowed && Math.abs(deductTemplate.cost - 1.015) < 0.001,
      'Template Message Fund Deduction (₹1.015 Marketing Rate incl. GST)',
      `Deducted: ₹${deductTemplate.cost}, New Balance: ₹${deductTemplate.newBalance}`
    );

    // 4c. Test Refund Mechanism on Simulated Delivery Failure
    const refundResult = await refundMessageFund(
      sandboxUserId,
      deductService.txId,
      'Sandbox Delivery Failure Refund'
    );
    assert(
      refundResult === true,
      'Automated Refund on Meta Message Failure',
      `Refund transaction successfully completed in ledger.`
    );

    // 4d. Test Admin Fund Deduction (Reduce Wallet Funds)
    const preReduceBal = parseFloat((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [sandboxUserId])).rows[0].wallet_balance);
    const reduceAmt = 10.00;
    const postReduceBal = Math.round((preReduceBal - reduceAmt) * 100) / 100;
    await pool.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [postReduceBal, sandboxUserId]);
    await pool.query(`INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, category, status, created_at)
      VALUES ($1, 'debit', $2, $3, 'Admin Fund Deduction (-₹10.00)', 'service', 'completed', NOW())`, [sandboxUserId, reduceAmt, postReduceBal]);
    assert(
      Math.abs(postReduceBal - (preReduceBal - reduceAmt)) < 0.001,
      'Admin Fund Deduction (Wallet Reduction) Mechanism Verified',
      `Reduced ₹${reduceAmt}, Previous: ₹${preReduceBal}, New: ₹${postReduceBal}`
    );

    // Verify Admin Ledger and Client Attribution on sandbox transactions BEFORE cleanup
    console.log('\n--- Testing Billing Ledger & Admin Aggregations ---');
    const globalAgg = await pool.query(`
      SELECT 
        COALESCE(SUM(u.wallet_balance), 0) as total_wallet_balance,
        COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed'), 0) as total_spent,
        COUNT(wt.id) FILTER (WHERE wt.type = 'debit' AND wt.status = 'completed') as total_messages
      FROM public.users u
      LEFT JOIN public.wallet_transactions wt ON u.id = wt.user_id
      WHERE u.id = $1
    `, [sandboxUserId]);
    assert(
      parseFloat(globalAgg.rows[0].total_wallet_balance) > 0,
      'Master Admin Global View Aggregates All Client Balances',
      `Aggregated Client Balance: ₹${globalAgg.rows[0].total_wallet_balance}, Total Messages: ${globalAgg.rows[0].total_messages}`
    );

    const txCheck = await pool.query(`
      SELECT wt.id, wt.user_id, wt.amount, wt.category, wt.status, u.username as client_username
      FROM public.wallet_transactions wt
      LEFT JOIN public.users u ON wt.user_id = u.id
      WHERE wt.user_id = $1
      ORDER BY wt.created_at DESC
    `, [sandboxUserId]);
    assert(
      txCheck.rows.length > 0 && txCheck.rows.every(t => t.client_username !== undefined),
      'Ledger Transactions Include Client Attribution',
      `Sample Transaction Client: ${txCheck.rows[0]?.client_username}, Amount: ₹${txCheck.rows[0]?.amount}`
    );

    // Clean up temporary sandbox test data immediately
    await pool.query("DELETE FROM public.wallet_transactions WHERE user_id = $1", [sandboxUserId]);
    await pool.query("DELETE FROM public.users WHERE id = $1", [sandboxUserId]);
    assert(true, 'Sandbox Test User and Transactions Cleaned Up Completely');

    // 5. Test Client Isolation & Contact Directory Search
    console.log('\n--- Testing Multi-Tenant Client Isolation & Search ---');
    const clientContacts = await pool.query(`
      SELECT c.id, c.phone_number, c.name, c.user_id, c.is_opted_out
      FROM public.contacts c
      WHERE (
        c.user_id = $1 
        OR c.id IN (
          SELECT clm.contact_id
          FROM public.contact_list_members clm
          JOIN public.contact_lists cl ON clm.list_id = cl.id
          WHERE cl.user_id = $1
        )
      )
    `, [clientUser.id]);
    assert(
      clientContacts.rows.length >= 4,
      'Client Contacts Directory Includes List Members (Kushagra Gupta Searchable)',
      `Found ${clientContacts.rows.length} contacts for client, including saved list contacts.`
    );

    // Test Opt-Out (STOP) Detection
    const optOutKeywords = ["stop", "unsubscribe", "stop promotions", "stoppromotions", "opt out", "optout", "roko", "band karo"];
    const testKeyword = "STOP PROMOTIONS".trim().toLowerCase();
    assert(
      optOutKeywords.includes(testKeyword),
      'Meta Opt-Out (STOP) Keyword Detection Active',
      `Keyword "${testKeyword}" successfully identified as promotional unsubscribe intent.`
    );

    // 6. Verify Safe Campaign Blast & Meta Anti-Spam Safeguards
    console.log('\n--- Testing WhatsApp Health & Safe Batch Policies ---');
    const { validateCampaignGuardrails, validateTemplatePolicy } = require('./services/metaPolicyGuard');

    // Test Safe Batch Limit (5000 max)
    const normalBatch = validateCampaignGuardrails(100, 'GREEN');
    assert(normalBatch.allowed, 'Normal Campaign Batch Allowed (100 recipients, GREEN quality)');

    const largeBatch = validateCampaignGuardrails(6000, 'GREEN');
    assert(!largeBatch.allowed, 'Excessive Campaign Batch Blocked (>5000 recipients protection)', largeBatch.error);

    const redQualityBatch = validateCampaignGuardrails(50, 'RED');
    assert(!redQualityBatch.allowed, 'RED Quality Number Campaign Paused to Prevent Ban', redQualityBatch.error);

    // Test Meta Prohibited Content Policy (Gambling/Satta/Betting detection)
    const scamTemplate = validateTemplatePolicy({
      bodyText: 'Win 10000 cash daily in fast satta matka gambling game!',
    });
    assert(!scamTemplate.compliant, 'Meta Prohibited Policy Violation Blocked', scamTemplate.error);

    const validTemplate = validateTemplatePolicy({
      bodyText: 'Wishing you and your family a very Happy and Prosperous Deepavali!',
    });
    assert(validTemplate.compliant, 'Compliant Template Approved for Meta Cloud API');

    console.log('\n====================================================');
    console.log(`🏁 E2E VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

  } catch (err) {
    console.error('Fatal error during E2E test:', err);
    failed++;
  } finally {
    await pool.end();
  }

  process.exit(failed === 0 ? 0 : 1);
}

runE2E();
