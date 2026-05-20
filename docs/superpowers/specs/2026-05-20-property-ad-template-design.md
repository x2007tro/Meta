# Property Ad Template System — Design Spec

## Overview

A Python script that fetches property/unit data from SQLite and triggers Meta ad creation via an HTTP endpoint. The Node.js Phase 2 code acts as the "plumbing" that calls Meta's Marketing API.

**Owner:** Property manager with existing SQLite database of property/unit data
**Trigger:** Manual — agent runs Python script when a unit becomes vacant

---

## Architecture

```
Python create_unit_ad.py
  ↓ HTTP POST (JSON)
Node.js POST /api/marketing/create-unit-ad
  ↓
marketplace.js → createMarketplaceCampaign()
  ↓
Meta Marketing API
```

---

## Python Script — `create_unit_ad.py`

### Location
`scripts/create_unit_ad.py` (new directory for utility scripts)

### Inputs
- `property_id` — passed as CLI argument or prompted
- `unit_id` — passed as CLI argument or prompted

### Behavior
1. Accept `property_id` and `unit_id` as arguments
2. Query SQLite for unit data
3. Build ad payload from template + unit data
4. POST payload to `http://localhost:3000/api/marketing/create-unit-ad`
5. Log returned ad IDs

### SQLite Schema (expected)

```sql
CREATE TABLE units (
  unit_id TEXT PRIMARY KEY,
  property_id TEXT,
  address TEXT,
  description TEXT,
  rent INTEGER,        -- in dollars (e.g., 1800 for $1800/mo)
  status TEXT,         -- 'vacant', 'occupied', etc.
  image_folder TEXT,   -- relative path to unit's image folder
  city TEXT,           -- for targeting
  country TEXT DEFAULT 'CA'
);
```

### Ad Payload Template

| Field | Source |
|-------|--------|
| `propertyId` | `property_id` argument |
| `unitId` | `unit_id` argument |
| `campaignName` | `"Rental Campaign - {address}"` |
| `adSetName` | `"{address} AdSet"` |
| `dailyBudgetCents` | Default `1000` ($10/day), configurable |
| `country` | `country` from DB, default `'CA'` |
| `adName` | `"{address} Ad"` |
| `destinationUrl` | Placeholder or configurable landing page URL |
| `primaryText` | Generated from template: `"{description} at {address}, ${rent}/mo"` |
| `headline` | Static or from DB |
| `description` | `description` from DB |
| `imageFilePath` | First image in `{image_folder}/` directory |

---

## Node.js Endpoint — `POST /api/marketing/create-unit-ad`

### Location
`src/index.js` — new route

### Request Body

```json
{
  "propertyId": "string",
  "unitId": "string",
  "campaignName": "string",
  "adSetName": "string",
  "dailyBudgetCents": 1000,
  "country": "CA",
  "adName": "string",
  "destinationUrl": "string",
  "primaryText": "string",
  "headline": "string",
  "description": "string",
  "imageFilePath": "string"
}
```

### Response — Success (200)

```json
{
  "success": true,
  "data": {
    "campaignId": "120245189641900713",
    "adSetId": "120245189644210713",
    "creativeId": "...",
    "adId": "..."
  }
}
```

### Response — Error (400/500)

```json
{
  "success": false,
  "error": "Error message"
}
```

### Implementation

- New route in `src/index.js`
- Calls `marketplace.createMarketplaceCampaign(req.body)`
- Existing Phase 2 modules (`campaign.js`, `adset.js`, `ad.js`, `marketplace.js`) handle the actual Meta API calls
- Image upload via `ad.uploadImage(imageFilePath)`

---

## File Structure

```
Meta/
├── scripts/
│   └── create_unit_ad.py     # New: Python ad creation script
├── src/
│   ├── index.js               # Modified: add new endpoint
│   └── ... (existing Phase 2 files)
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-05-20-property-ad-template-design.md
└── test/
    └── phase2_test.js        # Existing: still works for direct testing
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| SQLite query returns no unit | Python prints error, exits with code 1 |
| HTTP request fails | Python prints error, exits with code 1 |
| Node endpoint returns error | Python prints error from response body |
| Image file not found | Node logs error, returns 500 |
| Meta API error | Node logs full error, returns 500 with message |

---

## Testing

1. **Unit test**: Run existing `npm run test:phase2` to verify Phase 2 modules still work
2. **Integration test**: Run Python script with a known vacant unit ID, verify ad IDs returned
3. **Manual verification**: Check ad IDs in Meta Ads Manager

---

## Out of Scope

- Image hosting (assumes images are local files accessible to Node.js)
- Token refresh automation
- Multiple image variants (single hero image only)
- Ad creative variants/A-B testing
- Campaign activation (remains PAUSED after creation)
- Scheduling recurring campaigns
