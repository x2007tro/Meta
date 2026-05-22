// src/phase1_messenger/rentalBot.js
const {
  sendTextMessage,
  sendTypingOn,
  sendAttachment,
} = require('./sendApi');
const { userReferrals } = require('./referralStore');
const config = require('../config');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');

// ─── State ───────────────────────────────────────────────────────

const STATE = {
  NEW_INQUIRY: 'NEW_INQUIRY',
  AWAITING_INFO: 'AWAITING_INFO',
  HANDOFF_TO_TAKASHI: 'HANDOFF_TO_TAKASHI',
  CLOSED: 'CLOSED',
};

// Persist per PSID
const userState = new Map(); // psid → { state, botMsgCount, fieldsCollected, name }

// Deduplicate webhook redeliveries (in-memory)
const processedMids = new Set();

// ─── Photo cache ──────────────────────────────────────────────────

const PHOTO_CACHE_DIR = '/tmp/photos_cache';

// ─── Field extraction helpers ────────────────────────────────────

const OCCUPATION_KEYWORDS = [
  'engineer', 'teacher', 'nurse', 'student', 'manager', 'analyst', 'doctor',
  'self-employed', 'developer', 'designer', 'accountant', 'lawyer', 'consultant',
  'administrator', 'technician', 'chef', 'driver', 'receptionist', 'sales',
  'marketing', 'finance', 'contractor', 'tradesperson', 'caregiver', 'retail',
];

const HOUSEHOLD_KEYWORDS = [
  'people', 'kids', 'child', 'dog', 'cat', 'pet', 'couple', 'single',
  'family', 'roommate', 'adult', 'adults',
];

const REASON_KEYWORDS = [
  'relocating', 'new job', 'downsizing', 'lease ending', 'school',
  'moving', 'transfer', 'promotion', 'starting',
];

/**
 * Extract name from message text
 */
