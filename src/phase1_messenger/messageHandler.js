// src/phase1_messenger/messageHandler.js
const { sendTextMessage, sendTypingOn, sendAttachment, sendQuickReplies } = require('./sendApi');
const { userReferrals } = require('./referralStore');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const config = require('../config');
const { handleRentalMessage } = require('./rentalBot');

// Active campaigns cache (5 minute TTL)
let campaignCache = { data: [], timestamp: 0, inflight: false };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch active campaigns from Meta Marketing API
 * Returns array of { campaignId, name } sorted by name
 */
async function getActiveCampaigns() {
  const now = Date.now();
  if (campaignCache.data.length && (now - campaignCache.timestamp) < CACHE_TTL_MS) {
    return campaignCache.data;
  }
  if (campaignCache.inflight) {
    return [];
  }

  const AD_ACCOUNT_ID = config.AD_ACCOUNT_ID;
  const AD_ACCOUNT_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${AD_ACCOUNT_ID}/campaigns`;

  try {
    campaignCache.inflight = true;
    const response = await axios.get(AD_ACCOUNT_URL, {
      params: {
        fields: 'id,name,status',
        statusing: { 'campaign.status': ['ACTIVE'] },
        access_token: config.PAGE_ACCESS_TOKEN,
      },
    });

    const campaigns = (response.data?.data || [])
      .filter(c => c.status === 'ACTIVE')
      // Exclude Marketplace listing campaigns (they start with '[')
      .filter(c => !c.name.startsWith('['))
      .map(c => ({ campaignId: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    campaignCache = { data: campaigns, timestamp: now, inflight: false };
    return campaigns;
  } catch (err) {
    campaignCache.inflight = false;
    console.error('[MessageHandler] getActiveCampaigns error:', err.response?.data || err.message);
    return [];
  }
}

/**
 * Get property display info from SQLite DB
 * Returns { num_bedroom, num_bathroom, city } or null
 */
function getPropertyDisplayFromDB(propertyId, unitId, callback) {
  const db = new sqlite3.Database('/root/.openclaw/workspace/Finance/finance.db');
  const sql = `SELECT num_bedroom, num_bathroom, city FROM properties_post WHERE property_id = ? AND unit_id = ?`;
  db.get(sql, [propertyId, unitId], (err, row) => {
    db.close();
    callback(row || null);
  });
}

/**
 * Build a lookup map from campaign names to display labels by querying DB once.
 */
function buildLabelMapFromDB(callback) {
  const db = new sqlite3.Database('/root/.openclaw/workspace/Finance/finance.db');
  const labelMap = {};
  db.all('SELECT property_id, unit_id, num_bedroom, num_bathroom, city FROM properties_post', [], (err, rows) => {
    if (err) { db.close(); callback({}); return; }
    rows.forEach(r => {
      const campaignName = r.property_id + '-' + r.unit_id;
      const br = Number(r.num_bedroom) || 0;
      const ba = Number(r.num_bathroom) || 0;
      const city = r.city || r.property_id;
      labelMap[campaignName] = `${br} bedroom ${ba} bathroom unit in ${city}`;
    });
    db.close();
    callback(labelMap);
  });
}

/**
 * Batch-fetch property displays for multiple campaigns using a single DB connection.
 */
function getPropertyDisplaysForCampaigns(campaigns, callback) {
  const db = new sqlite3.Database('/root/.openclaw/workspace/Finance/finance.db');
  const sql = `SELECT num_bedroom, num_bathroom, city FROM properties_post WHERE property_id = ? AND unit_id = ?`;
  const results = [];
  let pending = campaigns.length;

  if (pending === 0) { db.close(); callback([]); return; }

  campaigns.forEach(c => {
    const parsed = parseCampaignToDisplay(c.name);
    if (!parsed) {
      results.push({ campaign: c, display: null });
      pending--;
      if (pending === 0) { db.close(); callback(results); }
      return;
    }
    db.get(sql, [parsed.propertyId, parsed.unitId], (err, row) => {
      results.push({ campaign: c, display: row || null });
      pending--;
      if (pending === 0) { db.close(); callback(results); }
    });
  });
}

/**
 * Convert campaign name to referral ref format.
 * e.g., "McClure-MC-rear" → "PROPMcClure-UNITMC-rear"
 */
function campaignNameToReferral(campaignName) {
  const parsed = parseCampaignToDisplay(campaignName);
  if (!parsed) return null;
  return `PROP${parsed.propertyId}-UNIT${parsed.unitId}`;
}
/**
 * Parse campaign name (format: "property_id-unit_id") to extract parts.
 * e.g., "McClure-MC-rear" → { propertyId: "McClure", unitId: "MC-rear" }
 * Split on LAST dash to handle unit_ids with dashes (like "MC-rear")
 */
function parseCampaignToDisplay(campaignName) {
  if (!campaignName || !campaignName.includes('-')) return null;
  const lastDashIndex = campaignName.lastIndexOf('-');
  const propertyId = campaignName.substring(0, lastDashIndex);
  const unitId = campaignName.substring(lastDashIndex + 1);
  if (!propertyId || !unitId) return null;
  return { propertyId, unitId };
}

/**
 * Format display text: "3 bedroom 2 bathroom unit in Victoria"
 */
function formatPropertyLabel(propertyId, unitId, city, campaignName) {
  const dbRow = getPropertyDisplayFromDB(propertyId, unitId);
  if (dbRow) {
    const br = Number(dbRow.num_bedroom) || 0;
    const ba = Number(dbRow.num_bathroom) || 0;
    const cityText = dbRow.city || propertyId;
    return `${br} bedroom ${ba} bathroom unit in ${cityText}`;
  }
  // Fallback: use campaign name
  return campaignName;
}

/**
 * Send property selection quick-replies to user
 */
async function sendPropertyOptions(senderId, campaigns) {
  const limited = campaigns.slice(0, 10);

  // Build label map from DB, then map campaigns to labels
  const labelMap = await new Promise((resolve) => {
    buildLabelMapFromDB(resolve);
  });

  const replies = limited.map(c => {
    const label = labelMap[c.name] || c.name;
    return {
      content_type: 'text',
      title: label,
      payload: c.name,
    };
  });

  await sendQuickReplies(
    senderId,
    "Which property are you interested in?",
    replies
  );
}

/**
 * Extract property_id from referral ref.
 * Supports PROP format (PROPStMary-UNITSM-01 → StMary) and
 * direct campaign name format (McClure-MC-rear → McClure)
 */
function getPropertyIdFromRef(referralRef) {
  if (!referralRef) return null;
  // PROP format
  const propMatch = referralRef.match(/PROP(.+?)-UNIT/);
  if (propMatch) return propMatch[1];
  // Direct campaign name format — everything before the last dash
  const parts = referralRef.split('-');
  if (parts.length >= 2) {
    return parts.slice(0, -1).join('-');
  }
  return null;
}

/**
 * Find the first PDF file in a property's application folder
 */
function findApplicationForm(propertyId) {
  const folder = `/root/.openclaw/workspace/RealEstate/application_forms/${propertyId}`;
  const fs = require('fs');
  try {
    const files = fs.readdirSync(folder);
    const pdf = files.find(f => f.toLowerCase().endsWith('.pdf'));
    return pdf ? `${folder}/${pdf}` : null;
  } catch {
    return null;
  }
}

/**
 * Get application form URL for a property
 * Returns file path for local serving
 */
function getApplicationFormPath(propertyId) {
  return findApplicationForm(propertyId);
}

/**
 * Check if a referral ref is a rental property referral.
 * Accepts PROP prefix (PROPMcClure-UNITMC-rear) or direct campaign name (McClure-MC-rear)
 */
function isRentalReferral(ref) {
  if (!ref) return false;
  // PROP format
  if (ref.startsWith('PROP') && ref.includes('-UNIT')) return true;
  // Direct campaign name format (contains dash but not starting with PROP)
  if (ref.includes('-') && !ref.startsWith('PROP')) return true;
  return false;
}

/**
 * Send listing interest question (Yes/No quick-reply)
 */
async function sendListingInterestQuestion(senderId) {
  await sendQuickReplies(
    senderId,
    "Are you interested in a specific listing?",
    [
      { content_type: 'text', title: 'Yes', payload: 'listing_interest_yes' },
      { content_type: 'text', title: 'No', payload: 'listing_interest_no' },
    ]
  );
}

/**
 * Handle incoming message events
 */
async function handleMessage(senderId, messageEvent) {
  const referralRef = userReferrals.get(senderId);

  // If it's a rental property referral, delegate to rental bot
  if (referralRef && isRentalReferral(referralRef)) {
    await handleRentalMessage(senderId, messageEvent);
    return;
  }

  // No referral — check for active campaigns
  if (messageEvent.text || messageEvent.quick_reply) {
    const campaigns = await getActiveCampaigns();

    // Check quick-reply for listing interest
    const quickReplyPayload = messageEvent.quick_reply?.payload;
    if (quickReplyPayload === 'listing_interest_yes') {
      // User said yes to listing interest — show property options
      await sendTypingOn(senderId);
      await sendPropertyOptions(senderId, campaigns);
      return;
    }
    if (quickReplyPayload === 'listing_interest_no') {
      // User said no — generic response
      await sendTypingOn(senderId);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sendTextMessage(senderId, "Thanks! Takashi will respond to you within 24 hours.");
      return;
    }

    if (campaigns.length > 0) {
      // Check if this is a property quick-reply selection
      if (quickReplyPayload && campaigns.find(c => c.name === quickReplyPayload)) {
        userReferrals.set(senderId, quickReplyPayload);
        await handleRentalMessage(senderId, messageEvent);
        return;
      }

      // Not a campaign match and no prior interest question — ask if interested
      await sendTypingOn(senderId);
      await sendListingInterestQuestion(senderId);
      return;
    }
  }

  // No active campaigns — fall through to generic response
  if (messageEvent.text) {
    await handleTextMessage(senderId, messageEvent.text, referralRef);
  } else if (messageEvent.attachments) {
    await sendTypingOn(senderId);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await sendTextMessage(senderId, "Thanks for the attachment! Takashi will respond to you within 24 hours.");
  }
}

/**
 * Handle text messages with keyword routing (non-rental fallback)
 */
async function handleTextMessage(senderId, text, referralRef = null) {
  const lowerText = text.toLowerCase().trim();
  const propertyId = getPropertyIdFromRef(referralRef);

  // Show typing indicator
  await sendTypingOn(senderId);

  let reply;

  // Include property reference if available
  const propertyContext = referralRef ? ` [Re: ${referralRef}]` : '';

  // Handle application form requests
  if (propertyId && ['application', 'apply', 'form', 'application form'].some(kw => lowerText.includes(kw))) {
    // Send typing then delay for attachment upload
    await sendTypingOn(senderId);
    await new Promise(resolve => setTimeout(resolve, 500));

    const formPath = getApplicationFormPath(propertyId);
    console.log(`[MessageHandler] Found application form for ${propertyId}: ${formPath}`);

    if (formPath) {
      // Use public URL for Messenger attachment (must be HTTPS publicly accessible)
      const formUrl = `${config.APP_URL}/application_forms/${propertyId}/Rental%20Application%20-%20${propertyId}.pdf`;
      console.log(`[MessageHandler] Sending attachment: ${formUrl}`);

      // Send as Messenger attachment
      const attachmentResult = await sendAttachment(senderId, 'file', formUrl);

      if (attachmentResult?.message_id) {
        reply = `Here is the application form for ${propertyId}. Please fill it out and send it back to us. Takashi will respond to you within 24 hours.${propertyContext}`;
      } else {
        // Fallback to link if attachment failed
        reply = `Here is the application form for ${propertyId}: ${formUrl}. Takashi will respond to you within 24 hours.${propertyContext}`;
      }
    } else {
      reply = `Sorry, I couldn't find the application form for ${propertyId}. Takashi will respond to you within 24 hours.${propertyContext}`;
    }
  } else {
    // No keyword matching - generic response for all other messages
    reply = `Thanks for your message! Takashi will respond to you within 24 hours.${propertyContext}`;
  }

  // 1 second delay for natural feel
  await new Promise(resolve => setTimeout(resolve, 1000));
  await sendTextMessage(senderId, reply);
}

module.exports = {
  handleMessage,
  handleTextMessage,
};