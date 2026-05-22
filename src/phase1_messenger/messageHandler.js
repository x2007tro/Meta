// src/phase1_messenger/messageHandler.js
const { sendTextMessage, sendTypingOn, sendAttachment } = require('./sendApi');
const { userReferrals } = require('./referralStore');
const config = require('../config');
const { handleRentalMessage } = require('./rentalBot');

/**
 * Extract property_id from referral ref (e.g., "PROPStMary-UNITSM-01" → "StMary")
 */
function getPropertyIdFromRef(referralRef) {
  if (!referralRef) return null;
  const match = referralRef.match(/PROP(.+?)-UNIT/);
  return match ? match[1] : null;
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
 * Check if a referral ref looks like a rental property referral
 * vs other types of referrals
 */
function isRentalReferral(ref) {
  return ref && ref.startsWith('PROP') && ref.includes('-UNIT');
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

  // Otherwise fall through to existing keyword routing
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