# Property Ad Template System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python script that fetches property/unit data from SQLite and calls a new Node.js endpoint to create Meta ads via the existing Phase 2 plumbing.

**Architecture:** Python script → HTTP POST to Node endpoint → Phase 2 `marketplace.createMarketplaceCampaign()` → Meta Marketing API

**Tech Stack:** Python 3, Node.js/Express, SQLite, existing Phase 2 modules

---

## File Map

| File | Action |
|------|--------|
| `scripts/create_unit_ad.py` | Create — Python script |
| `src/index.js` | Modify — add `POST /api/marketing/create-unit-ad` |
| `src/phase2_marketing/marketplace.js` | No change — used as-is |
| `src/phase2_marketing/ad.js` | No change — `uploadImage` already handles local file path |

---

## Image Path Convention

Image folder: `/root/.openclaw/workspace/Finance/uploads/{property_id}/{unit_id}/`
First image file found in that folder is used as `imageFilePath`.

---

## Task 1: Add `create-unit-ad` endpoint to `src/index.js`

**Files:**
- Modify: `src/index.js:103-116`

- [ ] **Step 1: Add the new route before the `// Start server` comment**

Insert after line 103 (after `getCampaign` route, before `// Start server`):

```javascript
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
```

- [ ] **Step 2: Verify server still starts**

Run: `node -e "require('./src/index')" && echo "OK"`
Expected: `[Server] Listening on port 3000`

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: add POST /api/marketing/create-unit-ad endpoint

Called by Python create_unit_ad.py to trigger ad creation from
property/unit data stored in SQLite.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Create `scripts/create_unit_ad.py`

**Files:**
- Create: `scripts/create_unit_ad.py`
- DB: `/root/.openclaw/workspace/Finance/finance.db` (read-only, table `properties_post`)
- Images: `/root/.openclaw/workspace/Finance/uploads/{property_id}/{unit_id}/`

- [ ] **Step 1: Write the Python script**

Create `scripts/create_unit_ad.py` with content:

```python
#!/usr/bin/env python3
"""
create_unit_ad.py — Create a Meta ad for a vacant property unit.

Usage:
    python3 scripts/create_unit_ad.py <property_id> <unit_id>

Reads unit data from SQLite and POSTs to the Node.js create-unit-ad endpoint.
"""

import sys
import sqlite3
import os
import json
import urllib.request
import urllib.error

DB_PATH = '/root/.openclaw/workspace/Finance/finance.db'
UPLOADS_BASE = '/root/.openclaw/workspace/Finance/uploads'
NODE_ENDPOINT = 'http://localhost:3000/api/marketing/create-unit-ad'
DEFAULT_DESTINATION_URL = 'https://www.facebook.com'


def get_unit_data(property_id: str, unit_id: str) -> dict | None:
    """Fetch unit row from properties_post table."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        '''SELECT property_id, unit_id, address, description, rent,
                  status, image_folder, city, country
           FROM properties_post
           WHERE property_id = ? AND unit_id = ?''',
        (property_id, unit_id)
    )
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def find_first_image(property_id: str, unit_id: str) -> str | None:
    """Find first image file in the unit's image folder."""
    folder = os.path.join(UPLOADS_BASE, property_id, unit_id)
    if not os.path.isdir(folder):
        return None
    for filename in sorted(os.listdir(folder)):
        if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            return os.path.join(folder, filename)
    return None


def build_ad_payload(unit: dict, image_path: str | None) -> dict:
    """Build the ad creation payload from unit data."""
    address = unit['address'] or 'Unknown Address'
    rent = unit['rent'] or 0

    return {
        'propertyId': unit['property_id'],
        'unitId': unit['unit_id'],
        'campaignName': f"Rental Campaign - {address}",
        'objective': 'OUTCOME_TRAFFIC',
        'adSetName': f"{address} AdSet",
        'dailyBudgetCents': 1000,
        'country': unit.get('country') or 'CA',
        'adName': f"{address} Ad",
        'destinationUrl': DEFAULT_DESTINATION_URL,
        'primaryText': f"{unit.get('description', 'Rental available')} at {address}, ${rent}/mo",
        'headline': f"For Rent: {address}",
        'description': unit.get('description', ''),
        'imageFilePath': image_path or '',
    }


def create_ad(payload: dict) -> dict:
    """POST payload to Node endpoint and return response."""
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        NODE_ENDPOINT,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 scripts/create_unit_ad.py <property_id> <unit_id>")
        sys.exit(1)

    property_id = sys.argv[1]
    unit_id = sys.argv[2]

    print(f"[create_unit_ad] Fetching unit {property_id}/{unit_id} from database...")
    unit = get_unit_data(property_id, unit_id)

    if not unit:
        print(f"[create_unit_ad] ERROR: Unit {property_id}/{unit_id} not found in database.")
        sys.exit(1)

    print(f"[create_unit_ad] Found: {unit['address']}, ${unit['rent']}/mo")

    image_path = find_first_image(property_id, unit_id)
    if not image_path:
        print(f"[create_unit_ad] WARNING: No image found in {UPLOADS_BASE}/{property_id}/{unit_id}/")
        print("[create_unit_ad] Proceeding without image (ad may have no creative)...")
    else:
        print(f"[create_unit_ad] Using image: {image_path}")

    payload = build_ad_payload(unit, image_path)

    print(f"[create_unit_ad] Sending request to {NODE_ENDPOINT}...")
    try:
        result = create_ad(payload)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f"[create_unit_ad] HTTP Error {e.code}: {error_body}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[create_unit_ad] Connection Error: {e.reason}")
        print("[create_unit_ad] Is the Node.js server running? (npm start)")
        sys.exit(1)

    if result.get('success'):
        data = result['data']
        print(f"[create_unit_ad] SUCCESS — Ad created:")
        print(f"  Campaign ID:  {data['campaignId']}")
        print(f"  Ad Set ID:    {data['adSetId']}")
        print(f"  Creative ID:  {data['creativeId']}")
        print(f"  Ad ID:        {data['adId']}")
    else:
        print(f"[create_unit_ad] ERROR: {result.get('error')}")
        sys.exit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Make script executable**

Run: `chmod +x scripts/create_unit_ad.py`

- [ ] **Step 3: Test script help output**

Run: `python3 scripts/create_unit_ad.py`
Expected: `Usage: python3 scripts/create_unit_ad.py <property_id> <unit_id>`

- [ ] **Step 4: Test database lookup (no server needed)**

Run: `python3 -c "
import sys
sys.path.insert(0, 'scripts')
from create_unit_ad import get_unit_data
result = get_unit_data('test', 'test')
print('Found:' if result else 'Not found (expected for test ids)')
"`
Expected: `Not found (expected for test ids)` — verifies DB connection works

