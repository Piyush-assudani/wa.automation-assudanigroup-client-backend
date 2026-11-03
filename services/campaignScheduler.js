const db = require("../db");
const { processCampaign } = require("./campaignProcessor");
const { getTemplates } = require("./metaApi");

let schedulerInterval = null;

const startCampaignScheduler = (io) => {
  if (schedulerInterval) return;

  console.log("⏱️ Starting Scheduled Campaigns Background Worker (running every 30s)...");

  schedulerInterval = setInterval(async () => {
    try {
      // Find campaigns whose scheduled_at has arrived and are still 'scheduled'
      const dueCampaigns = await db.query(`
        SELECT c.*, u.whatsapp_mode, u.meta_phone_number_id, u.meta_access_token, u.meta_waba_id
        FROM public.campaigns c
        LEFT JOIN public.users u ON c.user_id = u.id
        WHERE c.status = 'scheduled' AND c.scheduled_at <= NOW()
        ORDER BY c.scheduled_at ASC
        LIMIT 5;
      `);

      if (dueCampaigns.rows.length === 0) return;

      for (const campaign of dueCampaigns.rows) {
        console.log(`🚀 Dispatching scheduled campaign: "${campaign.name}" (ID: ${campaign.id})`);

        // Mark as processing immediately so it is not picked up again
        await db.query("UPDATE public.campaigns SET status = 'processing' WHERE id = $1", [campaign.id]);

        try {
          // Fetch contacts for this campaign's list
          const membersResult = await db.query(
            `SELECT DISTINCT c.id, c.phone_number, c.name, c.city
             FROM contact_list_members clm
             JOIN contacts c ON clm.contact_id = c.id
             WHERE clm.list_id = $1`,
            [campaign.contact_list_id]
          );

          if (membersResult.rows.length === 0) {
            await db.query("UPDATE public.campaigns SET status = 'failed' WHERE id = $1", [campaign.id]);
            continue;
          }

          // Template & param resolution
          let resolvedLanguageCode = "en_US";
          let paramCount = 0;
          try {
            const templates = await getTemplates();
            const tpl = (templates || []).find((t) => t.name === campaign.template_name);
            if (tpl) {
              if (tpl.language) resolvedLanguageCode = tpl.language;
              const bodyComponent = tpl.components?.find((c) => c.type === "BODY");
              if (bodyComponent && bodyComponent.text) {
                const matches = bodyComponent.text.match(/\{\{\d+\}\}/g);
                if (matches) paramCount = new Set(matches).size;
              }
            }
          } catch (e) {}

          const messages = membersResult.rows.map((member) => {
            const bodyParams = [];
            if (paramCount >= 1) bodyParams.push({ type: "text", text: member.name || "Customer" });
            if (paramCount >= 2) bodyParams.push({ type: "text", text: member.city || "Valued Client" });
            for (let i = 2; i < paramCount; i++) bodyParams.push({ type: "text", text: "Update" });

            return {
              to: member.phone_number ? String(member.phone_number).replace(/\D/g, "") : "",
              contactId: member.id,
              bodyParams,
            };
          });

          // Meta config resolution for sender
          let customMetaConfig = null;
          if (campaign.whatsapp_mode === "personal" && campaign.meta_phone_number_id && campaign.meta_access_token) {
            customMetaConfig = {
              phoneId: campaign.meta_phone_number_id,
              token: campaign.meta_access_token,
              wabaId: campaign.meta_waba_id,
            };
          }

          await processCampaign(
            messages,
            campaign.id,
            campaign.template_name,
            resolvedLanguageCode,
            io,
            campaign.media_id,
            campaign.media_type,
            campaign.media_url,
            customMetaConfig
          );

          await db.query("UPDATE public.campaigns SET status = 'completed' WHERE id = $1", [campaign.id]);
          console.log(`✅ Scheduled campaign "${campaign.name}" dispatched successfully!`);
        } catch (dispatchErr) {
          console.error(`❌ Failed dispatching scheduled campaign ${campaign.id}:`, dispatchErr);
          await db.query("UPDATE public.campaigns SET status = 'failed' WHERE id = $1", [campaign.id]);
        }
      }
    } catch (err) {
      console.error("Scheduled campaigns worker error:", err.message);
    }
  }, 30000);
};

module.exports = { startCampaignScheduler };