function extractName(text) {
  const lowered = text.toLowerCase();
  // "I'm John" or "my name is John"
  const match = lowered.match(/(?:i'?m|my name is|this is)\s+([A-Z][a-z]+)/);
  if (match) return match[1];
  // First capitalized word early in message
  const simple = text.match(/^([A-Z][a-z]{1,15})\b/);
  if (simple) return simple[1];
  // "4. Myself" — digit followed by period and capitalized word
  const numberedMatch = text.match(/\d+\.\s*([A-Z][a-z]{1,15})/);
  if (numberedMatch) return numberedMatch[1];
  return null;
}

/**
 * Extract occupation keyword
 */
function extractOccupation(text) {
  const lowered = text.toLowerCase();
  for (const kw of OCCUPATION_KEYWORDS) {
    if (lowered.includes(kw)) return kw;
  }
  const workMatch = lowered.match(/(?:i work as|i work at|i'?m a)\s+(\w+)/);
  if (workMatch) return workMatch[1];
  return null;
}

/**
 * Extract income, normalize to monthly before-tax.
 * Input: "$50k/month" or "50000" or "50000/year"
 * Picks the LARGEST value to avoid greedy matching (e.g., "1 Ke 2 Analyst, 30000/year")
 */
function extractIncome(text) {
  const matches = [...text.matchAll(/\$?\s*(\d[\d,]*\.?\d*)\s*(k|K)?\s*(?:\/\s*(?:month|mo|year|yr))?/g)];
  if (!matches || matches.length === 0) return null;

  let bestValue = null;
  for (const match of matches) {
    let value = parseFloat(match[1].replace(/,/g, ''));
    const isK = !!match[2];
    if (isK) value *= 1000;
    // If >= 30000, assume annual — divide by 12
    if (value >= 30000) value = value / 12;
    // Keep the largest valid income
    if (bestValue === null || value > bestValue) {
      bestValue = Math.round(value);
    }
  }
  return bestValue;
}

/**
 * Extract move-in date using dateparser via Python subprocess.
 * Falls back to "ASAP" → today if unparseable.
 * Sanity check: if parsed date is in the past, add 1 year.
 */
async function extractMoveInDate(text) {
  const lower = text.toLowerCase().trim();
  if (lower === 'asap' || lower === 'immediately') {
    return new Date().toISOString().split('T')[0];
  }
  return new Promise((resolve) => {
    const proc = spawn('python3', [
      '-c',
      `
import sys, dateparser, datetime
d = dateparser.parse(sys.argv[1])
if d and d < datetime.datetime.now():
    d = d.replace(year=d.year + 1)
print(d.strftime('%Y-%m-%d') if d else '')
`,
      text,
    ]);
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.on('close', (code) => resolve(code === 0 && output.trim() ? output.trim() : null));
  });
}

/**
 * Extract household info (numbers + keywords)
 */
function extractHousehold(text) {
  const lowered = text.toLowerCase();
  for (const kw of HOUSEHOLD_KEYWORDS) {
    const idx = lowered.indexOf(kw);
    if (idx !== -1) {
      // Grab surrounding context (±30 chars)
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + kw.length + 30);
      return text.substring(start, end).trim();
    }
  }
  // "Myself" / "me alone" / "solo" / "alone" → 1 adult
  if (/\b(myself|me alone|solo|alone|i live|i'?m solo)\b/i.test(text)) {
    return '1 adult';
  }
  return null;
}

/**
 * Extract reason (relocation keywords or remaining sentence)
 */
function extractReason(text, name, occupation, income, moveInDate, household) {
  const lowered = text.toLowerCase();
  for (const kw of REASON_KEYWORDS) {
    if (lowered.includes(kw)) return kw;
  }
  return null;
}

// ─── Database ─────────────────────────────────────────────────────

let db;
function getDb() {
  if (!db) {
    db = new sqlite3.Database('/root/.openclaw/workspace/Finance/finance.db');
  }
  return db;
}

/**
 * Get unit row from properties_post by unit_id
 */
function getUnitById(propertyId, unitId) {
  return new Promise((resolve, reject) => {
    getDb().get(
      `SELECT * FROM properties_post WHERE property_id = ? AND unit_id = ?`,
      [propertyId, unitId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });
}

/**
 * Get unit row by ref (e.g. PROPStMary-UNITSM-01)
 */
function getUnitByRef(ref) {
  const match = ref && ref.match(/PROP(.+?)-UNIT(.+)/);
  if (!match) return Promise.resolve(null);
  return getUnitById(match[1], match[2]);
}

// ─── Email ────────────────────────────────────────────────────────

async function sendHandoffEmail(fields, unit, threadUrl) {
  const incomeToRent = fields.income && unit.rent ? (fields.income / unit.rent).toFixed(1) : 'n/a';
  const body = [
    '🏠 NEW QUALIFIED LEAD',
    '',
    `Unit: ${unit.unit_id} — ${unit.headline}`,
    `Location: ${unit.city}, ${unit.province}`,
    `Rent: $${unit.rent}/month`,
    '',
    'Applicant:',
    `• Name: ${fields.name}`,
    `• Occupation: ${fields.occupation}`,
    `• Monthly income: $${fields.income}`,
    `• Income-to-rent: ${incomeToRent}x`,
    `• Move-in date: ${fields.move_in_date}`,
    `• Household: ${fields.household}`,
    `• Reason: ${fields.reason || 'n/a'}`,
    '',
    `[Open Messenger thread](${threadUrl})`,
  ].join('\n');

  return new Promise((resolve) => {
    const emailPy = '/root/.openclaw/workspace/Gmail/email_client.py';
    const proc = spawn('python3', [emailPy, 'send', config.TAKASHI_EMAIL, '🏠 New Qualified Lead', body]);
    let errOutput = '';
    proc.stderr.on('data', (d) => (errOutput += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('[RentalBot] Email failed:', errOutput);
        resolve(false);
      } else {
        console.log('[RentalBot] Handoff email sent to Takashi');
        resolve(true);
      }
    });
  });
}

// ─── MarkdownV2 escape ─────────────────────────────────────────────

function escapeMD2(text) {
  if (!text) return '';
  return text.replace(/[_*\[\\]()~>#+\-=|{}.!]/g, (c) => '\\' + c);
}

// ─── Response builders ───────────────────────────────────────────

function fillTemplate(template, unit, numBedroom) {
  return template
    .replace(/\{num_bedroom\}/g, numBedroom || '')
    .replace(/\{headline\}/g, unit.headline || '');
}

function buildResponse1(unit) {
  const numBedroom = unit.num_bedroom || '';
  const headline = fillTemplate(unit.headline, unit, numBedroom);
  return `Hi! Thanks for your interest in ${headline}. I'm Takashi — I manage this rental personally.

To make sure it's a good fit on both sides, could you reply with:

1. Your name
2. Occupation & approximate monthly income (before tax)
3. Move-in date you're targeting
4. Who's moving in (number of adults, kids, pets)
5. One sentence on why you're moving

Once I have these, I'll confirm availability and suggest showing times. Reply "photos" anytime if you'd like to see more pictures. This is an auto-reply — Takashi reviews qualified inquiries personally within 24 hours. 🙏`;
}

function buildResponse2A(name) {
  return `Thanks, ${name}! I have everything I need. Takashi will review and reply within 24 hours with showing times that work. Talk soon!`;
}

const LABELS = {
  name: '• Your name',
  occupation: '• Occupation & monthly income (before tax)',
  income: '• Monthly income (before tax)',
  move_in_date: '• Move-in date you\'re targeting',
  household: '• Who\'s moving in (adults, kids, pets)',
  reason: '• Why you\'re moving',
};

function buildResponse2B(name, missingFields) {
  const bullets = missingFields
    .map((f) => LABELS[f] || `• ${f}`)
    .join('\n');
  return `Thanks ${name}! Just need a couple more details:

${bullets}

Once I have these, Takashi will reach out with showing times.`;
}

const QUESTION_ANSWERS = {
  available: (unit) =>
    unit.status === 'available'
      ? 'Yes, it\'s still available.'
      : 'This unit just got rented — I\'ll let Takashi know in case you\'d like to hear about similar units.',
  pet: (unit) => {
    if (unit.description && /pet|cat|dog|animal/i.test(unit.description)) {
      return null; // use description
    }
    return 'Pets are case-by-case — Takashi will discuss at viewing.';
  },
  parking: (unit) =>
    unit.has_parking == 1 ? 'Yes, parking is included.' : 'No on-site parking.',
  laundry: (unit) => {
    if (unit.laundry_type === 'in_unit') return 'In-unit washer and dryer.';
    if (unit.laundry_type === 'in_building') return 'Shared laundry in the building.';
    return 'Laundry details vary by unit — Takashi will clarify.';
  },
  utility: (unit) => {
    if (unit.utility_included && unit.utility_included !== '0') {
      return `Utilities included: ${unit.utility_included}.`;
    }
    return 'Utility details vary — Takashi will clarify at viewing.';
  },
  sqft: (unit) => (unit.sqft ? `The unit is ${unit.sqft} sq ft.` : null),
  rent: (unit) => `Rent is $${unit.rent}/month.`,
  view: () =>
    'Takashi schedules viewings after a quick intro. Could you reply with the 5 details above and he\'ll send time options?',
  deposit: () =>
    'Takashi will walk through lease terms and deposits at the viewing — these vary by unit.',
};

function answerQuestion(text, unit) {
  const lower = text.toLowerCase();
  for (const [kw, fn] of Object.entries(QUESTION_ANSWERS)) {
    if (lower.includes(kw)) {
      const answer = fn(unit);
      if (answer !== null) return answer;
    }
  }
  return null;
}

function buildResponse2C(name) {
  return `Good question — Takashi will answer that directly. Could you first reply with the 5 details above so he has context?

To move forward, could you reply with:
1. Your name
2. Occupation & monthly income (before tax)
3. Move-in date
4. Who's moving in (adults, kids, pets)
5. Why you're moving`;
}

function buildResponse2D(name) {
  return `Hi ${name || ''}! To check if this unit's a fit, I'll need a bit more info — could you share:

1. Your name
2. Occupation & monthly income (before tax)
3. Move-in date
4. Who's moving in (adults, kids, pets)
5. Why you're moving

If now's not a good time to type all this out, just reply when you can — no rush.`;
}

function buildPhotoReply(name) {
  return `Here are all the photos for this unit${name ? ', ' + name : ''}. Let me know if you have other questions, or reply with the 5 details above and Takashi will be in touch about a viewing.`;
}

// ─── Photo ZIP ────────────────────────────────────────────────────

async function getPhotoZip(unit) {
  const { image_folder: folderName, property_id: propertyId, unit_id: unitId } = unit;
  if (!folderName) return null;

  const photoDir = path.join('/root/.openclaw/workspace/RealEstate/units_photo', folderName);
  if (!fs.existsSync(photoDir)) return null;

  const files = fs.readdirSync(photoDir).filter((f) =>
    /\.(jpe?g|png|webp)$/i.test(f)
  );
  if (files.length === 0) return null;

  const cachePath = path.join(PHOTO_CACHE_DIR, `${unitId}_photos.zip`);
  const folderMtime = fs.statSync(photoDir).mtime;

  // Rebuild if folder newer than cache
  if (!fs.existsSync(cachePath) || fs.statSync(cachePath).mtime < folderMtime) {
    fs.mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
    const proc = spawn('zip', ['-j', cachePath, ...files.map((f) => path.join(photoDir, f))]);
    await new Promise((res) => proc.on('close', res));
  }

  const stat = fs.statSync(cachePath);
  return stat.size <= 25 * 1024 * 1024 ? cachePath : 'oversized';
}

// ─── Message classifier ──────────────────────────────────────────

async function classifyReply(text, state) {
  const lower = text.toLowerCase();

  // F: Photos request (fires from any state, state preserved)
  const photoKeywords = ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'more photo', 'see more'];
  if (photoKeywords.some((kw) => lower.includes(kw))) {
    return { bucket: 'F' };
  }

  // E: Spam — profanity or gibberish
  const profanity = /^[^\w]*([\W_])\1+$/.test(text) || /(?:\bass\s*\w*\s*hole|sh[i1]t|[fv]\s*ck|stupid|idiot|dumb)/i.test(text);
  if (profanity) return { bucket: 'E' };

  // Extract all fields
  const name = extractName(text);
  const occupation = extractOccupation(text);
  const income = extractIncome(text);
  const move_in_date = await extractMoveInDate(text);
  const household = extractHousehold(text);
  const reason = extractReason(text, name, occupation, income, move_in_date, household);

  const collected = { name, occupation, income, move_in_date, household, reason };
  const count = [name, occupation, income, move_in_date, household, reason].filter(Boolean).length;

  // C: Question
  if (/\?|how|what|when|where|why|can i|could i|is there|do es/.test(lower)) {
    return { bucket: 'C', fields: collected, count };
  }

  // A: Complete (all 5 required fields)
  if (name && occupation && income && move_in_date && household) {
    return { bucket: 'A', fields: collected, count };
  }

  // B: Partial (2–4 fields)
  if (count >= 2) {
    return { bucket: 'B', fields: collected, count };
  }

  // D: Minimal (0–1 fields)
  return { bucket: 'D', fields: collected, count };
}

// ─── Main handler ────────────────────────────────────────────────

async function handleRentalMessage(senderId, messageEvent) {
  const mid = messageEvent.mid;

  // Idempotency check
  if (processedMids.has(mid)) return;
  processedMids.add(mid);
  // Prune old mids (keep set bounded)
  if (processedMids.size > 10000) {
    const arr = [...processedMids];
    arr.slice(0, 5000).forEach((m) => processedMids.delete(m));
  }

  const text = messageEvent.text || '';
  const referralRef = userReferrals.get(senderId);
  const stateData = userState.get(senderId) || {
    state: STATE.NEW_INQUIRY,
    botMsgCount: 0,
    fieldsCollected: {},
    name: null,
  };

  // Load unit data
  const unit = await getUnitByRef(referralRef);

  // ── Photo request from HANDOFF (state preserved) ──
  const lower = text.toLowerCase();
  const isPhotoReq = ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'more photo', 'see more'].some((kw) =>
    lower.includes(kw)
  );

  if (isPhotoReq) {
    const zipPath = unit ? await getPhotoZip(unit) : null;
    if (zipPath === 'oversized') {
      await sendTypingOn(senderId);
      await sendTextMessage(
        senderId,
        "There are a lot of photos for this unit — Takashi will email them over after you send the 5 details above."
      );
    } else if (zipPath && fs.existsSync(zipPath)) {
      // Use public URL for attachment — serve from APP_URL
      const zipUrl = `${config.APP_URL}/photos/${unit.unit_id}_photos.zip`;
      await sendTypingOn(senderId);
      await sendAttachment(senderId, 'file', zipUrl);
      await sendTextMessage(senderId, buildPhotoReply(stateData.name));
    } else {
      await sendTextMessage(
        senderId,
        "Sorry, no extra photos are available for this one beyond what's posted on Marketplace. Happy to answer any specific questions about the unit."
      );
    }
    return; // state unchanged
  }

  // ── HANDOFF_TO_TAKASHI: relay to Takashi via email ──
  if (stateData.state === STATE.HANDOFF_TO_TAKASHI) {
    // Relay reply to Takashi via email (simple: just forward text)
    if (text.trim()) {
      const threadUrl = `https://m.me/${config.PAGE_ID}?ref=${referralRef || ''}`;
      const name = stateData.name || 'Unknown';
      const body = `Reply from ${name} (PSID: ${senderId}):\n\n${text}\n\nThread: ${threadUrl}`;
      spawn('python3', [
        '/root/.openclaw/workspace/Gmail/email_client.py',
        'send',
        config.TAKASHI_EMAIL,
        `Reply from ${name}`,
        body,
      ]);
    }
    return; // no bot reply
  }

  // ── CLOSED: ignore ──
  if (stateData.state === STATE.CLOSED) {
    return;
  }

  // ── NEW_INQUIRY ──
  if (stateData.state === STATE.NEW_INQUIRY) {
    stateData.state = STATE.AWAITING_INFO;
    const reply = unit ? buildResponse1(unit) : 'Hi! Thanks for your interest. Could you reply with: 1. Your name, 2. Occupation & monthly income (before tax), 3. Move-in date, 4. Who\'s moving in, 5. Why you\'re moving. I\'ll get back to you shortly.';
    await sendTypingOn(senderId);
    await sendTextMessage(senderId, reply);
    userState.set(senderId, stateData);
    return;
  }

  // ── AWAITING_INFO: classify ──
  if (stateData.state === STATE.AWAITING_INFO) {
    const classification = await classifyReply(text, stateData.state);
    const { bucket, fields } = classification;

    // Update name if found
    if (fields.name) stateData.name = fields.name;
    stateData.fieldsCollected = { ...stateData.fieldsCollected, ...fields };

    // E: Spam — no reply, close
    if (bucket === 'E') {
      stateData.state = STATE.CLOSED;
      userState.set(senderId, stateData);
      return;
    }

    // F: Photos already handled above (early return)
    // C: Question
    if (bucket === 'C') {
      const answer = unit ? answerQuestion(text, unit) : null;
      let reply = answer || 'Good question — Takashi will answer that directly. Could you first reply with the 5 details above so he has context?';
      reply += '\n\nTo move forward, could you reply with:\n1. Your name\n2. Occupation & monthly income (before tax)\n3. Move-in date\n4. Who\'s moving in (adults, kids, pets)\n5. Why you\'re moving';
      await sendTypingOn(senderId);
      await sendTextMessage(senderId, reply);
      stateData.botMsgCount++;
      userState.set(senderId, stateData);
      return;
    }

    // A: Complete → HANDOFF
    if (bucket === 'A') {
      stateData.state = STATE.HANDOFF_TO_TAKASHI;
      stateData.fieldsCollected = fields;
      userState.set(senderId, stateData);

      await sendTypingOn(senderId);
      await sendTextMessage(senderId, buildResponse2A(stateData.name || fields.name || 'there'));

      if (unit) {
        const threadUrl = `https://m.me/${config.PAGE_ID}?ref=${referralRef || ''}`;
        await sendHandoffEmail(fields, unit, threadUrl);
      }
      return;
    }

    // B: Partial → ask for missing
    if (bucket === 'B') {
      const required = ['name', 'occupation', 'income', 'move_in_date', 'household'];
      const name = fields.name || stateData.name;

      // Build missing list — income is always evaluated separately
      const missing = required.filter((f) => !fields[f] && f !== 'income');

      // Special case: if both occupation AND income missing → de-dupe to one bullet
      // If only income missing (occupation present) → show income bullet
      // If only occupation missing (income present) → show occupation bullet
      if (!fields.occupation && !fields.income) {
        // both missing — occupation label covers both, already in missing list as 'occupation'
      } else if (fields.occupation && !fields.income) {
        // income missing alone — swap 'occupation' for 'income' in missing
        const idx = missing.indexOf('occupation');
        if (idx !== -1) missing.splice(idx, 1, 'income');
      } else if (!fields.occupation && fields.income) {
        // occupation missing alone — keep 'occupation' in missing list
      }

      await sendTypingOn(senderId);
      await sendTextMessage(senderId, buildResponse2B(name || 'there', missing));
      stateData.botMsgCount++;
      userState.set(senderId, stateData);
      return;
    }

    // D: Minimal
    if (bucket === 'D') {
      stateData.botMsgCount++;
      if (stateData.botMsgCount >= 3) {
        stateData.state = STATE.CLOSED;
        userState.set(senderId, stateData);
        return;
      }
      await sendTypingOn(senderId);
      await sendTextMessage(senderId, buildResponse2D(stateData.name));
      userState.set(senderId, stateData);
      return;
    }
  }
}

module.exports = {
  handleRentalMessage,
  STATE,
};