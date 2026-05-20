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
from typing import Optional

DB_PATH = '/root/.openclaw/workspace/Finance/finance.db'
UPLOADS_BASE = '/root/.openclaw/workspace/Finance/units_photo'
NODE_ENDPOINT = 'http://localhost:3000/api/marketing/create-unit-ad'
DEFAULT_DESTINATION_URL = 'https://www.facebook.com'


def get_unit_data(property_id: str, unit_id: str) -> Optional[dict]:
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


def find_first_image(property_id: str, unit_id: str, image_folder: Optional[str] = None) -> Optional[str]:
    """Find first image file in the unit's image folder."""
    if image_folder:
        folder = os.path.join(UPLOADS_BASE, image_folder)
    else:
        folder = os.path.join(UPLOADS_BASE, property_id, unit_id)
    if not os.path.isdir(folder):
        return None
    for filename in sorted(os.listdir(folder)):
        if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            return os.path.join(folder, filename)
    return None


def build_ad_payload(unit: dict, image_path: Optional[str]) -> dict:
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

    image_path = find_first_image(property_id, unit_id, unit.get('image_folder'))
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

    if result.get('success') and result.get('data'):
        data = result['data']
        print(f"[create_unit_ad] SUCCESS — Ad created:")
        print(f"  Campaign ID:  {data['campaignId']}")
        print(f"  Ad Set ID:    {data['adSetId']}")
        print(f"  Creative ID:  {data['creativeId']}")
        print(f"  Ad ID:        {data['adId']}")
    else:
        print(f"[create_unit_ad] ERROR: {result.get('error', 'Unknown error')}")
        sys.exit(1)


if __name__ == '__main__':
    main()
