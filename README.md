# Facebook Integration — Messenger Bot + Meta Marketing API

A Node.js/Express backend service with:
- **Phase 1**: Facebook Messenger webhook with automated keyword-based replies
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
│   │   ├── webhook.js      # GET/POST /webhook + HMAC signature validation
│   │   ├── sendApi.js      # sendTextMessage, sendTypingOn, sendQuickReplies, sendAttachment
│   │   └── messageHandler.js  # Keyword routing + auto-replies
│   └── phase2_marketing/
│       ├── auth.js         # inspectToken, getLongLivedToken
│       ├── campaign.js     # create/get/updateCampaign
│       ├── adset.js        # createAdSet, createMarketplaceAdSet
│       ├── ad.js           # uploadImage, createAdCreative, createAd
│       └── marketplace.js  # createMarketplaceCampaign, activate/pause
└── test/
    ├── phase1_test.js
    └── phase2_test.js
```

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
VERIFY_TOKEN=your_chosen_webhook_verify_token
APP_SECRET=your_app_secret_here
PAGE_ID=your_page_numeric_id

# ── Phase 2: Marketing API ───────────────────────────────────────
APP_ID=your_meta_app_id
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

### Keyword Routing

| User Message | Auto-Reply |
|-------------|------------|
| `hello`, `hi`, `hey` | "Hi there! Thanks for reaching out. How can I help you today?" |
| `price`, `cost`, `how much` | "Please check the listing for pricing details. Feel free to ask any other questions!" |
| `available`, `still for sale` | "Yes, this item is still available! Would you like to arrange a viewing?" |
| `address`, `location`, `where` | "Please message us to arrange a convenient meeting location." |
| anything else | "Thanks for your message! We'll get back to you shortly." |

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
| `POST` | `/api/marketing/create-unit-ad` | Create ad from property unit data (for Python script) |

### Create Campaign Body

```json
{
  "campaignName": "My Campaign",
  "objective": "OUTCOME_TRAFFIC",
  "adSetName": "My Ad Set",
  "dailyBudgetCents": 1000,
  "country": "CA",
  "adName": "My Ad",
  "destinationUrl": "https://example.com",
  "primaryText": "Check out our product!",
  "headline": "Product Headline",
  "description": "Product description",
  "imageFilePath": "./images/ad-image.png"
}
```

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
  description TEXT,
  rent INTEGER,
  status TEXT,
  image_folder TEXT,
  city TEXT,
  country TEXT DEFAULT 'CA'
);
```

| Column | Description |
|--------|-------------|
| `unit_id` | Unique identifier for the unit |
| `property_id` | Parent property identifier |
| `address` | Full address of the unit |
| `description` | Unit description |
| `rent` | Monthly rent amount |
| `status` | e.g., 'vacant', 'occupied' |
| `image_folder` | Folder name under `units_photo/` containing images |
| `city` | City for targeting |
| `country` | Country code (default 'CA') |

### Image Folder

Images stored at: `/root/.openclaw/workspace/Finance/units_photo/{image_folder}/`

The script finds the first image file (`.png`, `.jpg`, `.jpeg`, `.webp`) in that folder.

### Python Script Usage

```bash
python3 scripts/create_unit_ad.py <property_id> <unit_id>
```

Example:
```bash
python3 scripts/create_unit_ad.py PROP001 UNIT001
```

### What the Script Does

1. Fetches unit data from `properties_post` table
2. Finds the first image in `units_photo/{image_folder}/`
3. Builds ad payload with template: `"Rental Campaign - {address}"`
4. POSTs to `/api/marketing/create-unit-ad`
5. Returns ad IDs (campaignId, adSetId, creativeId, adId)

---

## Production Deployment — DigitalOcean Droplet

### 1. Set Up Droplet

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
- [ ] Images uploaded to `units_photo/{image_folder}/` with valid image files

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