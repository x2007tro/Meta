# Sequential Question Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the batch field extraction approach with a strict one-question-at-a-time flow. Each step validates input, advances on success, re-asks on failure. Quick-reply buttons for numeric fields (adults, kids, income). Phone validation via regex.

**Architecture:** The existing 4-state FSM (`NEW_INQUIRY → AWAITING_INFO → HANDOFF_TO_TAKASHI → CLOSED`) is preserved. The `AWAITING_INFO` state gains a `step` sub-state (1-6) tracking which question. The `classifyReply` and bucket logic is replaced with step-specific validation functions. `invalidAttempts` counter tracks consecutive failures at the same step.

**Tech Stack:** Node.js, sqlite3, Meta Messenger Send API, Python dateparser

---

## File Map

- **Modify:** `src/phase1_messenger/rentalBot.js` — replace the batch extraction logic with step-based sequential flow
- **Read:** `src/phase1_messenger/sendApi.js` — already has `sendQuickReplies` (no changes needed)

---

## Task 1: Add step tracking and validation helpers

**Files:**
- Modify: `src/phase1_messenger/rentalBot.js` — add constants, helpers, and state data changes

- [ ] **Step 1: Replace extraction helpers with step validators**

Delete the following functions (no longer needed):
- `extractName`, `extractOccupation`, `extractIncome`, `extractMoveInDate`, `extractHousehold`, `extractReason`
- `classifyReply`
- `OCCUPATION_KEYWORDS`, `HOUSEHOLD_KEYWORDS`, `REASON_KEYWORDS` arrays
- `LABELS`, `buildResponse1`, `buildResponse2A`, `buildResponse2B`, `buildResponse2C`, `buildResponse2D`, `buildPhotoReply`
- `answerQuestion`, `QUESTION_ANSWERS`

Add these constants and helpers at the top of the file (after existing requires):

```javascript
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
```

- [ ] **Step 2: Update state data initialization**

In `handleRentalMessage`, find the state initialization:
```javascript
const stateData = userState.get(senderId) || {
  state: STATE.NEW_INQUIRY,
  botMsgCount: 0,
  fieldsCollected: {},
  name: null,
};
```

Replace with:
```javascript
const stateData = userState.get(senderId) || {
  state: STATE.NEW_INQUIRY,
  step: STEP.NAME,      // which question we're on
  fieldsCollected: {
    name: null,
    adults: null,
    kids: null,
    phone: null,
    occupation: null,
    income: null,
  },
  name: null,           // sticky name for personalized replies
  invalidAttempts: 0,   // consecutive invalid at same step
};
```

Remove `botMsgCount` — it's no longer needed (replaced by `invalidAttempts`).

- [ ] **Step 3: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/rentalBot')" 2>&1`
Expected: No output (OK)

---

## Task 2: Add question sending functions

**Files:**
- Modify: `src/phase1_messenger/rentalBot.js` — add functions after the helpers section

- [ ] **Step 1: Add quick-reply option builders**

```javascript
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
```

- [ ] **Step 2: Add sendQuestion function**

```javascript
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
      stateData.step = STEP.NAME;
  }
}
```

- [ ] **Step 3: Add invalid answer handler**

```javascript
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
  await sendTextMessage(senderId, `${hints[step] || "Please try again."}\n\nPlease try again.`);
}
```

- [ ] **Step 4: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/rentalBot')" 2>&1`
Expected: No output (OK)

---

## Task 3: Replace handleRentalMessage body with step-based flow

**Files:**
- Modify: `src/phase1_messenger/rentalBot.js` — rewrite the main handler logic

- [ ] **Step 1: Replace the handler body**

Find the `handleRentalMessage` function body (starting around line 423 after state init) and replace everything from after the unit load up to `module.exports`. Keep:
- The `mid` deduplication check
- The photo request handling (preserve it as-is, state unchanged)
- The `HANDOFF_TO_TAKASHI` relay block (preserve as-is)
- The `CLOSED` early return block (preserve as-is)

Replace the `NEW_INQUIRY` and `AWAITING_INFO` blocks with:

