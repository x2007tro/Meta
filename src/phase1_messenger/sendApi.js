// src/phase1_messenger/sendApi.js
const axios = require('axios');
const config = require('../config');

const BASE_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${config.PAGE_ID}`;

/**
 * Send a text message to a recipient
 */
async function sendTextMessage(recipientId, text) {
  try {
    const response = await axios.post(`${BASE_URL}/messages`, {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }, {
      headers: {
        Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error('[SendAPI] sendTextMessage error:', err.response?.data || err.message);
  }
}

/**
 * Send typing indicator on
 */
async function sendTypingOn(recipientId) {
  try {
    const response = await axios.post(`${BASE_URL}/messages`, {
      recipient: { id: recipientId },
      sender_action: 'typing_on',
    }, {
      headers: {
        Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error('[SendAPI] sendTypingOn error:', err.response?.data || err.message);
  }
}

/**
 * Send quick reply buttons
 * @param {string} recipientId
 * @param {string} text
 * @param {Array<{content_type: string, title: string, payload: string}>} replies
 */
async function sendQuickReplies(recipientId, text, replies) {
  try {
    const response = await axios.post(`${BASE_URL}/messages`, {
      recipient: { id: recipientId },
      message: {
        text,
        quick_replies: replies,
      },
      messaging_type: 'RESPONSE',
    }, {
      headers: {
        Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error('[SendAPI] sendQuickReplies error:', err.response?.data || err.message);
  }
}

/**
 * Send file attachment (PDF, image, video, audio)
 * @param {string} recipientId
 * @param {'file'|'image'|'video'|'audio'} fileType
 * @param {string} url - publicly accessible HTTPS URL to the file
 */
async function sendAttachment(recipientId, fileType, url) {
  try {
    const response = await axios.post(`${BASE_URL}/messages`, {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: fileType,
          payload: { url },
        },
      },
      messaging_type: 'RESPONSE',
    }, {
      headers: {
        Authorization: `Bearer ${config.PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error('[SendAPI] sendAttachment error:', err.response?.data || err.message);
  }
}

module.exports = {
  sendTextMessage,
  sendTypingOn,
  sendQuickReplies,
  sendAttachment,
};