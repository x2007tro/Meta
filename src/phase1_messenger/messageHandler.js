// src/phase1_messenger/messageHandler.js
const { sendTextMessage, sendTypingOn, sendQuickReplies, sendAttachment } = require('./sendApi');
const { userReferrals } = require('./referralStore');
const config = require('../config');

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
 * Handle incoming message events
 */
async function handleMessage(senderId, messageEvent) {
  const referralRef = userReferrals.get(senderId);
  if (messageEvent.text) {
    await handleTextMessage(senderId, messageEvent.text, referralRef);
  } else if (messageEvent.attachments) {
    await sendTypingOn(senderId);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await sendTextMessage(senderId, "Thanks for the attachment! I'll get back to you shortly.");
  }
}

/**
 * Handle text messages with keyword routing
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
  if (['application', 'apply', 'form', 'application form'].some(kw => lowerText.includes(kw))) {
    if (propertyId) {
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
          reply = `Here is the application form for ${propertyId}. Please fill it out and send it back to us.${propertyContext}`;
        } else {
          // Fallback to link if attachment failed
          reply = `Here is the application form for ${propertyId}: ${formUrl}${propertyContext}`;
        }
      } else {
        reply = `Sorry, I couldn't find the application form for ${propertyId}.${propertyContext}`;
      }
    } else {
      reply = "I'd be happy to send you the application form! Which property are you interested in?";
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    await sendTextMessage(senderId, reply);
    return;
  }

  if (['hello', 'hi', 'hey'].includes(lowerText)) {
    reply = `Hi there! Thanks for reaching out. How can I help you today?${propertyContext}`;
  } else if (['price', 'cost', 'how much'].some(kw => lowerText.includes(kw))) {
    reply = "Please check the listing for pricing details. Feel free to ask any other questions!";
  } else if (['available', 'still for sale'].some(kw => lowerText.includes(kw))) {
    reply = "Yes, this item is still available! Would you like to arrange a viewing?";
  } else if (['address', 'location', 'where'].some(kw => lowerText.includes(kw))) {
    reply = "Please message us to arrange a convenient meeting location.";
  } else {
    reply = `Thanks for your message! We'll get back to you shortly.${propertyContext}`;
  }

  // 1 second delay for natural feel
  await new Promise(resolve => setTimeout(resolve, 1000));
  await sendTextMessage(senderId, reply);
}

module.exports = {
  handleMessage,
  handleTextMessage,
};