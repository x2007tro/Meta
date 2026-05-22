// src/phase2_marketing/campaign.js
const axios = require('axios');
const config = require('../config');

const BASE_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${config.AD_ACCOUNT_ID}`;

/**
 * Create a new ad campaign
 */
async function createCampaign(options) {
  try {
    const response = await axios.post(`${BASE_URL}/campaigns`, {
      name: options.name,
      objective: options.objective,
      status: 'PAUSED',
      special_ad_categories: options.specialAdCategories || [],
      is_adset_budget_sharing_enabled: false,
      access_token: config.PAGE_ACCESS_TOKEN,
    });

    const campaignId = response.data.id;
    console.log(`[Campaign] Created campaign: ${campaignId}`);
    return campaignId;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Campaign] createCampaign failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Get campaign details
 */
async function getCampaign(campaignId) {
  try {
    const response = await axios.get(`${BASE_URL.replace(config.AD_ACCOUNT_ID, campaignId)}`, {
      params: {
        fields: 'id,name,objective,status,created_time',
        access_token: config.PAGE_ACCESS_TOKEN,
      },
    });
    return response.data;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Campaign] getCampaign failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Update campaign status
 */
async function updateCampaignStatus(campaignId, status) {
  try {
    const response = await axios.post(`${BASE_URL.replace(config.AD_ACCOUNT_ID, campaignId)}`, {
      status,
      access_token: config.PAGE_ACCESS_TOKEN,
    });
    console.log(`[Campaign] Updated campaign ${campaignId} to status: ${status}`);
    return response.data;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Campaign] updateCampaignStatus failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

module.exports = {
  createCampaign,
  getCampaign,
  updateCampaignStatus,
};