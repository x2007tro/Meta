# Sequential Question Flow — Rental Bot Redesign

## Problem

The current rental bot receives all 5 fields in a single batch reply and tries to parse them with regex/keyword matching. This fails when users answer in non-standard formats (e.g., "4. Myself" for household, "30000/year" for income, numbered lists). Users are asked to repeat information they've already provided.

## Goal

Ask one question at a time with validation. Each step either accepts the answer (advances) or re-asks with a hint. Quick-reply buttons for numeric fields (adults, kids, income) to avoid parsing ambiguity.

---

## Flow

```
NEW_INQUIRY → send intro + Q1 (name)
AWAITING_INFO → Q1 name → Q2 adults → Q3 kids → Q4 phone → Q5 occupation → Q6 income
AWAITING_INFO (step 6 valid) → HANDOFF_TO_TAKASHI → send confirmation + email
CLOSED on 3 invalid attempts at same step
```

---

## Questions

| Step | Field | Input Type | Validation |
|------|-------|------------|------------|
| 1 | Name | Text | Any non-empty text |
| 2 | Number of adults | Quick-reply (1, 2, 3, 4, 5+) | Quick-reply only |
| 3 | Number of kids | Quick-reply (0, 1, 2, 3, 4, 5+) | Quick-reply only |
| 4 | Phone number | Text | North American: 10 consecutive digits, optional dashes/parens/spaces |
| 5 | Occupation | Text | Any non-empty text |
| 6 | Income | Quick-reply | Selection from 4 brackets |

**Income quick-reply options:**
- "Below $30,000/year"
- "$30,000–$80,000/year"
- "$80,000–$150,000/year"
- "Above $150,000/year"

---

## Validation Rules

### Phone number (regex)
```
/^\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/
```
Must contain exactly 10 consecutive digits when digits only are counted. Accepts:
- `4165551234`
- `(416) 555-1234`
- `416-555-1234`
- `+1 4165551234`

Rejects anything without 10 digits.

### Quick-reply only steps (2, 3, 6)
If `messageEvent.quick_reply` is null or missing, treat as invalid regardless of text content. Only tap selections are valid.

---

## State Machine

**States:** `NEW_INQUIRY`, `AWAITING_INFO`, `HANDOFF_TO_TAKASHI`, `CLOSED` (unchanged from current)

**AWAITING_INFO sub-state:** `step` (1-6)

**State data per PSID:**
```javascript
{
  state: 'AWAITING_INFO',
  step: 1,                    // which question we're on
  fieldsCollected: {
    name: null,
    adults: null,
    kids: null,
    phone: null,
    occupation: null,
    income: null,
  },
  name: null,                // sticky name for personalized replies
  invalidAttempts: 0,        // consecutive invalid at same step
}
```

**Transitions:**
- Valid answer at step N → `step = N+1`, save field, advance question
- Valid answer at step 6 → `state = HANDOFF_TO_TAKASHI`, send email
- Invalid answer → `invalidAttempts++`, re-ask same question
- `invalidAttempts >= 3` → `state = CLOSED`

---

## Response Messages

### NEW_INQUIRY (intro + Q1)
```
Hi! Thanks for your interest. I'm Takashi — I manage this rental personally.

To get started, what's your name?
```

### Q1: Name
```
Hi! Thanks for your interest. I'm Takashi — I manage this rental personally.

To get started, what's your name?
```

### Q2: Number of adults
```
Hi [name]! Nice to meet you. How many adults will be living in the unit?
```
Quick-replies: 1, 2, 3, 4, 5+

### Q3: Number of kids
```
Got it. And how many kids?
```
Quick-replies: 0, 1, 2, 3, 4, 5+

### Q4: Phone number
```
Perfect. What's your phone number? (so Takashi can reach you)
```
Text input, validated with North American phone regex.

### Q5: Occupation
```
Thanks! What's your occupation?
```
Text input.

### Q6: Income
```
Last question — what's your annual income range?
```
Quick-replies: "Below $30,000/year", "$30,000–$80,000/year", "$80,000–$150,000/year", "Above $150,000/year"

### Q6: Income + HANDOFF
On step 6 valid answer:
```
You're all set, [name]! Takashi will review your application and get back to you within 24 hours with showing times. Talk soon! 🙏
```
Email sent to Takashi with all collected fields.

### Invalid answer (any step)
```
Sorry, I didn't catch that. [specific hint based on step]

Please try again.
```
Hints:
- Step 1 (name): "Please enter your name (e.g., John)"
- Step 2/3 (adults/kids): "Please tap one of the options below"
- Step 4 (phone): "Please enter a valid 10-digit North American phone number"
- Step 5 (occupation): "Please enter your occupation (e.g., Engineer)"
- Step 6 (income): "Please tap one of the income options below"

---

## Handoff Email

Format unchanged from current:
```
🏠 NEW QUALIFIED LEAD

Unit: {unit_id} — {headline}
Location: {city}, {province}
Rent: ${rent}/month

Applicant:
• Name: {fields.name}
• Occupation: {fields.occupation}
• Adults: {fields.adults}
• Kids: {fields.kids}
• Phone: {fields.phone}
• Income bracket: {fields.income}
• Move-in date: pending (removed from flow)
• Household: {fields.adults} adults, {fields.kids} kids

[Open Messenger thread]({threadUrl})
```

Note: `move_in_date` and `reason` are removed from the flow. `household` is now split into `adults` and `kids` with clean numeric values.

---

## Files Changed

- `src/phase1_messenger/rentalBot.js` — replace classifyReply/batch extraction with step-based sequential flow
- `src/phase1_messenger/sendApi.js` — already has `sendQuickReplies` (no change needed)

---

## Test Scenarios

1. User answers each question correctly → goes through Q1-Q6 → receives confirmation → email sent
2. User types text at quick-reply step → re-asked with hint
3. User enters invalid phone → re-asked with phone hint
4. User fails 3 times at same step → closed
5. User asks a question mid-flow → answer from unit data if available, then re-ask current step
6. Photo request mid-flow → serve photos, state unchanged, stay at current step
7. Second message from same user with referral → start fresh (new conversation per PSID)