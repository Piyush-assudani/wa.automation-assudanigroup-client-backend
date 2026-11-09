/**
 * Meta WhatsApp Commerce & Messaging Policy Guardrails
 * Protects official WABA account from policy violations, spam penalties, and ban risks.
 */

// Strictly prohibited categories under Meta WhatsApp Business Policy
const PROHIBITED_PATTERNS = [
  // 1. Gambling, Betting, Casinos, Satta, Matka
  {
    category: "Gambling & Betting",
    regex: /\b(satta|matka|kalyan matka|betting|bet365|1xbet|parimatch|casino|roulette|teen patti cash|rummy cash|color prediction|lottery jackpot|gambling|fast satta)\b/i,
    reason: "WhatsApp Commerce Policy strictly forbids gambling, betting, lottery, and real-money gaming promotions. Promoting betting can lead to immediate WABA permanent ban.",
  },
  // 2. Adult Content, Dating, Escort Services
  {
    category: "Adult Services",
    regex: /\b(call girl|call girls|escort service|sex chat|porn|xxx|nude video|dating meet|adult massage)\b/i,
    reason: "Adult content and sexually explicit services are strictly prohibited under WhatsApp Commerce Policy.",
  },
  // 3. Narcotics, Drugs, Unlicensed Pharmaceuticals
  {
    category: "Drugs & Pharmaceuticals",
    regex: /\b(weed|ganja|charas|opium|cocaine|narcotics|viagra without prescription|buy steroids|cannabis oil)\b/i,
    reason: "WhatsApp prohibits marketing or sale of prescription medications, illegal drugs, and drug paraphernalia.",
  },
  // 4. Financial Fraud, Get-Rich-Quick, Fake Schemes
  {
    category: "Financial Scams & Fraud",
    regex: /\b(double your money in \d+|send \d+ get \d+|guaranteed 100% profit|crypto pump signal|binance hack|instant loan without kyc|lottery winner claim)\b/i,
    reason: "Deceptive financial schemes, get-rich-quick claims, and misleading investment advice violate Meta Fraud and Misrepresentation policies.",
  },
  // 5. Weapons, Firearms, Explosives
  {
    category: "Weapons & Explosives",
    regex: /\b(firearms|pistol sale|revolver sale|buy gun|ammunition|explosives|bomb making)\b/i,
    reason: "Weapons, ammunition, and explosives are completely prohibited on WhatsApp.",
  },
];

/**
 * Validates text for Meta Policy compliance
 * @param {string} text - The message body, header, or button text
 * @param {string} [context='Template'] - Where this text is being used
 * @returns {{ compliant: boolean, error?: string, category?: string }}
 */
function validateMetaContent(text, context = "Content") {
  if (!text || typeof text !== "string") {
    return { compliant: true };
  }

  for (const rule of PROHIBITED_PATTERNS) {
    const match = text.match(rule.regex);
    if (match) {
      return {
        compliant: false,
        category: rule.category,
        error: `Meta Policy Violation (${rule.category}): Found prohibited keyword "${match[0]}". ${rule.reason}`,
      };
    }
  }

  return { compliant: true };
}

/**
 * Validates full template components for policy compliance
 * @param {{ headerText?: string, bodyText: string, footerText?: string, buttons?: Array }} templateData
 */
function validateTemplatePolicy(templateData) {
  const { headerText = "", bodyText = "", footerText = "", buttons = [] } = templateData;

  // Check Header
  if (headerText) {
    const headerCheck = validateMetaContent(headerText, "Template Header");
    if (!headerCheck.compliant) return headerCheck;
  }

  // Check Body
  const bodyCheck = validateMetaContent(bodyText, "Template Body");
  if (!bodyCheck.compliant) return bodyCheck;

  // Check Footer
  if (footerText) {
    const footerCheck = validateMetaContent(footerText, "Template Footer");
    if (!footerCheck.compliant) return footerCheck;
  }

  // Check Buttons
  if (Array.isArray(buttons)) {
    for (const btn of buttons) {
      if (btn.text) {
        const btnCheck = validateMetaContent(btn.text, "Button Text");
        if (!btnCheck.compliant) return btnCheck;
      }
    }
  }

  return { compliant: true };
}

/**
 * Checks safety guardrails for campaign size & quality
 * @param {number} recipientCount - Total contacts to be messaged
 * @param {string} [qualityRating='GREEN'] - WhatsApp phone number quality
 */
function validateCampaignGuardrails(recipientCount, qualityRating = "GREEN") {
  // If phone quality is RED, block bulk marketing
  if (String(qualityRating).toUpperCase() === "RED") {
    return {
      allowed: false,
      error: "WhatsApp Account Protection: Sender number quality is currently marked as 'RED' by Meta. Mass marketing blasts are paused to protect your number from permanent suspension.",
    };
  }

  // Safeguard: Single blast limit
  const MAX_SINGLE_BLAST = 5000;
  if (recipientCount > MAX_SINGLE_BLAST) {
    return {
      allowed: false,
      error: `Campaign batch exceeds maximum safe limit (${recipientCount} > ${MAX_SINGLE_BLAST}). Please split large lists into smaller batches to preserve high delivery quality.`,
    };
  }

  return { allowed: true };
}

module.exports = {
  validateMetaContent,
  validateTemplatePolicy,
  validateCampaignGuardrails,
  PROHIBITED_PATTERNS,
};

