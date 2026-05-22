// src/phase2_marketing/auth.js
const axios = require('axios');
const config = require('../config');

const BASE_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}`;

/**
 * Inspect a token and return its metadata
 */
async function inspectToken(accessToken) {
  try {
    const response = await axios.get(`${BASE_URL}/debug_token`, {
      params: {
        input_token: accessToken,
        access_token: `${config.APP_ID}|${config.APP_SECRET}`,
      },
    });

    const data = response.data.data;
    const expiresAt = data.expires_at ? new Date(data.expires_at * 1000) : null;

    // Warn if token expires within 7 days
    if (expiresAt) {
      const daysUntilExpiry = (expiresAt - new Date()) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry < 7) {
        console.warn(`[Auth] Warning: Token expires in ${Math.round(daysUntilExpiry)} days`);
      }
    }

    return {
      is_valid: data.is_valid,
      expires_at: expiresAt,
      scopes: data.scopes,
    };
  } catch (err) {
    console.error('[Auth] inspectToken error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Exchange a short-lived token for a long-lived token
 */
async function getLongLivedToken(shortLivedToken) {
  try {
    const response = await axios.get(`${BASE_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.APP_ID,
        client_secret: config.APP_SECRET,
        fb_exchange_token: shortLivedToken,
      },
    });

    return response.data;
  } catch (err) {
    console.error('[Auth] getLongLivedToken error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  inspectToken,
  getLongLivedToken,
};