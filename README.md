# Facebook Integration — Messenger Bot + Meta Marketing API

A Node.js/Express backend service with:
- **Phase 1**: Facebook Messenger webhook with automated keyword-based replies and referral tracking
- **Phase 2**: Meta Marketing API for creating Marketplace ad campaigns
- **Property Ad Templates**: Python script that creates ads from unit data in SQLite

---

## Project Structure

```
Meta/
├── .env.example            # Environment variable template
├── .gitignore
├── package.json
├── README.md
├── scripts/
│   └── create_unit_ad.py   # Python script to create Meta ads from SQLite unit data
├── src/
│   ├── index.js            # Express app + all routes
│   ├── config.js           # Env var loader + validation
│   ├── phase1_messenger/
│   │   ├── webhook.js      # GET/POST /webhook + HMAC signature validation + referral tracking
│   │   ├── sendApi.js      # sendTextMessage, sendTypingOn, sendQuickReplies, sendAttachment
│   │   └── messageHandler.js  # Keyword routing + auto-replies with property context
│   └── phase2_marketing/
│       ├── auth.js         # inspectToken, getLongLivedToken
│       ├── campaign.js     # create/get/updateCampaign
│       ├── adset.js        # createAdSet, createMarketplaceAdSet
│       ├── ad.js           # uploadImage, createAdCreative, createAd (with Messenger CTA)
│       └── marketplace.js  # createMarketplaceCampaign, activate/pause
└── test/
    ├── phase1_test.js
    └── phase2_test.js
```

---

## Production Server — Live Setup

**Domain:** `kmpka123.ddns.net` → `167.99.209.14` (DigitalOcean droplet)

| Component | Status | Details |
|-----------|--------|---------|
| Nginx | ✅ running | Reverse proxy on port 80/443 |
| SSL | ✅ active | Let's Encrypt (auto-renews 2026-08-18) |
| Node app | ✅ running via PM2 | `pm2 start src/index.js --name meta-bot` |
| PM2 | ✅ configured | Auto-restart + reboot survival (`pm2 save` + `pm2 startup` done) |
| Privacy policy | ✅ live | `https://kmpka123.ddns.net/privacy.html` |
| Firewall | ✅ open | Ports 80/443 accessible |
| SSL renewal | ✅ cron | `certbot.timer` active, renews automatically |

**Webhook URL:** `https://kmpka123.ddns.net/webhook`

**Server setup complete.** All TODOs resolved.

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```env
# ── Phase 1: Messenger ──────────────────────────────────────────
PAGE_ACCESS_TOKEN=your_page_access_token_here
VERIFY_TOKEN=your_verify_token_here
APP_ID=your_meta_app_id
APP_SECRET=your_app_secret_here
PAGE_ID=your_page_numeric_id

# ── Phase 2: Marketing API ───────────────────────────────────────
AD_ACCOUNT_ID=act_your_ad_account_id
GRAPH_API_VERSION=v21.0

# ── Server ───────────────────────────────────────────────────────
PORT=3000
```

### 3. Start Development Server

```bash
npm start          # Production mode
npm run dev        # With nodemon (auto-reload on changes)
```

### 4. Test

```bash
npm test           # Phase 1 webhook test
npm run test:phase2  # Phase 2 integration test
```

---

## Phase 1 — Messenger Auto-Reply Features

### Two Inquiry Flows

**Random inquiries (no rental referral):** Any message from a user without a rental property referral gets a single generic response: "Thanks for your message. Takashi will respond to you within 24 hours." No keyword matching.

**Rental property inquiries (has referral ref like `PROPStMary-UNITSM-01`):** These users get a rental inquiry bot that collects 5 pieces of information before handing off to Takashi.

### Rental Inquiry Bot Flow

The bot (in `src/phase1_messenger/rentalBot.js`) manages a state machine per user:

1. **NEW_INQUIRY** — User's first message triggers a greeting with the property headline, asking for 5 details:
   - Name
   - Occupation & monthly income (before tax)
   - Move-in date
   - Household (adults, kids, pets)
   - Reason for moving

