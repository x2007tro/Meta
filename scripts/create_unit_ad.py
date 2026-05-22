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
UPLOADS_BASE = '/root/.openclaw/workspace/RealEstate/units_photo'
NODE_ENDPOINT = 'http://localhost:3000/api/marketing/create-unit-ad'
DEFAULT_DESTINATION_URL = 'https://www.facebook.com'


def get_unit_data(property_id: str, unit_id: str) -> Optional[dict]:
    """Fetch unit row from properties_post table."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        '''SELECT property_id, unit_id, address, description,
                  rent, building_type, num_bedroom, num_bathroom,
                  laundry_type, has_backyard, has_AC, has_parking,
                  utility_included, sqft, available_from,
                  status, image_folder, city, province, country
           FROM properties_post
           WHERE property_id = ? AND unit_id = ?''',
        (property_id, unit_id)
    )
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def find_all_images(property_id: str, unit_id: str, image_folder: Optional[str] = None) -> list:
    """Find all image files in the unit's image folder.

    If cover.jpg exists in the folder, it is placed first in the list.
    """
    if image_folder:
        folder = os.path.join(UPLOADS_BASE, image_folder)
    else:
        folder = os.path.join(UPLOADS_BASE, property_id, unit_id)
    if not os.path.isdir(folder):
        return []
    images = []
    cover_path = os.path.join(folder, 'cover.jpg')
    for filename in sorted(os.listdir(folder)):
        if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            filepath = os.path.join(folder, filename)
            # Put cover.jpg first
            if filepath == cover_path:
                images.insert(0, filepath)
            else:
                images.append(filepath)
    return images


def fill_template(template: str, unit: dict) -> str:
    """Replace placeholders in template with actual values."""
    if not template:
        return ''
    replacements = {
        '{num_bedroom}': str(unit.get('num_bedroom', '')),
        '{num_bathroom}': str(unit.get('num_bathroom', '')),
        '{building_type}': str(unit.get('building_type', '')),
        '{city}': str(unit.get('city', '')),
        '{province}': str(unit.get('province', '')),
        '{laundry_type}': str(unit.get('laundry_type', '')),
        '{has_AC}': str(unit.get('has_AC', '')),
        '{has_parking}': str(unit.get('has_parking', '')),
        '{utility_included}': str(unit.get('utility_included', '')),
        '{rent}': str(unit.get('rent', '')),
        '{available_from}': str(unit.get('available_from', '')),
        '{sqft}': str(unit.get('sqft', '')),
    }
    result = template
    for placeholder, value in replacements.items():
        result = result.replace(placeholder, value)
    return result


def build_ad_payload(unit: dict, image_paths: list) -> dict:
    """Build the ad creation payload from unit data."""
    address = unit['address'] or 'Unknown Address'
    rent = unit['rent'] or 0
    city = unit.get('city', '')
    province = unit.get('province', '')
    building_type = unit.get('building_type', 'unit')
    num_bedroom = unit.get('num_bedroom', '')
    num_bathroom = unit.get('num_bathroom', '')

    return {
        'propertyId': unit['property_id'],
        'unitId': unit['unit_id'],
        'campaignName': f"{unit['property_id']}-{unit['unit_id']}",
        'objective': 'OUTCOME_ENGAGEMENT',
        'specialAdCategories': ['HOUSING'],
        'adSetName': f"{city}, {province} AdSet",
        'dailyBudgetCents': 200,
        'country': unit.get('country') or 'CA',
        'adName': f"{city} {building_type.title()} Ad",
        'destinationUrl': DEFAULT_DESTINATION_URL,
        'primaryText': fill_template(unit.get('feature', ''), unit),
        'headline': fill_template(unit.get('headline', ''), unit),
        'description': fill_template(unit.get('description', ''), unit),
        'imageFilePath': image_paths[0] if image_paths else '',
        'ref': f"PROP{unit['property_id']}-UNIT{unit['unit_id']}",
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


def parse_args():
    """Parse command line arguments."""
    args = sys.argv[1:]
    kwargs = {}
    # Parse --key=value flags
    args = [a for a in args if a.startswith('--')]
    for arg in args:
        if '=' in arg:
            key, value = arg[2:].split('=', 1)
            kwargs[key] = value
    return kwargs


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 scripts/create_unit_ad.py <property_id> <unit_id> [--campaign-name=<name>] [--objective=<objective>]")
        sys.exit(1)

    extra = parse_args()

    property_id = sys.argv[1]
    unit_id = sys.argv[2]

    print(f"[create_unit_ad] Fetching unit {property_id}/{unit_id} from database...")
    unit = get_unit_data(property_id, unit_id)

    if not unit:
        print(f"[create_unit_ad] ERROR: Unit {property_id}/{unit_id} not found in database.")
        sys.exit(1)

    print(f"[create_unit_ad] Found: {unit['address']}, ${unit['rent']}/mo")

    image_paths = find_all_images(property_id, unit_id, unit.get('image_folder'))
    if not image_paths:
        print(f"[create_unit_ad] WARNING: No images found in {UPLOADS_BASE}/{property_id}/{unit_id}/")
        print("[create_unit_ad] Proceeding without images (ad may have no creative)...")
    else:
        print(f"[create_unit_ad] Using {len(image_paths)} images: {image_paths[0]}...")

    payload = build_ad_payload(unit, image_paths)

    # Override with command-line extras (--campaign-name, --objective, etc.)
    for key in ('campaignName', 'objective', 'destinationUrl', 'dailyBudgetCents', 'adName'):
        if key in extra:
            payload[key] = extra[key]

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
