// src/phase1_messenger/webhook.js
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { handleMessage } = require('./messageHandler');

const router = express.Router();

const { userReferrals } = require('./referralStore');

/**
 * Validate X-Hub-Signature-256 header
 */
function validateSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', config.APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * GET /webhook - Webhook verification
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[Webhook] GET - mode: ${mode}, token: ${token}, challenge: ${challenge}`);
  console.log(`[Webhook] Expected token: ${config.VERIFY_TOKEN}`);

  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    console.log('[Webhook] Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Verification failed - token mismatch');
  return res.status(403).send('Forbidden');
});

/**
 * POST /webhook - Receive events
 */
router.post('/', (req, res) => {
  // Validate signature
  if (!validateSignature(req)) {
    console.warn('[Webhook] Invalid signature - rejecting request');
    return res.status(401).send('Unauthorized');
  }

  const body = req.body;

  // Always respond 200 quickly to prevent Meta retries
  res.status(200).send('OK');

  // Process entries
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const messagingEvent of entry.messaging || []) {
      // Handle referral events (from click on ad with ref parameter)
      if (messagingEvent.referral) {
        const senderId = messagingEvent.sender?.id;
        const referral = messagingEvent.referral;
        if (senderId) {
          console.log(`[Webhook] Referral from ${senderId}: ref=${referral.ref}, source=${referral.source}`);
          // Store referral info for context in next message
          // The referral ref (e.g., PROP001-UNIT001) is now associated with this user
          handleReferral(senderId, referral).catch(err => {
            console.error('[Webhook] handleReferral error:', err);
          });
        }
        continue;
      }

      // Skip echoes
      if (messagingEvent.message?.is_echo) continue;

      // Skip delivery/read receipts (no text or attachments)
      const message = messagingEvent.message;
      if (!message?.text && !message?.attachments) continue;

      const senderId = messagingEvent.sender?.id;
      if (!senderId) continue;

      // Handle asynchronously
      handleMessage(senderId, message).catch(err => {
        console.error('[Webhook] handleMessage error:', err);
      });
    }
  }
});

/**
 * Handle referral events from ad clicks
 */
async function handleReferral(senderId, referral) {
  // Store the referral ref associated with this sender
  if (referral.ref) {
    userReferrals.set(senderId, referral.ref);
    console.log(`[Webhook] Stored referral for ${senderId}: ref=${referral.ref}`);
  }
  console.log(`[Webhook] Referral from ${senderId}: ref=${referral.ref}, source=${referral.source}`);
}

/**
 * Get the referral ref for a sender (if any)
 */
function getReferralRef(senderId) {
  return userReferrals.get(senderId);
}

module.exports = {
  router,
  getReferralRef,
  userReferrals,
};