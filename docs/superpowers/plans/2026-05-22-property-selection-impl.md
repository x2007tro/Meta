# Property Selection Flow — No Referral Inquiry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user messages the page with no referral ref, check for active Meta campaigns and ask them which property they're interested in via quick-reply buttons. On selection, store the referral and route to rental bot.

**Architecture:** Extend `messageHandler.js` with two new functions (`checkActiveCampaigns`, `sendPropertyOptions`) and modify `handleMessage` to check for active campaigns before falling back to generic response. Cache active campaigns for 5 minutes to avoid excessive API calls.

**Tech Stack:** Node.js, Meta Marketing API, Messenger Send API

---

## File Map

- **Modify:** `src/phase1_messenger/messageHandler.js` — add property selection logic
- **Modify:** `src/phase1_messenger/referralStore.js` — already exports `userReferrals` Map, no change needed
- **Read:** `src/phase1_messenger/sendApi.js` — has `sendQuickReplies` already, no change needed
- **Read:** `src/config.js` — for `GRAPH_API_VERSION`, `AD_ACCOUNT_ID`, `PAGE_ACCESS_TOKEN`

---

## Task 1: Add active campaigns cache and API call to messageHandler.js

**Files:**
- Modify: `src/phase1_messenger/messageHandler.js` — add at top of file after existing requires

- [ ] **Step 1: Add cache and requires**

Add after the existing `require` statements in `messageHandler.js`:

