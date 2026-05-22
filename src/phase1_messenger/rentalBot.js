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

// ─── Step constants ────────────────────────────────────────────────

const STEP = {
  NAME: 1,
  ADULTS: 2,
  KIDS: 3,
  PHONE: 4,
  OCCUPATION: 5,
  INCOME: 6,
};

// ─── Validation helpers ────────────────────────────────────────────

/**
 * Validate phone number — North American format
 * Accepts: 4165551234, (416) 555-1234, 416-555-1234, +1 4165551234
 * Must contain exactly 10 consecutive digits
 */
function isValidPhone(text) {
  const digits = text.replace(/\D/g, '');
  return digits.length === 10;
}

/**
 * Check if a step requires quick-reply input only
 */
function isQuickReplyStep(step) {
  return step === STEP.ADULTS || step === STEP.KIDS || step === STEP.INCOME;
}

/**
 * Check if quick reply payload is present (quick-reply tap detected)
 */
function hasQuickReply(messageEvent) {
  return !!(messageEvent.quick_reply && messageEvent.quick_reply.payload);
}

// ─── Quick-reply option sets ───────────────────────────────────────

function buildAdultsOptions() {
  return [
    { content_type: 'text', title: '1', payload: 'adults_1' },
    { content_type: 'text', title: '2', payload: 'adults_2' },
    { content_type: 'text', title: '3', payload: 'adults_3' },
    { content_type: 'text', title: '4', payload: 'adults_4' },
    { content_type: 'text', title: '5+', payload: 'adults_5plus' },
  ];
}

function buildKidsOptions() {
  return [
    { content_type: 'text', title: '0', payload: 'kids_0' },
    { content_type: 'text', title: '1', payload: 'kids_1' },
    { content_type: 'text', title: '2', payload: 'kids_2' },
    { content_type: 'text', title: '3', payload: 'kids_3' },
    { content_type: 'text', title: '4', payload: 'kids_4' },
    { content_type: 'text', title: '5+', payload: 'kids_5plus' },
  ];
}

function buildIncomeOptions() {
  return [
    { content_type: 'text', title: 'Below $30,000/year', payload: 'income_1' },
    { content_type: 'text', title: '$30,000–$80,000/year', payload: 'income_2' },
    { content_type: 'text', title: '$80,000–$150,000/year', payload: 'income_3' },
    { content_type: 'text', title: 'Above $150,000/year', payload: 'income_4' },
  ];
}

/**
 * Send the question for a given step (1-6)
 */
async function sendQuestion(senderId, step, name) {
  const nameCtx = name ? `, ${name}` : '';

  switch (step) {
    case STEP.NAME:
      await sendTextMessage(senderId, "Hi! Thanks for your interest. I'm Takashi — I manage this rental personally.\n\nTo get started, what's your name?");
      break;

    case STEP.ADULTS:
      await sendQuickReplies(
        senderId,
        `Hi${nameCtx}! Nice to meet you. How many adults will be living in the unit?`,
        buildAdultsOptions()
      );
      break;

    case STEP.KIDS:
      await sendQuickReplies(
        senderId,
        `Got it${nameCtx}. And how many kids?`,
        buildKidsOptions()
      );
      break;

    case STEP.PHONE:
      await sendTextMessage(senderId, `Perfect${nameCtx}. What's your phone number? (so Takashi can reach you)`);
      break;

    case STEP.OCCUPATION:
      await sendTextMessage(senderId, `Thanks${nameCtx}! What's your occupation?`);
      break;

    case STEP.INCOME:
      await sendQuickReplies(
        senderId,
        `Last question${nameCtx} — what's your annual income range?`,
        buildIncomeOptions()
      );
      break;

    default:
      await sendTextMessage(senderId, "Something went wrong. Let's start over — what's your name?");
  }
}

/**
 * Send invalid answer response with step-specific hint
 */
async function sendInvalidAnswer(senderId, step) {
  const hints = {
    [STEP.NAME]: "Sorry, I didn't catch that. Please enter your name (e.g., John)",
    [STEP.ADULTS]: "Please tap one of the options below.",
    [STEP.KIDS]: "Please tap one of the options below.",
    [STEP.PHONE]: "Please enter a valid 10-digit North American phone number (e.g., 4165551234)",
    [STEP.OCCUPATION]: "Please enter your occupation (e.g., Engineer)",
    [STEP.INCOME]: "Please tap one of the income options below.",
  };
  await sendTextMessage(senderId, hints[step] || "Please try again.");
}

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
    step: STEP.NAME,
    fieldsCollected: {
      name: null,
      adults: null,
      kids: null,
      phone: null,
      occupation: null,
      income: null,
    },
    name: null,
    invalidAttempts: 0,
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