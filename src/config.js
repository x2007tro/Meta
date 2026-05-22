// src/config.js
require('dotenv').config();

const required = [
  'PAGE_ACCESS_TOKEN',
  'VERIFY_TOKEN',
  'APP_SECRET',
  'PAGE_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[Config] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  VERIFY_TOKEN:      process.env.VERIFY_TOKEN,
  APP_SECRET:        process.env.APP_SECRET,
  PAGE_ID:           process.env.PAGE_ID,
  APP_ID:            process.env.APP_ID,
  AD_ACCOUNT_ID:     process.env.AD_ACCOUNT_ID,
  GRAPH_API_VERSION: process.env.GRAPH_API_VERSION || 'v21.0',
  PORT:              parseInt(process.env.PORT || '3000', 10),
  APP_URL:           process.env.APP_URL || 'https://kmpka123.ddns.net',
};