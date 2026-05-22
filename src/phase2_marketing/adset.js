// src/phase2_marketing/adset.js
const axios = require('axios');
const config = require('../config');

const BASE_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${config.AD_ACCOUNT_ID}`;

/**
 * Create an ad set
 */
async function createAdSet(campaignId, options) {
  try {
    const response = await axios.post(`${BASE_URL}/adsets`, {
      name: options.name,
      campaign_id: campaignId,
      optimization_goal: options.optimizationGoal || 'LINK_CLICKS',
      billing_event: options.billingEvent || 'IMPRESSIONS',
      bid_amount: options.bidAmountCents || 500,
      daily_budget: options.dailyBudgetCents || 1000,
      targeting: options.targeting,
      status: 'PAUSED',
      access_token: config.PAGE_ACCESS_TOKEN,
    });

    const adSetId = response.data.id;
    console.log(`[AdSet] Created ad set: ${adSetId}`);
    return adSetId;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[AdSet] createAdSet failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Convenience wrapper for Marketplace-targeted ad sets
 */
async function createMarketplaceAdSet(campaignId, options) {
  const targeting = {
    geo_locations: {
      countries: [options.country || 'CA'],
    },
    age_min: options.ageMin || 18,
    age_max: options.ageMax || 65,
    publisher_platforms: ['facebook'],
    facebook_positions: ['feed', 'marketplace'],
  };

  return createAdSet(campaignId, {
    name: options.name,
    dailyBudgetCents: options.dailyBudgetCents,
    targeting,
  });
}

module.exports = {
  createAdSet,
  createMarketplaceAdSet,
};