2. **AWAITING_INFO** — Bot collects and classifies replies:
   - **Bucket A (complete):** All 5 fields present → sends confirmation + handoff email to Takashi, state becomes `HANDOFF_TO_TAKASHI`
   - **Bucket B (partial):** Missing some fields → prompts for only the missing ones
   - **Bucket C (question):** User asked a question → answered + reprompts for the 5 details
   - **Bucket E (spam):** Silently closes

3. **HANDOFF_TO_TAKASHI** (terminal) — Takashi takes over. Bot blocks all further messages.

4. **Photos** — Users can reply "photos" at any time to receive a ZIP of property images.

**Income threshold:** Monthly income must be ≥ $2,500 (annual ≥ $30,000) to be considered complete.

**Date parsing:** Move-in dates in the past fall back to one year from today.

**mid deduplication:** Webhook redeliveries are ignored using an in-memory Set to prevent double replies.

**Handoff email:** When a user completes the inquiry, an email is sent to Takashi via a Python subprocess with the user's responses.

### Referral Tracking

When users click "Message Me" on a property ad, the referral ref (e.g., `PROPStMary-UNITSM-01`) is stored and included in auto-replies. This identifies which property the inquiry is about.

### Sending Attachments

The `sendAttachment(recipientId, fileType, url)` function sends files via Messenger:

```javascript
const { sendAttachment } = require('./phase1_messenger/sendApi');

// Send a PDF
await sendAttachment(recipientId, 'file', 'https://your-server.com/doc.pdf');

// Send an image
await sendAttachment(recipientId, 'image', 'https://your-server.com/photo.jpg');
```

Supported file types: `file`, `image`, `video`, `audio`. The URL must be publicly accessible via HTTPS.

---

## Phase 2 — Marketing API Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/marketing/campaign` | Create full Marketplace campaign |
| `POST` | `/api/marketing/campaign/:id/activate` | Activate a PAUSED campaign |
| `POST` | `/api/marketing/campaign/:id/pause` | Pause an active campaign |
| `GET` | `/api/marketing/campaign/:id` | Get campaign details |
| `POST` | `/api/marketing/campaign/:id/status` | Update campaign status (PATCH) |
| `POST` | `/api/marketing/create-unit-ad` | Create ad from property unit data (for Python script) |

### Create Campaign Body

```json
{
  "campaignName": "PROPStMary-UNITSM-01 - Rental Campaign",
  "objective": "OUTCOME_ENGAGEMENT",
  "specialAdCategories": ["HOUSING"],
  "adSetName": "258 St Marys Street AdSet",
  "dailyBudgetCents": 1000,
  "country": "CA",
  "adName": "258 St Marys Street Ad",
  "destinationUrl": "https://www.facebook.com",
  "primaryText": "Bright 2BR Apartment in Secured Building...",
  "headline": "Bright 2BR Apartment in Secured Building Off Westmorland Bridge",
  "description": "Available for rent in Fredericton, NB: a 2-bedroom, 1-bathroom apartment...",
  "imageFilePath": "/root/.openclaw/workspace/RealEstate/units_photo/StMary/SM-01/image.jpg",
  "ref": "PROPStMary-UNITSM-01"
}
```

### Ad Features

- **Objective**: `OUTCOME_TRAFFIC` (drives traffic to Messenger conversation)
- **Special Ad Category**: `HOUSING` (required for rental property ads)
- **Call to Action**: Messenger (opens conversation with your Page)
- **Creative**: Single-image ad (carousel temporarily disabled due to Meta API error 1443225)
- **Ad headline**: Filled from DB `headline` column using property data
- **Ad primary text**: Filled from DB `feature` column using property data

---

## Property Ad Templates — Creating Ads from SQLite

This feature allows creating Meta ads from unit data stored in a SQLite database.

### Database Schema

Table: `properties_post` in `/root/.openclaw/workspace/Finance/finance.db`

