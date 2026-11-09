const express = require("express");
const router = express.Router();
const db = require("../db");
const { downloadMediaFromMeta } = require("../services/metaApi");
const { uploadBufferToCloudinary } = require("../services/cloudinaryService");
const { invalidateDashboardCache } = require("./dashboard");

// Status hierarchy — higher number = more progressed
const STATUS_PRIORITY = {
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};



router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed");
  return res.status(403).json({ error: "Verification failed" });
});



router.post("/", async (req, res) => {
  // Always respond 200 immediately to Meta
  res.status(200).json({ status: "received" });

  try {
    const body = req.body;

    // Log the entire webhook payload for debugging
    try {
      await db.query('INSERT INTO webhook_logs (payload) VALUES ($1)', [JSON.stringify(body)]);
    } catch (logErr) {
      console.error("Failed to insert webhook log:", logErr);
    }

    if (!body.object || !body.entry) {
      return;
    }

    // Process ALL entries and ALL changes (not just the first one)
    for (const entry of body.entry) {
      if (!entry.changes) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (!value) continue;

        // ─── Handle incoming messages ───
        if (value.messages && value.messages.length > 0) {
          for (const message of value.messages) {
            try {
              const from = message.from;
              const wamid = message.id;
              const suppliedTimestamp = Number(message.timestamp);
              const timestamp =
                Number.isFinite(suppliedTimestamp) && suppliedTimestamp > 0
                  ? suppliedTimestamp >= 1e12
                    ? suppliedTimestamp / 1000
                    : suppliedTimestamp
                  : Date.now() / 1000;

              if (!Number.isFinite(suppliedTimestamp) || suppliedTimestamp <= 0) {
                console.warn(`⚠️ Invalid inbound timestamp for ${wamid}; using webhook receive time`);
              }

              let messageBody = "";
              let mediaUrl = null;
              let mediaIdToDownload = null;
              let resourceType = "auto";

              if (message.type === "text" && message.text) {
                messageBody = message.text.body;
              } else if (message.type === "image") {
                messageBody = "[Image]";
                mediaIdToDownload = message.image.id;
                resourceType = "image";
              } else if (message.type === "video") {
                messageBody = "[Video]";
                mediaIdToDownload = message.video.id;
                resourceType = "video";
              } else if (message.type === "audio") {
                messageBody = "[Audio]";
                mediaIdToDownload = message.audio.id;
                resourceType = "video";
              } else if (message.type === "document") {
                messageBody = "[Document]";
                mediaIdToDownload = message.document.id;
                resourceType = "raw";
              } else if (message.type === "location") {
                messageBody = "[Location]";
              } else if (message.type === "sticker") {
                messageBody = "[Sticker]";
                mediaIdToDownload = message.sticker.id;
                resourceType = "image";
              } else if (message.type === "interactive") {
                if (message.interactive.type === "button_reply") {
                  messageBody = message.interactive.button_reply.title || message.interactive.button_reply.id;
                } else if (message.interactive.type === "list_reply") {
                  messageBody = message.interactive.list_reply.title || message.interactive.list_reply.id;
                } else {
                  messageBody = "[Interactive Response]";
                }
              } else if (message.type === "button") {
                messageBody = message.button?.text || message.button?.payload || "Thank You";
              } else if (message.type === "reaction") {
                messageBody = message.reaction?.emoji || "👍";
              } else {
                messageBody = `[${message.type || "Unknown"}]`;
              }

              // Download & upload media if present
              if (mediaIdToDownload) {
                try {
                  const mediaData = await downloadMediaFromMeta(mediaIdToDownload);
                  if (mediaData && mediaData.buffer) {
                    mediaUrl = await uploadBufferToCloudinary(mediaData.buffer, "wp_automation/inbound", resourceType);
                  }
                } catch (mediaErr) {
                  console.error("❌ Failed to process inbound media:", mediaErr);
                }
              }

              // Get contact name from webhook payload
              let contactName = null;
              if (value.contacts && value.contacts.length > 0) {
                const contactInfo = value.contacts.find((c) => c.wa_id === from);
                if (contactInfo && contactInfo.profile) {
                  contactName = contactInfo.profile.name;
                }
              }

              // Determine client ownership for inbound message (Strict Multi-Tenant Routing)
              let assignedUserId = null;
              const existingContact = await db.query(
                "SELECT id, name, user_id FROM contacts WHERE phone_number = $1",
                [from]
              );

              if (existingContact.rows.length > 0 && existingContact.rows[0].user_id) {
                assignedUserId = existingContact.rows[0].user_id;
              } else {
                // If contact is not yet assigned, check if any client recently messaged this number via campaigns
                const lastSender = await db.query(
                  `SELECT cmp.user_id 
                   FROM messages m 
                   JOIN campaigns cmp ON m.campaign_id = cmp.id 
                   JOIN contacts c ON m.contact_id = c.id 
                   WHERE c.phone_number = $1 
                   ORDER BY m.timestamp DESC NULLS LAST 
                   LIMIT 1`,
                  [from]
                );

                if (lastSender.rows.length > 0 && lastSender.rows[0].user_id) {
                  assignedUserId = lastSender.rows[0].user_id;
                } else {
                  // Fallback: Check if this phone number is inside any client's contact list
                  const listOwner = await db.query(
                    `SELECT cl.user_id 
                     FROM contact_list_members clm 
                     JOIN contact_lists cl ON clm.list_id = cl.id 
                     WHERE clm.phone = $1 OR clm.phone = $2 
                     ORDER BY clm.created_at DESC 
                     LIMIT 1`,
                    [from, from.replace(/^91/, "")]
                  );
                  if (listOwner.rows.length > 0 && listOwner.rows[0].user_id) {
                    assignedUserId = listOwner.rows[0].user_id;
                  }
                }
              }

              // Upsert contact with determined client user_id (or NULL for unprompted direct strangers)
              const contactResult = await db.query(
                `INSERT INTO contacts (phone_number, name, user_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (phone_number)
                 DO UPDATE SET 
                   name = COALESCE($2, contacts.name),
                   user_id = COALESCE(contacts.user_id, EXCLUDED.user_id)
                 RETURNING id, phone_number, name, user_id`,
                [from, contactName, assignedUserId]
              );
              const contact = contactResult.rows[0];

              // Meta Marketing Opt-Out (STOP) & Opt-In (START) Detection
              const cleanText = (messageBody || "").trim().toLowerCase();
              const OPT_OUT_KEYWORDS = ["stop", "unsubscribe", "stop promotions", "stoppromotions", "opt out", "optout", "roko", "band karo"];
              const OPT_IN_KEYWORDS = ["start", "unstop", "subscribe", "opt in", "optin", "chalu karo"];

              if (OPT_OUT_KEYWORDS.includes(cleanText)) {
                await db.query(
                  "UPDATE contacts SET is_opted_out = TRUE, opted_out_at = NOW() WHERE id = $1",
                  [contact.id]
                );
                console.log(`🛑 Contact ${from} requested Opt-Out (STOP). Marked as opted-out.`);
              } else if (OPT_IN_KEYWORDS.includes(cleanText)) {
                await db.query(
                  "UPDATE contacts SET is_opted_out = FALSE, opted_out_at = NULL WHERE id = $1",
                  [contact.id]
                );
                console.log(`✅ Contact ${from} requested Opt-In (START). Resumed.`);
              }

              // Save the message
              const msgResult = await db.query(
                `INSERT INTO messages (contact_id, direction, message_body, media_url, meta_message_id, status, timestamp)
                 VALUES ($1, 'inbound', $2, $3, $4, 'delivered', to_timestamp($5::numeric))
                 RETURNING *`,
                [contact.id, messageBody, mediaUrl, wamid, timestamp]
              );

              const savedMessage = msgResult.rows[0];

              // Emit via Socket.IO with multi-tenant contact_user_id
              const io = req.app.get("io");
              if (io) {
                invalidateDashboardCache();
                io.emit("new_message", {
                  id: savedMessage.id,
                  contact_id: contact.id,
                  contact_phone: contact.phone_number,
                  contact_name: contact.name,
                  contact_user_id: contact.user_id,
                  direction: "inbound",
                  message_body: messageBody,
                  media_url: mediaUrl,
                  meta_message_id: wamid,
                  status: "delivered",
                  timestamp: savedMessage.timestamp,
                });
              }

              console.log(`📥 Inbound message from ${from}: "${messageBody.substring(0, 50)}"`);
            } catch (msgErr) {
              console.error("❌ Error processing individual inbound message:", msgErr);
            }
          }
        }

        // ─── Handle status updates (sent / delivered / read / failed) ───
        if (value.statuses && value.statuses.length > 0) {
          for (const status of value.statuses) {
            try {
              const metaMessageId = status.id;
              const newStatus = status.status;
              const recipientId = status.recipient_id;

              if (!["sent", "delivered", "read", "failed"].includes(newStatus)) {
                console.log(`⚠️ Unknown status "${newStatus}" for ${metaMessageId}, skipping`);
                continue;
              }

              // Only upgrade status, never downgrade
              // e.g., don't go from "read" back to "delivered"
              const existing = await db.query(
                `SELECT status FROM messages WHERE meta_message_id = $1`,
                [metaMessageId]
              );

              if (existing.rows.length === 0) {
                console.log(`⚠️ No message found for wamid ${metaMessageId} (status: ${newStatus})`);
                continue;
              }

              const currentStatus = existing.rows[0].status;
              const currentPriority = STATUS_PRIORITY[currentStatus] ?? -1;
              const newPriority = STATUS_PRIORITY[newStatus] ?? -1;

              // Special case: "failed" always overrides
              if (newStatus !== "failed" && newPriority <= currentPriority) {
                console.log(`ℹ️ Skipping status downgrade: ${currentStatus} → ${newStatus} for ${metaMessageId}`);
                continue;
              }

              // Extract error message if failed
              let errorMsg = null;
              if (newStatus === "failed" && status.errors && status.errors.length > 0) {
                const errObj = status.errors[0];
                const details = errObj.error_data?.details;
                const baseMsg = errObj.message || errObj.title || "Unknown error";
                errorMsg = details ? `${baseMsg} (${details})` : baseMsg;
              }

              await db.query(
                `UPDATE messages SET status = $1, error_message = COALESCE($3, error_message) WHERE meta_message_id = $2`,
                [newStatus, metaMessageId, errorMsg]
              );

              // Auto-refund message fund if message delivery failed at Meta
              if (newStatus === "failed") {
                try {
                  const txCheck = await db.query(
                    `SELECT wt.id, wt.user_id 
                     FROM public.wallet_transactions wt
                     JOIN public.messages m ON wt.message_id = m.id
                     WHERE m.meta_message_id = $1 AND wt.type = 'debit' AND wt.status = 'completed'
                     LIMIT 1`,
                    [metaMessageId]
                  );
                  if (txCheck.rows.length > 0) {
                    const { refundMessageFund } = require("./billing");
                    await refundMessageFund(txCheck.rows[0].user_id, txCheck.rows[0].id, errorMsg || "Meta delivery failed");
                    console.log(`💰 Auto-refunded wallet transaction for failed message ${metaMessageId}`);
                  }
                } catch (rErr) {
                  console.warn("Notice: refund hook skipped:", rErr.message);
                }
              }

              console.log(`📊 Status updated: ${currentStatus} → ${newStatus} for ${recipientId} (${metaMessageId})${errorMsg ? ` [${errorMsg}]` : ''}`);

              // Emit via Socket.IO for real-time tick updates
              const io = req.app.get("io");
              if (io) {
                invalidateDashboardCache();
                io.emit("message_status", {
                  meta_message_id: metaMessageId,
                  status: newStatus,
                  recipient: recipientId,
                });
              }
            } catch (statusErr) {
              console.error("❌ Error processing individual status update:", statusErr);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});


module.exports = router;