```javascript
  // ── Photo request (any state, preserves step) ──
  const lower = text.toLowerCase();
  const isPhotoReq = ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'more photo', 'see more'].some((kw) =>
    lower.includes(kw)
  );

  if (isPhotoReq) {
    const zipPath = unit ? await getPhotoZip(unit) : null;
    if (zipPath === 'oversized') {
      await sendTypingOn(senderId);
      await sendTextMessage(senderId, "There are a lot of photos for this unit — Takashi will email them over after you finish answering a few questions.");
    } else if (zipPath && fs.existsSync(zipPath)) {
      const zipUrl = `${config.APP_URL}/photos/${unit.unit_id}_photos.zip`;
      await sendTypingOn(senderId);
      await sendAttachment(senderId, 'file', zipUrl);
      const photoReply = name
        ? `Here are the photos, ${name}. Let me know if you have other questions — just tap an answer below when you're ready to continue.`
        : `Here are the photos. Let me know if you have other questions — just tap an answer below when you're ready to continue.`;
      await sendTextMessage(senderId, photoReply);
    } else {
      await sendTextMessage(senderId, "Sorry, no extra photos are available for this one. Happy to answer any specific questions you have.");
    }
    // Photo request does NOT advance the step
    userState.set(senderId, stateData);
    return;
  }

  // ── NEW_INQUIRY ──
  if (stateData.state === STATE.NEW_INQUIRY) {
    stateData.state = STATE.AWAITING_INFO;
    stateData.step = STEP.NAME;
    stateData.invalidAttempts = 0;
    stateData.fieldsCollected = {
      name: null, adults: null, kids: null, phone: null, occupation: null, income: null,
    };
    await sendQuestion(senderId, STEP.NAME, null);
    userState.set(senderId, stateData);
    return;
  }

  // ── AWAITING_INFO: step-based validation ──
  if (stateData.state === STATE.AWAITING_INFO) {
    const step = stateData.step;
    const text = messageEvent.text || '';

    // ── Quick-reply-only steps (2, 3, 6) ──
    if (isQuickReplyStep(step)) {
      if (!hasQuickReply(messageEvent)) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, step);
        userState.set(senderId, stateData);
        return;
      }

      // Valid quick-reply — parse payload
      const payload = messageEvent.quick_reply.payload;
      let value = null;

      if (step === STEP.ADULTS) {
        const map = { adults_1: '1', adults_2: '2', adults_3: '3', adults_4: '4', adults_5plus: '5+' };
        value = map[payload] || null;
      } else if (step === STEP.KIDS) {
        const map = { kids_0: '0', kids_1: '1', kids_2: '2', kids_3: '3', kids_4: '4', kids_5plus: '5+' };
        value = map[payload] || null;
      } else if (step === STEP.INCOME) {
        const map = {
          income_1: 'Below $30,000/year',
          income_2: '$30,000–$80,000/year',
          income_3: '$80,000–$150,000/year',
          income_4: 'Above $150,000/year',
        };
        value = map[payload] || null;
      }

      if (value) {
        const fieldKey = ['name', 'adults', 'kids', 'phone', 'occupation', 'income'][step - 1];
        stateData.fieldsCollected[fieldKey] = value;
        stateData.invalidAttempts = 0;
        stateData.step = step + 1;

        // Transition to HANDOFF after step 6
        if (stateData.step > STEP.INCOME) {
          stateData.state = STATE.HANDOFF_TO_TAKASHI;
          const collectedName = stateData.fieldsCollected.name;
          await sendTypingOn(senderId);
          await sendTextMessage(senderId, `You're all set, ${collectedName || 'there'}! Takashi will review your application and get back to you within 24 hours with showing times. Talk soon! 🙏`);
          if (unit) {
            const threadUrl = `https://m.me/${config.PAGE_ID}?ref=${referralRef || ''}`;
            await sendHandoffEmail(stateData.fieldsCollected, unit, threadUrl);
          }
          userState.set(senderId, stateData);
          return;
        }

        // Advance to next question
        await sendQuestion(senderId, stateData.step, stateData.name);
        userState.set(senderId, stateData);
        return;
      }

      // Payload not recognized
      stateData.invalidAttempts++;
      if (stateData.invalidAttempts >= 3) {
        stateData.state = STATE.CLOSED;
        userState.set(senderId, stateData);
        return;
      }
      await sendInvalidAnswer(senderId, step);
      userState.set(senderId, stateData);
      return;
    }

    // ── Text input steps (1, 4, 5) ──
    if (step === STEP.NAME) {
      const name = text.trim();
      if (!name || name.length < 1) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, step);
        userState.set(senderId, stateData);
        return;
      }
      stateData.name = name;
      stateData.fieldsCollected.name = name;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.ADULTS;
      await sendQuestion(senderId, STEP.ADULTS, name);
      userState.set(senderId, stateData);
      return;
    }

    if (step === STEP.PHONE) {
      if (!isValidPhone(text)) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, step);
        userState.set(senderId, stateData);
        return;
      }
      // Normalize: strip non-digits, keep last 10
      const digits = text.replace(/\D/g, '');
      const last10 = digits.slice(-10);
      stateData.fieldsCollected.phone = last10;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.OCCUPATION;
      await sendQuestion(senderId, STEP.OCCUPATION, stateData.name);
      userState.set(senderId, stateData);
      return;
    }

    if (step === STEP.OCCUPATION) {
      const occ = text.trim();
      if (!occ || occ.length < 1) {
        stateData.invalidAttempts++;
        if (stateData.invalidAttempts >= 3) {
          stateData.state = STATE.CLOSED;
          userState.set(senderId, stateData);
          return;
        }
        await sendInvalidAnswer(senderId, step);
        userState.set(senderId, stateData);
        return;
      }
      stateData.fieldsCollected.occupation = occ;
      stateData.invalidAttempts = 0;
      stateData.step = STEP.INCOME;
      await sendQuestion(senderId, STEP.INCOME, stateData.name);
      userState.set(senderId, stateData);
      return;
    }
  }
