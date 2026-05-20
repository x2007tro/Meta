// src/index.js
require('dotenv').config();
const express = require('express');
const config = require('./config');
const webhookRouter = require('./phase1_messenger/webhook');

// Phase 2 - validate on use
const validatePhase2 = () => {
  if (!config.APP_ID || !config.AD_ACCOUNT_ID) {
    throw new Error('Phase 2 requires APP_ID and AD_ACCOUNT_ID');
  }
};

const marketplace = require('./phase2_marketing/marketplace');
const campaignModule = require('./phase2_marketing/campaign');

const app = express();

// Capture raw body for signature validation (must be before express.json())
app.use((req, res, next) => {
  if (req.path === '/webhook') {
    let rawBody = [];
    req.on('data', chunk => rawBody.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(rawBody);
      try {
        req.body = JSON.parse(req.rawBody.toString());
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});

// Parse JSON (only for non-webhook routes, webhook has its own parsing)
app.use((req, res, next) => {
  if (req.path === '/webhook') {
    return next();
  }
  express.json()(req, res, next);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    phase1: true,
    phase2: !!config.AD_ACCOUNT_ID,
    adAccountId: config.AD_ACCOUNT_ID ? 'act_XXXX' : null,
    pageId: config.PAGE_ID,
  });
});

// Mount webhook router
app.use('/webhook', webhookRouter);

// Phase 2: Marketing API routes
app.post('/api/marketing/campaign', async (req, res) => {
  console.log('[POST] /api/marketing/campaign');
  try {
    validatePhase2();
    const result = await marketplace.createMarketplaceCampaign(req.body);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/marketing/campaign/:id/activate', async (req, res) => {
  console.log('[POST] /api/marketing/campaign/:id/activate');
  try {
    validatePhase2();
    await marketplace.activateCampaign(req.params.id);
    return res.json({ success: true, data: { campaignId: req.params.id } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/marketing/campaign/:id/pause', async (req, res) => {
  console.log('[POST] /api/marketing/campaign/:id/pause');
  try {
    validatePhase2();
    await marketplace.pauseCampaign(req.params.id);
    return res.json({ success: true, data: { campaignId: req.params.id } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/marketing/campaign/:id', async (req, res) => {
  console.log('[GET] /api/marketing/campaign/:id');
  try {
    validatePhase2();
    const result = await campaignModule.getCampaign(req.params.id);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Create ad from property data (called by Python script)
app.post('/api/marketing/create-unit-ad', async (req, res) => {
  console.log('[POST] /api/marketing/create-unit-ad');
  try {
    validatePhase2();
    const result = await marketplace.createMarketplaceCampaign(req.body);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[create-unit-ad] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start server
app.listen(config.PORT, () => {
  console.log(`[Server] Listening on port ${config.PORT}`);
});