```sql
CREATE TABLE properties_post (
  unit_id TEXT PRIMARY KEY,
  property_id TEXT,
  address TEXT,
  headline TEXT,
  feature TEXT,
  description TEXT,
  sqft INTEGER,
  rent INTEGER,
  building_type TEXT,
  num_bedroom INTEGER,
  num_bathroom INTEGER,
  laundry_type TEXT,
  has_backyard TEXT,
  utility_included TEXT,
  has_AC TEXT,
  has_parking TEXT,
  available_from TEXT,
  status TEXT,
  image_folder TEXT,
  application_location TEXT,
  city TEXT,
  province TEXT,
  country TEXT DEFAULT 'CA',
  note TEXT
);
```

| Column | Description |
|--------|-------------|
| `unit_id` | Unique identifier for the unit (e.g., SM-01) |
| `property_id` | Parent property identifier (e.g., StMary) |
| `address` | Full address of the unit |
| `headline` | Ad headline template (with placeholders like {num_bedroom}) |
| `feature` | Short feature description for primary text |
| `description` | Full description template (with placeholders) |
| `sqft` | Square footage |
| `rent` | Monthly rent amount |
| `building_type` | apartment, house, etc. |
| `num_bedroom` | Number of bedrooms |
| `num_bathroom` | Number of bathrooms |
| `laundry_type` | in_building, in_unit, or none |
| `has_backyard` | yes or no |
| `utility_included` | yes or no |
| `has_AC` | yes or no |
| `has_parking` | yes or no |
| `available_from` | Available date (YYYY-MM-DD) |
| `status` | e.g., 'ok', 'occupied', 'vacant' |
| `image_folder` | Full path to unit's image folder |
| `application_location` | Path to application forms folder |
| `city` | City for targeting |
| `province` | Province code (e.g., NB, BC) |
| `country` | Country code (default 'CA') |
| `note` | Instructions for filling placeholder values |

### Placeholder Values

The `headline`, `feature`, and `description` fields contain placeholders that are filled when creating ads:

| Placeholder | Value |
|-------------|-------|
| `{num_bedroom}` | Number of bedrooms |
| `{num_bathroom}` | Number of bathrooms |
| `{building_type}` | apartment, house, etc. |
| `{sqft}` | Square footage |
| `{city}` | City name |
| `{province}` | Province code |
| `{laundry_type}` | in-building, in-unit, or none |
| `{has_backyard}` | yes or no |
| `{has_AC}` | yes or no |
| `{has_parking}` | yes or no |
| `{utility_included}` | yes or no |
| `{rent}` | Monthly rent |
| `{available_from}` | Available date |

### Image Folder

Images stored at: `/root/.openclaw/workspace/RealEstate/units_photo/{property_id}/{unit_id}/`

The script finds the first image file (`.png`, `.jpg`, `.jpeg`, `.webp`) in that folder.

### Python Script Usage

```bash
python3 scripts/create_unit_ad.py <property_id> <unit_id> [--objective=<objective>]
```

Examples:
```bash
python3 scripts/create_unit_ad.py StMary SM-01
python3 scripts/create_unit_ad.py McClure MC-rear --objective=OUTCOME_TRAFFIC
```

### What the Script Does

1. Fetches unit data from `properties_post` table (including all fields and note)
2. Finds the first image in `units_photo/{property_id}/{unit_id}/`
3. Builds ad payload with property details and placeholder-filling instructions
4. POSTs to `/api/marketing/create-unit-ad`
5. Returns ad IDs (campaignId, adSetId, creativeId, adId)

---

## RealEstate Folder Structure

```
/root/.openclaw/workspace/RealEstate/
├── units_photo/
│   ├── Archangel/
│   │   └── AA-main/
│   ├── Delora/
│   │   ├── DE-main/
│   │   └── DE-base/
│   ├── McClure/
│   │   ├── MC-front/
│   │   ├── MC-base/
│   │   └── MC-rear/
│   └── StMary/
│       ├── SM-01/
│       ├── SM-02/
│       └── ... (8 units)
└── application_forms/
    ├── Archangel/
    ├── Delora/
    ├── McClure/
    └── StMary/
```

---

## Production Deployment — DigitalOcean Droplet

