# Property Selection Flow — No Referral Detected

## Problem

When a user messages the Facebook page without a referral ref (e.g., they found the page directly, not from an ad), the bot currently responds with a generic "Thanks for your message. Takashi will respond within 24 hours." with no way to route them to the rental bot or identify which property they want.

## Goal

When a user with no referral messages the page, check if there are active Meta ad campaigns. If yes, ask which property they're interested in via quick-reply buttons. If no active campaigns, fall back to the generic response.

---

## Flow

```
User (no referral) → handleMessage()
  → checkActiveCampaigns()
    → has active campaigns?
      → YES: sendPropertyOptions(senderId) → user taps quick-reply → store selection → next message routes to rentalBot
      → NO: sendGenericResponse(senderId, "Thanks for your message...")
```

---

## Implementation

### 1. New function in `messageHandler.js`

```javascript
async function checkActiveCampaigns() {
  // Call Meta Marketing API
  // GET /act_{AD_ACCOUNT_ID}/campaigns?status=ACTIVE
  // Return array of { campaignId, name } or empty array
}
```

### 2. New function `sendPropertyOptions(senderId)`

Sends a message with quick-reply buttons:
- **Title**: "Which property are you interested in?"
- **Options**: Campaign names formatted as full text: "3 bedroom 2 bathroom unit in Victoria"
- **Max**: 10 options (Meta limit)

### 3. Parse selection back to referralRef

Campaign names follow format: `{property_id}-{unit_id}` (e.g., `McClure-MC-rear`).
When user taps a quick-reply, the `message.text` contains the formatted option (e.g., "3 bedroom 2 bathroom unit in Victoria").
We map it back to `PROP{property_id}-UNIT{unit_id}` format and store in `userReferrals`.

### 4. On selection → route to rentalBot

After selection is stored, the next message from the user will have a valid referral and route to `rentalBot.js` normally.

### 5. Caching

Active campaigns don't change frequently. Cache the result for 5 minutes to avoid excessive API calls.

```
activeCampaignsCache = { data: [], timestamp: 0 }
cache duration = 5 minutes
```

---

## API Call

```javascript
// Meta Marketing API — get active campaigns
GET https://graph.facebook.com/v21.0/act_{AD_ACCOUNT_ID}/campaigns
  ?fields=id,name,status
  &statusing[campaign.status]=["ACTIVE"]
  &access_token={PAGE_ACCESS_TOKEN}
```

Campaign name format: `{property_id}-{unit_id}` (e.g., `McClure-MC-rear`).

---

## Format: Quick-reply button text

Full text, no abbreviations. Format: `{num_bedroom} bedroom {num_bathroom} bathroom unit in {city}`

Example: "3 bedroom 2 bathroom unit in Victoria"

If city is not available in campaign name, use property_id: "3 bedroom 2 bathroom unit in McClure"

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Active campaigns exist but no property info can be parsed | Skip property selection, use generic response |
| No active campaigns | Use generic response |
| User ignores quick-replies and types anyway | Treat as generic inquiry (no referral stored) |
| More than 10 active campaigns | Show first 10, rest ignored |

---

## Generic Response

When no active campaigns exist (or fallback):
"Thanks for your message! Takashi will respond to you within 24 hours."

---

## Files Changed

- `src/phase1_messenger/messageHandler.js` — add `checkActiveCampaigns()`, `sendPropertyOptions()`, modify `handleMessage()`
- `src/phase1_messenger/sendApi.js` — already has `sendQuickReplies` (no changes needed)

---

## Test Scenarios

1. User messages with no referral + active campaigns → sees property options
2. User messages with no referral + no active campaigns → sees generic response
3. User selects a property option → referral stored → next message routes to rentalBot
4. User ignores options and types "hello" → generic response, no referral stored
5. 10+ active campaigns → only first 10 shown (Meta limit)