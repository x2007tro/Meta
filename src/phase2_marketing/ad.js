// src/phase2_marketing/ad.js
const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');
const fs = require('fs');

const BASE_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/${config.AD_ACCOUNT_ID}`;

/**
 * Upload a single image and return its hash
 */
async function uploadImage(imageFilePath) {
  try {
    const form = FormData();
    form.append('file', fs.createReadStream(imageFilePath));

    const response = await axios.post(`${BASE_URL}/adimages`, form, {
      params: {
        access_token: config.PAGE_ACCESS_TOKEN,
      },
      headers: {
        'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}`,
      },
    });

    const imageHash = Object.values(response.data.images)[0]?.hash;
    console.log(`[Ad] Uploaded image, hash: ${imageHash}`);
    return imageHash;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Ad] uploadImage failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Upload multiple images and return array of hashes
 */
async function uploadImages(imageFilePaths) {
  const hashes = [];
  for (const imageFilePath of imageFilePaths) {
    try {
      const form = FormData();
      form.append('file', fs.createReadStream(imageFilePath));

      const response = await axios.post(`${BASE_URL}/adimages`, form, {
        params: {
          access_token: config.PAGE_ACCESS_TOKEN,
        },
        headers: {
          'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}`,
        },
      });

      const imageHash = Object.values(response.data.images)[0]?.hash;
      if (imageHash) {
        hashes.push(imageHash);
        console.log(`[Ad] Uploaded image, hash: ${imageHash}`);
      }
    } catch (err) {
      console.error(`[Ad] uploadImage ${imageFilePath} failed:`, err.response?.data?.error || err.message);
    }
  }
  return hashes;
}

/**
 * Create carousel ad creative with multiple images
 */
async function createCarouselAdCreative(options) {
  try {
    console.log('[Ad] Creating carousel with', options.imageHashes.length, 'images');
    console.log('[Ad] Cards:', JSON.stringify(options.imageHashes));

    // Build child attachments - carousel requires 2-10 items
    const cards = options.imageHashes.slice(0, 10).map((hash, i) => ({
      link: options.destinationUrl,
      name: `${options.headline} - Photo ${i + 1}`,
      description: options.description.substring(0, 200),
      image_hash: hash,
      call_to_action: {
        type: 'MESSAGE_PAGE',
      },
    }));

    console.log('[Ad] Sending carousel request with', cards.length, 'cards');

    const response = await axios.post(`${BASE_URL}/adcreatives`, {
      name: options.name,
      object_story_spec: {
        page_id: config.PAGE_ID,
        link_data: {
          link: options.destinationUrl,
          call_to_action: {
            type: 'MESSAGE_PAGE',
          },
          child_attachments: cards,
        },
      },
      access_token: config.PAGE_ACCESS_TOKEN,
    });

    const creativeId = response.data.id;
    console.log(`[Ad] Created carousel ad creative: ${creativeId} with ${cards.length} images`);
    return creativeId;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Ad] createCarouselAdCreative failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Create an ad creative
 */
async function createAdCreative(options) {
  try {
    const response = await axios.post(`${BASE_URL}/adcreatives`, {
      name: options.name,
      object_story_spec: {
        page_id: config.PAGE_ID,
        link_data: {
          link: options.destinationUrl,
          message: options.primaryText,
          name: options.headline,
          description: options.description,
          image_hash: options.imageHash,
          call_to_action: {
            type: 'MESSAGE_PAGE',
          },
        },
      },
      access_token: config.PAGE_ACCESS_TOKEN,
    });

    const creativeId = response.data.id;
    console.log(`[Ad] Created ad creative: ${creativeId}`);
    return creativeId;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Ad] createAdCreative failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

/**
 * Create an ad
 */
async function createAd(adSetId, creativeId, options) {
  try {
    const response = await axios.post(`${BASE_URL}/ads`, {
      name: options.name,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status: 'PAUSED',
      access_token: config.PAGE_ACCESS_TOKEN,
    });

    const adId = response.data.id;
    console.log(`[Ad] Created ad: ${adId}`);
    return adId;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('[Ad] createAd failed:', metaError || err.message);
    throw new Error(metaError?.message || err.message);
  }
}

module.exports = {
  uploadImage,
  uploadImages,
  createAdCreative,
  createCarouselAdCreative,
  createAd,
};