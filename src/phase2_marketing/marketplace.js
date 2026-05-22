// src/phase2_marketing/marketplace.js
const campaign = require('./campaign');
const adset = require('./adset');
const ad = require('./ad');

/**
 * Create a full Marketplace campaign (Campaign → Ad Set → Ad)
 */
async function createMarketplaceCampaign(config) {
  try {
    // Step 1: Create campaign
    const campaignId = await campaign.createCampaign({
      name: config.campaignName,
      objective: config.objective,
      specialAdCategories: config.specialAdCategories || [],
    });
    console.log(`[Marketplace] Step 1/5: Campaign created: ${campaignId}`);

    // Step 2: Create ad set
    const adSetId = await adset.createMarketplaceAdSet(campaignId, {
      name: config.adSetName,
      dailyBudgetCents: config.dailyBudgetCents,
      country: config.country,
      ageMin: config.ageMin,
      ageMax: config.ageMax,
    });
    console.log(`[Marketplace] Step 2/5: Ad set created: ${adSetId}`);

    // Step 3: Upload image
    const imageHash = await ad.uploadImage(config.imageFilePath);
    console.log(`[Marketplace] Step 3/5: Image uploaded, hash: ${imageHash}`);

    // Step 4: Create ad creative
    const creativeId = await ad.createAdCreative({
      name: `${config.adName} (Creative)`,
      destinationUrl: config.destinationUrl,
      primaryText: config.primaryText,
      headline: config.headline,
      description: config.description,
      imageHash,
      ref: config.ref,
    });
    console.log(`[Marketplace] Step 4/5: Ad creative created: ${creativeId}`);

    // Step 5: Create ad
    const adId = await ad.createAd(adSetId, creativeId, {
      name: config.adName,
    });
    console.log(`[Marketplace] Step 5/5: Ad created: ${adId}`);

    return { campaignId, adSetId, creativeId, adId };
  } catch (err) {
    console.error(`[Marketplace] Error in createMarketplaceCampaign at step: ${err.step}`, err);
    throw err;
  }
}

/**
 * Activate a campaign (set status to ACTIVE)
 */
async function activateCampaign(campaignId) {
  await campaign.updateCampaignStatus(campaignId, 'ACTIVE');
  console.log('[Marketplace] Campaign activated. Monitor spend in Meta Ads Manager.');
}

/**
 * Pause a campaign (set status to PAUSED)
 */
async function pauseCampaign(campaignId) {
  await campaign.updateCampaignStatus(campaignId, 'PAUSED');
  console.log(`[Marketplace] Campaign ${campaignId} paused.`);
}

module.exports = {
  createMarketplaceCampaign,
  activateCampaign,
  pauseCampaign,
};