- [ ] **Step 5: Commit**

```bash
git add scripts/create_unit_ad.py
git commit -m "feat: add Python script to create Meta ads from SQLite unit data

Fetches unit data from properties_post table, finds hero image in
uploads folder, POSTs to /api/marketing/create-unit-ad endpoint.
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Verify End-to-End

**Prerequisites:** Node server running (`npm start`), real `property_id`/`unit_id` in `properties_post` table.

- [ ] **Step 1: Ensure Node server is running**

Run: `curl -s http://localhost:3000/health`
Expected: `{"status":"ok",...}`

- [ ] **Step 2: Run script with a known vacant unit**

Run: `python3 scripts/create_unit_ad.py <property_id> <unit_id>`
(Use real IDs that exist in your `properties_post` table)

Expected output:
```
[create_unit_ad] Fetching unit ... from database...
[create_unit_ad] Found: 123 Main St, $1800/mo
[create_unit_ad] Using image: /root/.openclaw/workspace/Finance/uploads/.../hero.jpg
[create_unit_ad] Sending request to http://localhost:3000/api/marketing/create-unit-ad...
[create_unit_ad] SUCCESS — Ad created:
  Campaign ID:  ...
  Ad Set ID:    ...
  Creative ID:  ...
  Ad ID:        ...
```

- [ ] **Step 3: Verify campaign appears in Meta Ads Manager**

Log into Meta Business Suite and check that a new PAUSED campaign was created with the expected name.

---

## Spec Coverage Check

| Spec Section | Task |
|--------------|------|
| Python script fetches from SQLite | Task 2 |
| Image folder lookup | Task 2 (`find_first_image`) |
| Ad payload template fields | Task 2 (`build_ad_payload`) |
| HTTP POST to Node endpoint | Task 2 (`create_ad`) |
| Node endpoint calls marketplace.js | Task 1 |
| Error handling (DB miss, HTTP fail, image not found) | Task 2 |
| Returns campaignId, adSetId, creativeId, adId | Task 1 & 2 |

All spec sections covered. No placeholders found.