> **Already deployed.** Domain: `kmpka123.ddns.net` | IP: `167.99.209.14`
> See [Production Server — Live Setup](#production-server--live-setup) above for current status.

### Overview of Current Server Setup

```
kmpka123.ddns.net (port 443) → Nginx → localhost:3000 (Node app)
                                      ↓
                              /webhook (Messenger)
                              /api/marketing/* (Marketing API)

SSL: Let's Encrypt /etc/letsencrypt/live/kmpka123.ddns.net/
Static: /var/www/html/privacy.html
```

### If Starting Fresh on a New Droplet

#### 1. Set Up Droplet

```bash
# SSH into your droplet
ssh root@your-droplet-ip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

### 2. Clone Project

```bash
# Clone from git or upload your project
git clone https://github.com/your-username/Meta.git
cd Meta

# Install dependencies
npm install
```

### 3. Set Up SSL (Required for Webhook)

Install Nginx and Let's Encrypt:

```bash
# Install Nginx
sudo apt-get install -y nginx

# Install Certbot for SSL
sudo apt-get install -y certbot python3-certbot-nginx

# Obtain SSL certificate (replace with your domain)
sudo certbot --nginx -d your-domain.com
```

### 4. Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/default
```

Add this configuration (replace `your-domain.com` and `localhost:3000`):

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Test and reload Nginx
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Set Up Privacy Policy URL (Required for App Review)

Meta requires a privacy policy page to pass app review. Create a simple HTML file:

```bash
# Create privacy policy page
sudo nano /var/www/your-domain.com/html/privacy.html
```

Add this content:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Privacy Policy</title>
</head>
<body>
<h1>Privacy Policy</h1>
<p>Your app description here.</p>
<p>Contact: your@email.com</p>
</body>
</html>
```

Then configure Nginx to serve it:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/your-domain.com/html;
    index privacy.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Access your privacy policy at: `https://your-domain.com/privacy.html`

### 6. Install and Configure PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the app with PM2
pm2 start src/index.js --name meta-bot

# Save PM2 process list (auto-restart on reboot)
pm2 save

# Generate startup script for your init system
pm2 startup
```

### 7. Common PM2 Commands

```bash
pm2 logs meta-bot         # View logs
pm2 restart meta-bot      # Restart app
pm2 stop meta-bot         # Stop app
pm2 status                # Check status
pm2 delete meta-bot       # Remove from PM2
```

---

## Updating Webhook URL for Production

After setting up your domain with SSL, update your webhook URL in Meta Developer Console:

```
https://your-domain.com/webhook
```

Your droplet's public IP or domain now replaces ngrok. No need for ngrok in production.

---

## Final Checklist Before Going Live

- [ ] `.env` file populated with real credentials
- [ ] `.env` in `.gitignore` — never commit secrets
- [ ] Webhook verified in Meta Developer Console (Phase 1)
- [ ] Page linked to app in Messenger Settings
- [ ] Subscribed to events: `messages`, `messaging_postbacks`, `message_deliveries`
- [ ] App reviewed and granted `pages_messaging` permission (for public access)
- [ ] Ad account linked to Meta App (Phase 2)
- [ ] App granted `ads_management` and `ads_read` permissions (Phase 2)
- [ ] PM2 running in production (not ngrok)
- [ ] Domain pointed to droplet with SSL certificate
- [ ] Token expiry monitored — refresh before 60-day expiry
- [ ] `properties_post` table populated with unit data
- [ ] Images uploaded to `units_photo/{property_id}/{unit_id}/` with valid image files

---

## Key API Reference URLs

| Resource | URL |
|----------|-----|
| Meta Developer Console | https://developers.facebook.com/apps |
| Graph API Explorer | https://developers.facebook.com/tools/explorer |
| Messenger Platform Docs | https://developers.facebook.com/docs/messenger-platform |
| Marketing API Docs | https://developers.facebook.com/docs/marketing-apis |
| Ad Account Setup | https://business.facebook.com |
| Webhook Testing Tool | https://developers.facebook.com/tools/webhooks |
| Netlify Drop (free file hosting) | https://app.netlify.com/drop |