```

- [ ] **Step 2: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/rentalBot')" 2>&1`
Expected: No output (OK)

---

## Task 4: Update sendHandoffEmail for new field names

**Files:**
- Modify: `src/phase1_messenger/rentalBot.js` — update the email body

- [ ] **Step 1: Update sendHandoffEmail body**

Replace the current `sendHandoffEmail` body with:

```javascript
async function sendHandoffEmail(fields, unit, threadUrl) {
  const incomeToRent = fields.income && unit.rent
    ? (parseFloat(fields.income.replace(/[^0-9.]/g, '')) / unit.rent).toFixed(1)
    : 'n/a';

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
```

- [ ] **Step 2: Run syntax check**

Run: `node -e "require('/root/.openclaw/workspace/Meta/src/phase1_messenger/rentalBot')" 2>&1`
Expected: No output (OK)

---

## Task 5: Verify exports and restart

- [ ] **Step 1: Verify exports**

Run: `node -e "const m = require('/root/.openclaw/workspace/Meta/src/phase1_messenger/rentalBot'); console.log(Object.keys(m))" 2>&1`
Expected: `[ 'handleRentalMessage', 'STATE' ]`

- [ ] **Step 2: Restart PM2 and check logs**

Run: `pm2 restart meta-bot && sleep 3 && pm2 logs meta-bot --lines 5 --nostream`
Expected: `[Server] Listening on port 3000` with no errors

---

## Task 6: Commit

```bash
git add src/phase1_messenger/rentalBot.js
git commit -m "feat: sequential question flow for rental bot

Replaced batch field extraction with one-question-at-a-time flow.
Steps: Name → Adults (quick-reply) → Kids (quick-reply) → Phone → Occupation → Income (quick-reply).
Quick-reply steps reject text input. Phone validated with North American regex.
3 invalid attempts at same step → CLOSED. Photo requests preserved mid-flow.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git push origin main
```

---

## Verification

1. **Happy path:** Message page → name prompt → reply "John" → adults quick-reply → tap "2" → kids quick-reply → tap "1" → phone prompt → reply "4165551234" → occupation prompt → reply "Engineer" → income quick-reply → tap "$30,000–$80,000/year" → confirmation message → check email received

2. **Invalid phone:** Reply with "ABC" at phone step → re-asked with hint → 3 failures → closed

3. **Text at quick-reply step:** At adults step, type "two" instead of tapping → re-asked with hint

4. **Photo mid-flow:** During any step, reply "photos" → photos sent, step unchanged