# Messenger Bot — Message Handling Spec

Build the message handling logic for a rental inquiry bot. Messenger send/receive, Telegram send, and property data loading already exist — only the handling layer is in scope.

**Inputs available to the handler:**
- Inbound message text + sender PSID
- `unit_id` of the unit the user inquired about (resolved upstream from Messenger ad referral)
- Property data row from `property_post.xlsx` (schema below)

**Outputs the handler produces:**
- A reply string to send back via Messenger
- Optionally, a Telegram message payload for Takashi when a lead qualifies

---

## State machine

```
NEW_INQUIRY ──► AWAITING_INFO ──┬──► HANDOFF_TO_TAKASHI (terminal)
                                └──► CLOSED
```

`HANDOFF_TO_TAKASHI` is terminal — classifier never runs again for this thread. All user replies are relayed to Takashi via Telegram.

Persist per-PSID: `state`, `bot_msg_count`, `fields_collected` (dict).

---

## State 1: `NEW_INQUIRY`

First inbound message on a thread.

**Reply:**
```
Hi! Thanks for your interest in {headline}. I'm Takashi — I manage this rental personally.

To make sure it's a good fit on both sides, could you reply with:

1. Your name
2. Occupation & approximate monthly income (before tax)
3. Move-in date you're targeting
4. Who's moving in (number of adults, kids, pets)
5. One sentence on why you're moving

Once I have these, I'll confirm availability and suggest showing times. Reply "photos" anytime if you'd like to see more pictures. This is an auto-reply — Takashi reviews qualified inquiries personally within 24 hours. 🙏
```

`{headline}` = row's `headline` column with `{num_bedroom}` substituted.

Set state → `AWAITING_INFO`.

---

## State 2: `AWAITING_INFO`

Classify reply, first match wins:

| Bucket | Signal | Response | Next state |
|---|---|---|---|
| F. Photos request | Keywords: `photo`, `photos`, `pic`, `pics`, `picture`, `pictures`, `image`, `images`, `more photo`, `see more` | 2F | unchanged |
| A. Complete | All 5 fields detected | 2A | `HANDOFF_TO_TAKASHI` |
| B. Partial | 2–4 fields detected | 2B | `AWAITING_INFO` |
| C. Question | Contains `?` or question keywords | 2C | `AWAITING_INFO` |
| D. Minimal | ≤1 field, no question | 2D (one retry only) | `AWAITING_INFO` → `CLOSED` on 2nd |
| E. Spam | Profanity / gibberish | No reply | `CLOSED` |

Photos bucket also fires from `NEW_INQUIRY` and `HANDOFF_TO_TAKASHI` states (user may ask for pics at any point). State is preserved.

### Field extraction (rule-based)

| Field | Detection |
|---|---|
| `name` | `(?i)(i'?m\|my name is\|this is)\s+([A-Z][a-z]+)` or capitalized word early in reply |
| `occupation` | Keyword list (engineer, teacher, nurse, student, manager, analyst, doctor, self-employed, etc.) or `(?i)(i work as\|i work at\|i'?m a)\s+(\w+)`. Keep keywords in a config file for easy extension. |
| `income` | `\$?\s*(\d[\d,]*\.?\d*)\s*(k\|K)?\s*(/\s*(month\|mo\|year\|yr))?` — normalize to monthly before-tax. If value ≥ $30,000, assume annual and divide by 12. |
| `move_in_date` | Use `dateparser` lib — handles month names, ISO dates, "asap", "next month", "june 1st". **Sanity check:** if the parsed date is before today, treat it as next year. `dateparser` defaults to past when a month is ambiguous (e.g. "January" said in May → past January), so this correction ensures future intent. |
| `household` | Numbers + keywords (`people`, `kids`, `child`, `dog`, `cat`, `pet`, `couple`, `single`, `family`, `roommate`). Extract whole substring containing keyword. |
| `reason` | Any remaining sentence or keywords (`relocating`, `new job`, `downsizing`, `lease ending`, `school`) |

### Response 2A — Complete
```
Thanks, {name}! I have everything I need. Takashi will review and reply within 24 hours with showing times that work. Talk soon!
```

### Response 2B — Partial
```
Thanks {name}! Just need a couple more details:

{missing_fields_bullets}

Once I have these, Takashi will reach out with showing times.
```

Bullet labels (de-dupe occupation+income into one bullet when both missing; show individually when only one is missing):
```python
LABELS = {
    "name":         "• Your name",
    "occupation":   "• Occupation & monthly income (before tax)",
    "income":       "• Monthly income (before tax)",
    "move_in_date": "• Move-in date you're targeting",
    "household":    "• Who's moving in (adults, kids, pets)",
    "reason":       "• Why you're moving",
}
```

### Response 2C — Question first

Match keyword → canned answer from xlsx row data:

| Keyword(s) | Answer |
|---|---|
| `available`, `still available` | If `status == "available"`: "Yes, it's still available." Else: "This unit just got rented — I'll let Takashi know in case you'd like to hear about similar units." |
| `pet`, `dog`, `cat`, `animal` | Pull from `current description`. If silent on pets: "Pets are case-by-case — Takashi will discuss at viewing." |
| `parking`, `park` | From `has_parking` (1 → "Yes, parking is included." / 0 → "No on-site parking.") |
| `laundry`, `washer`, `dryer` | From `laundary_type` (`in_unit` → "In-unit washer and dryer." / `in_building` → "Shared laundry in the building.") |
| `utility`, `utilities`, `hydro`, `internet`, `heat` | From `utility_included` + `current description` features paragraph. Don't fabricate split details. |
| `sqft`, `size`, `how big` | From `sqft` |
| `rent`, `cost`, `price`, `how much` | "Rent is ${rent}/month." |
| `view`, `viewing`, `see it`, `tour`, `showing` | "Takashi schedules viewings after a quick intro. Could you reply with the 5 details above and he'll send time options?" |
| `deposit`, `lease`, `credit`, `term`, `rules`, `policy` | "Takashi will walk through lease terms and deposits at the viewing — these vary by unit." ⚠️ **Never quote specific terms.** |
| no match | "Good question — Takashi will answer that directly. Could you first reply with the 5 details above so he has context?" |

