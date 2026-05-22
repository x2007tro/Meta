// src/phase1_messenger/rentalBot.js
const {
  sendTextMessage,
  sendTypingOn,
  sendAttachment,
  sendQuickReplies,
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
  const body = [
    '🏠 NEW QUALIFIED LEAD',
    '',
    `Unit: ${unit.unit_id} — ${unit.headline}`,
    `Location: ${unit.city}, ${unit.province}`,
    `Rent: $${unit.rent}/month`,
    '',
    'Applicant:',
    `• Name: ${fields.name || 'n/a'}`,
    `• Occupation: ${fields.occupation || 'n/a'}`,
    `• Adults: ${fields.adults || 'n/a'}`,
    `• Kids: ${fields.kids || 'n/a'}`,
    `• Phone: ${fields.phone || 'n/a'}`,
    `• Income: ${fields.income || 'n/a'}`,
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

  // ── 1. Mid deduplication ──
  if (processedMids.has(mid)) return;
  processedMids.add(mid);
  if (processedMids.size > 10000) {
    const arr = [...processedMids];
    arr.slice(0, 5000).forEach((m) => processedMids.delete(m));
  }

  // ── 2. Get / init stateData ──
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

  // ── 3. Load unit data ──
  const unit = await getUnitByRef(referralRef);

  // ── 4. Photo request (state unchanged) ──
  const lower = text.toLowerCase();
  const isPhotoReq = ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'more photo', 'see more'].some(
    (kw) => lower.includes(kw)
  );

  if (isPhotoReq) {
    if (stateData.state !== STATE.AWAITING_INFO && stateData.state !== STATE.NEW_INQUIRY && stateData.state !== STATE.HANDOFF_TO_TAKASHI) {
      return; // only serve photos in active conversation states
    }
    const zipPath = unit ? await getPhotoZip(unit) : null;
    if (zipPath === 'oversized') {
      await sendTypingOn(senderId);
      await sendTextMessage(
        senderId,
        "There are a lot of photos for this unit — Takashi will email them over after you send the details."
      );
    } else if (zipPath && fs.existsSync(zipPath)) {
      const zipUrl = `${config.APP_URL}/photos/${unit.unit_id}_photos.zip`;
      await sendTypingOn(senderId);
      await sendAttachment(senderId, 'file', zipUrl);
    } else {
      await sendTextMessage(
        senderId,
        "Sorry, no extra photos are available for this one beyond what's posted on Marketplace. Happy to answer any specific questions."
      );
    }
    return;
  }

  // ── 5. HANDOFF_TO_TAKASHI: relay replies to Takashi via email ──
  if (stateData.state === STATE.HANDOFF_TO_TAKASHI) {
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
    return;
  }

  // ── 6. CLOSED: ignore ──
  if (stateData.state === STATE.CLOSED) {
    return;
  }

  // ── 7. NEW_INQUIRY: start step-based flow ──
  if (stateData.state === STATE.NEW_INQUIRY) {
    stateData.state = STATE.AWAITING_INFO;
    stateData.step = STEP.NAME;
    stateData.fieldsCollected = {
      name: null,
      adults: null,
      kids: null,
      phone: null,
      occupation: null,
      income: null,
    };
    stateData.name = null;
    stateData.invalidAttempts = 0;
    userState.set(senderId, stateData);
    await sendQuestion(senderId, STEP.NAME, null);
    return;
  }

  // ── 8. AWAITING_INFO: step-based flow ──
  if (stateData.state === STATE.AWAITING_INFO) {
    // Quick-reply steps: ADULTS, KIDS, INCOME
    if (isQuickReplyStep(stateData.step)) {
      if (!hasQuickReply(messageEvent)) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, stateData.step);
        userState.set(senderId, stateData);
        return;
      }

      const payload = messageEvent.quick_reply.payload;
      let value = null;

      if (stateData.step === STEP.ADULTS) {
        const map = { adults_1: '1', adults_2: '2', adults_3: '3', adults_4: '4', adults_5plus: '5+' };
        value = map[payload] || null;
      } else if (stateData.step === STEP.KIDS) {
        const map = { kids_0: '0', kids_1: '1', kids_2: '2', kids_3: '3', kids_4: '4', kids_5plus: '5+' };
        value = map[payload] || null;
      } else if (stateData.step === STEP.INCOME) {
        const map = {
          income_1: 'Below $30,000/year',
          income_2: '$30,000–$80,000/year',
          income_3: '$80,000–$150,000/year',
          income_4: 'Above $150,000/year',
        };
        value = map[payload] || null;
      }

      // Save field and advance
      if (value !== null) {
        if (stateData.step === STEP.ADULTS) stateData.fieldsCollected.adults = value;
        else if (stateData.step === STEP.KIDS) stateData.fieldsCollected.kids = value;
        else if (stateData.step === STEP.INCOME) stateData.fieldsCollected.income = value;

        stateData.invalidAttempts = 0;
        stateData.step++;

        if (stateData.step > STEP.INCOME) {
          // Transition to HANDOFF
          stateData.state = STATE.HANDOFF_TO_TAKASHI;
          userState.set(senderId, stateData);
          const displayName = stateData.name || stateData.fieldsCollected.name || 'there';
          await sendTypingOn(senderId);
          await sendTextMessage(
            senderId,
            `Perfect, ${displayName}! I've collected everything. Takashi will be in touch shortly.`
          );
          if (unit) {
            const threadUrl = `https://m.me/${config.PAGE_ID}?ref=${referralRef || ''}`;
            await sendHandoffEmail(stateData.fieldsCollected, unit, threadUrl);
          }
          return;
        }

        userState.set(senderId, stateData);
        await sendQuestion(senderId, stateData.step, stateData.name);
        return;
      }
    }

    // Text steps: NAME, PHONE, OCCUPATION
    if (stateData.step === STEP.NAME) {
      const trimmed = (text || '').trim();
      if (!trimmed) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, STEP.NAME);
        userState.set(senderId, stateData);
        return;
      }
      stateData.name = trimmed;
      stateData.fieldsCollected.name = trimmed;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.ADULTS;
      userState.set(senderId, stateData);
      await sendQuestion(senderId, STEP.ADULTS, trimmed);
      return;
    }

    if (stateData.step === STEP.PHONE) {
      if (!isValidPhone(text)) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, STEP.PHONE);
        userState.set(senderId, stateData);
        return;
      }
      const digits = text.replace(/\D/g, '');
      const normalized = digits.slice(-10);
      stateData.fieldsCollected.phone = normalized;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.OCCUPATION;
      userState.set(senderId, stateData);
      await sendQuestion(senderId, STEP.OCCUPATION, stateData.name);
      return;
    }

    if (stateData.step === STEP.OCCUPATION) {
      const trimmed = (text || '').trim();
      if (!trimmed) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, STEP.OCCUPATION);
        userState.set(senderId, stateData);
        return;
      }
      stateData.fieldsCollected.occupation = trimmed;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.INCOME;
      userState.set(senderId, stateData);
      await sendQuestion(senderId, STEP.INCOME, stateData.name);
      return;
    }

    // Fallback: unknown step — ask current step question
    await sendQuestion(senderId, stateData.step, stateData.name);
  }
}

module.exports = {
  handleRentalMessage,
  STATE,
};