```javascript
const axios = require('axios');
const config = require('../config');

// Active campaigns cache (5 minute TTL)
let campaignCache = { data: [], timestamp: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch active campaigns from Meta Marketing API
 * Returns array of { campaignId, name } sorted by name
 */
async function getActiveCampaigns() {
  const now = Date.now();
  if (campaignCache.data.length && (now - campaignCache.timestamp) < CACHE_TTL_MS) {
    return campaignCache.data;
  }

  const AD_ACCOUNT_ID = config.AD_ACCOUNT_ID;
  const AD_ACCOUNT_URL = `https://graph.facebook.com/${config.GRAPH_API_VERSION}/act_${AD_ACCOUNT_ID}/campaigns`;

  try {
    const response = await axios.get(AD_ACCOUNT_URL, {
      params: {
        fields: 'id,name,status',
        statusing: { 'campaign.status': ['ACTIVE'] },
        access_token: config.PAGE_ACCESS_TOKEN,
      },
    });

    const campaigns = (response.data?.data || [])
      .filter(c => c.status === 'ACTIVE')
      .map(c => ({ campaignId: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    campaignCache = { data: campaigns, timestamp: now };
    return campaigns;
  } catch (err) {
    console.error('[MessageHandler] getActiveCampaigns error:', err.response?.data || err.message);
    return [];
  }
}
```

- [ ] **Step 2: Run test to verify no syntax errors**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/messageHandler')" 2>&1`
Expected: No output (OK)

---

## Task 2: Add sendPropertyOptions function

**Files:**
- Modify: `src/phase1_messenger/messageHandler.js` — add after `getActiveCampaigns`

- [ ] **Step 1: Add helper to get property display info from DB**

```javascript
/**
 * Get property display info from SQLite DB (synchronous)
 * Returns { num_bedroom, num_bathroom, city } or null
 */
function getPropertyDisplayFromDB(propertyId, unitId) {
  const db = new sqlite3.Database('/root/.openclaw/workspace/Finance/finance.db');
  const sql = `SELECT num_bedroom, num_bathroom, city FROM properties_post WHERE property_id = ? AND unit_id = ?`;
  const row = db.prepare(sql).get(propertyId, unitId);
  db.close();
  return row || null;
}
```

- [ ] **Step 2: Add parseCampaignToDisplay and formatPropertyLabel**

```javascript
/**
 * Parse campaign name (format: "property_id-unit_id") to extract parts.
 * e.g., "McClure-MC-rear" → { propertyId: "McClure", unitId: "MC-rear" }
 */
function parseCampaignToDisplay(campaignName) {
  if (!campaignName || !campaignName.includes('-')) return null;
  const parts = campaignName.split('-');
  if (parts.length < 2) return null;
  const unitId = parts[parts.length - 1];
  const propertyId = parts.slice(0, -1).join('-');
  return { propertyId, unitId };
}

/**
 * Format display text: "3 bedroom 2 bathroom unit in Victoria"
 */
function formatPropertyLabel(propertyId, unitId, city) {
  const dbRow = getPropertyDisplayFromDB(propertyId, unitId);
  if (dbRow) {
    const br = Number(dbRow.num_bedroom) || 0;
    const ba = Number(dbRow.num_bathroom) || 0;
    const cityText = dbRow.city || propertyId;
    return `${br} bedroom ${ba} bathroom unit in ${cityText}`;
  }
  // Fallback: use campaign name
  return campaignName;
}
```

- [ ] **Step 3: Add sendPropertyOptions function**

```javascript
/**
 * Send property selection quick-replies to user
 */
async function sendPropertyOptions(senderId, campaigns) {
  const replies = campaigns.slice(0, 10).map(c => {
    const parsed = parseCampaignToDisplay(c.name);
    const label = parsed
      ? formatPropertyLabel(parsed.propertyId, parsed.unitId, null)
      : c.name;
    return {
      content_type: 'text',
      title: label,
      payload: c.name, // store campaign name as payload (property_id-unit_id)
    };
  });

  await sendQuickReplies(
    senderId,
    "Which property are you interested in?",
    replies
  );
}
```

- [ ] **Step 4: Add sqlite3 require at top of file**

At the top of `messageHandler.js`, add:
```javascript
const sqlite3 = require('sqlite3');
```

- [ ] **Step 5: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/messageHandler')" 2>&1`
Expected: No output (OK)

---

## Task 3: Handle quick-reply selection in handleMessage and handleTextMessage

**Files:**
- Modify: `src/phase1_messenger/messageHandler.js` — modify `handleMessage` and `handleTextMessage`

- [ ] **Step 1: Modify handleMessage to check for active campaigns when no referral**

Replace the `handleMessage` function body:

```javascript
async function handleMessage(senderId, messageEvent) {
  const referralRef = userReferrals.get(senderId);

  // If it's a rental property referral, delegate to rental bot
  if (referralRef && isRentalReferral(referralRef)) {
    await handleRentalMessage(senderId, messageEvent);
    return;
  }

  // No referral — check for active campaigns on text messages
  if (messageEvent.text) {
    const campaigns = await getActiveCampaigns();
    if (campaigns.length > 0) {
      // Has active campaigns — check if this is a quick-reply selection (text matches campaign name)
      const matchedCampaign = campaigns.find(c => c.name === messageEvent.text);
      if (matchedCampaign && !referralRef) {
        // User selected a property via quick-reply — store referral and route to rental bot
        userReferrals.set(senderId, matchedCampaign.name);
        await handleRentalMessage(senderId, messageEvent);
        return;
      }
      // Not a campaign match and no referral — show property options
      await sendTypingOn(senderId);
      await sendPropertyOptions(senderId, campaigns);
      return;
    }
  }

  // No active campaigns — fall through to generic response
  if (messageEvent.text) {
    await handleTextMessage(senderId, messageEvent.text, referralRef);
  } else if (messageEvent.attachments) {
    await sendTypingOn(senderId);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await sendTextMessage(senderId, "Thanks for the attachment! Takashi will respond to you within 24 hours.");
  }
}
```

- [ ] **Step 2: Simplify handleTextMessage — no campaign matching needed here**

In `handleTextMessage`, remove the campaign matching logic (it's now handled in `handleMessage`). The function stays as-is for the generic response path:

```javascript
async function handleTextMessage(senderId, text, referralRef = null) {
  const lowerText = text.toLowerCase().trim();
  const propertyId = getPropertyIdFromRef(referralRef);

  await sendTypingOn(senderId);

  let reply;

  const propertyContext = referralRef ? ` [Re: ${referralRef}]` : '';

  // Handle application form requests
  if (propertyId && ['application', 'apply', 'form', 'application form'].some(kw => lowerText.includes(kw))) {
    // ... existing application form logic (keep as-is) ...
    return;
  }

  // All other messages get generic response
  reply = `Thanks for your message! Takashi will respond to you within 24 hours.${propertyContext}`;

  await new Promise(resolve => setTimeout(resolve, 1000));
  await sendTextMessage(senderId, reply);
}
```

Note: The campaign matching is now done in `handleMessage` BEFORE calling `handleTextMessage`, so `handleTextMessage` only handles the fallback generic path.

- [ ] **Step 3: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/messageHandler')" 2>&1`
Expected: No output (OK)

- [ ] **Step 4: Restart PM2 and verify**

Run: `pm2 restart meta-bot && sleep 2 && pm2 logs meta-bot --lines 5 --nostream`

---

## Task 4: Update exports

**Files:**
- Modify: `src/phase1_messenger/messageHandler.js` — update module.exports

- [ ] **Step 1: Verify exports still correct**

Current exports: `{ handleMessage, handleTextMessage }` — no change needed since we only added helper functions.

Run: `node -e "const m = require('/root/.openclaw/workspace/Meta/src/phase1_messenger/messageHandler'); console.log(Object.keys(m))" 2>&1`
Expected: `[ 'handleMessage', 'handleTextMessage' ]`

---

## Task 5: Commit changes

- [ ] **Step 1: Commit**

```bash
git add src/phase1_messenger/messageHandler.js
git commit -m "feat: add property selection flow for no-referral inquiries

- Check active Meta campaigns when no referral detected
- Send quick-reply buttons with property options
- On selection, store as referral and route to rental bot
- 5-minute cache on active campaigns API call

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 2: Push**

```bash
git push origin main
```

---

## Verification

After implementation, test by:

1. **With active campaigns:** Message the page with no referral → should see property options
2. **Without active campaigns:** Should receive generic response
3. **On selection:** Tap a quick-reply → next message should route to rental bot with property context

Check logs: `pm2 logs meta-bot --lines 30 --nostream`