Then append:
```
To move forward, could you reply with:
1. Your name
2. Occupation & monthly income (before tax)
3. Move-in date
4. Who's moving in (adults, kids, pets)
5. Why you're moving
```

### Response 2D — Minimal
```
Hi! To check if this unit's a fit, I'll need a bit more info — could you share:

1. Your name
2. Occupation & monthly income (before tax)
3. Move-in date
4. Who's moving in (adults, kids, pets)
5. Why you're moving

If now's not a good time to type all this out, just reply when you can — no rush.
```

### Response 2E — Spam
No reply. Mark closed.

### Response 2F — Photos request

**Action:**
1. Read `image_folder` from the unit's xlsx row
2. Zip all files in that folder → `{unit_id}_photos.zip` in a temp directory
3. Send via Messenger Send API as a `file` attachment
4. Send accompanying text:

```
Here are all the photos for this unit, {name_if_known_else_blank}. Let me know if you have other questions, or reply with the 5 details above and Takashi will be in touch about a viewing.
```

**Notes:**
- If `image_folder` is empty / missing / contains no files: reply `"Sorry, no extra photos are available for this one beyond what's posted on Marketplace. Happy to answer any specific questions about the unit."`
- ZIP size cap: Messenger's file attachment limit is 25 MB. If the ZIP exceeds this, send a message: `"There are a lot of photos for this unit — Takashi will email them over after you send the 5 details above."` Then flag for Takashi in the eventual handoff payload.
- Cache the ZIP per unit (e.g. `/tmp/photos_cache/{unit_id}_photos.zip`) and only rebuild if folder mtime is newer than ZIP mtime. Avoids re-zipping for every renter.
- State does not change. If user was in `AWAITING_INFO`, they stay there. If in `NEW_INQUIRY`, they stay there.

---

## State 3: `HANDOFF_TO_TAKASHI` (terminal)

Stop replying on this thread. Emit Telegram payload (Markdown):

```
🏠 *NEW QUALIFIED LEAD*

*Unit:* {unit_id} — {headline}
*Location:* {city}, {province}
*Rent:* ${rent}/month

*Applicant:*
• Name: {name}
• Occupation: {occupation}
• Monthly income: ${income}
• Income-to-rent: {income/rent:.1f}x
• Move-in date: {move_in_date}
• Household: {household}
• Reason: {reason}

[Open Messenger thread]({thread_url})
```

Inline buttons: `✅ Approve` / `❌ Reject` / `❓ Ask follow-up`.

Button behavior:
- **Approve** → bot sends user: `"Thanks, {name}! Takashi would like to schedule a viewing. He'll reach out shortly with available times."` State stays `HANDOFF_TO_TAKASHI`.
- **Reject** → bot sends user: `"Thanks for your interest, {name}. Unfortunately Takashi won't be moving forward at this time. Best of luck with your search!"` State stays `HANDOFF_TO_TAKASHI`. User is blocked from further bot interaction until the thread is reset externally.
- **Ask follow-up** → Takashi types free text in Telegram → bot relays to Messenger. State stays `HANDOFF_TO_TAKASHI`. All future user replies on this thread are relayed to Takashi via Telegram — the classifier never runs again for this thread. No re-handoff push is sent.

**MarkdownV2 escape** all user-supplied fields (name, occupation, reason). Special chars: `_ * [ ] ( ) ~ \` > # + - = | { } . !`

---

## State 4: `CLOSED`

No replies. If new inbound > 48h after last message, reset to `NEW_INQUIRY`.

---

## Hard rules

1. **Cap: 3 bot replies per thread.** 4th attempt suppressed. Photo sends (Response 2F) do NOT count toward the cap — user explicitly requested them.
2. **Never schedule viewings** — even "can I come Saturday?" → "Takashi handles scheduling."
3. **Never quote tenancy terms, deposits, lease length.** Portfolio spans multiple provinces (BC, NB, possibly more) with different tenancy laws.
4. **Never expose the `address` field** in any reply. Only `city`/`province`.
5. **Echo the name back** in every reply once detected.
6. **Openly automated** — keep the "This is an auto-reply" line in Response 1. Don't pretend to be human.
7. **Idempotency** — de-dupe on Messenger `message.mid`; webhooks get redelivered.

---

## Property data — `property_post.xlsx`

Relevant columns for the handler: `unit_id`, `headline`, `current description`, `rent`, `city`, `province`, `status`, `has_parking`, `laundary_type`, `utility_included`, `sqft`, `num_bedroom`, `image_folder`.

Read with pandas.

---

## Definition of done

- Classifier correctly buckets a fixture of ~30 sample renter replies (≥27 pass)
- All 4 states transition correctly
- Approve / Reject / Follow-up Telegram buttons trigger the right Messenger reply
- 3-message cap enforced
- MarkdownV2 escaping handles names like `J.Smith_2024` without breaking
- "photos" keyword triggers ZIP send; works from `NEW_INQUIRY`, `AWAITING_INFO`, and `HANDOFF` states; doesn't increment message cap
- Empty `image_folder` or oversized ZIP (>25 MB) handled gracefully
- Webhook replay (same `mid`) doesn't double-send
