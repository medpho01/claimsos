# AI Suggestions on the Claim — surface, source review & proof

**Date:** 2026-06-05
**Area:** Email-intelligence → claim UI

## Problem

The Gmail inbound pipeline classifies each insurer reply and writes an extraction
draft to `hospital.email_intelligence_drafts` (status `pending_review`). The data
existed and the review components were built, but **nothing rendered them on the
hospital claim page** — they were only mounted in dev/demo pages. So users asked
"we added email summaries / next steps, but I don't see them in the UI."

Two follow-ups:
1. The suggestion must **link to the source email** (the "proof") so the reviewer
   can read the actual insurer message before applying.
2. Provide proof the wiring works.

## What changed

### 1. Review surface on the Overview tab
`webapp/src/pages/hospital/PatientDetail/AiSuggestionsCard.tsx` (new) — an
"AI Suggestions & Next Steps" card listing pending drafts with:
- outcome category + confidence,
- a human one-liner (`Approved amount ₹1,20,000`, or `N document(s) requested: …`),
- a **proof preview** of the source insurer email (from / subject / body snippet /
  attachment count),
- **"View source email →"** deep-link, and **"Review & Apply"** opening the
  existing `AiDraftDrawer`.

Mounted in `PatientDetail/index.tsx` Overview, above Claim Financials. Auto-hides
when nothing is pending.

### 2. Source-email enrichment (the "proof")
`Backend/src/Controllers/aiDrafts.controller.ts` — `listDraftsForClaim` now
`LEFT JOIN hospital.emails_inbound` and returns a `source_email` object
(`id, from, subject, received_at, body[:4000], attachments, classification`).

`webapp/src/hooks/intelligence/useAiDrafts.ts` — exposes `source_email` and mirrors
it into `extracted_payload.source` so the existing `AiDraftDrawer` proof pane renders
with no extra wiring. **Bug fixed:** the API returns `category` / `classifier_confidence`
but the FE components read `kind` / `confidence` — the hook now normalizes both, so the
drawer no longer shows category "unknown".

### 3. Deep-link to the source email in the Filings timeline
`webapp/src/pages/hospital/PatientDetail/InsuranceTimelinePanel.tsx`:
- `TimelineRef.focusEmail(inboundEmailId)` — scrolls the card into view (retries ~3s
  while the tab/data loads) and highlights it.
- Each card gets a DOM anchor `id="in-<emailId>"` (`out-<id>` for outbound) and a
  temporary indigo highlight ring.

`PatientDetail/index.tsx` — `onViewSource` switches to the Filings tab and calls
`timelineRef.focusEmail()` once the timeline mounts.

## Proof (local DB, claim `0a9c29ba-…`, draft `dbc414df-…`)

Enriched query the API now runs — returns the draft **and** its source email, and
confirms that email is in this claim's timeline (so the deep-link lands):

```
 draft_id  | category | conf | amount_inr | source_email_id |        dom_anchor_in_timeline        | appears_in_this_claims_timeline | from_address           | subject
 dbc414df… | approved | 0.90 | 120000     | a74e164d…       | in-a74e164d-e36b-4e53-b6c7-a6d5c43b59f2 | t                               | abhishek@finclarity.ai | Re: Pre-auth required … UHID 0a9c29ba…
```

- `appears_in_this_claims_timeline = t` → the source email is `matched_ipd_id = claim`,
  so the Filings timeline renders a card with `id="in-a74e164d…"` — exactly the anchor
  `focusEmail()` scrolls to.
- The timeline filters inbound by `matched_ipd_id = claim` (`emailInbox.service.ts:26`).

**Test-data note:** the pending draft originally pointed at a synthetic, unmatched
email (`eff5fb29…`, `matched_ipd_id = NULL`) that never appeared in the timeline. It was
repointed to the real matched approval email so the local end-to-end demo lands on an
actual card. In production this is a non-issue: the draft is created only after the
inbound email is matched, so `matched_ipd_id` is always set.

## How to see it in the UI

Open the patient/claim → **Overview** → indigo **"AI Suggestions & Next Steps"** card
shows **Approved ₹1,20,000 (90% confident)** with the source-email preview.
- **View source email →** jumps to **Filings & Communications** and highlights the
  insurer email it was extracted from.
- **Review & Apply** opens the drawer (full email + editable extraction) to confirm,
  which commits the approved amount into `claim_financials`.

## Files

- `webapp/src/pages/hospital/PatientDetail/AiSuggestionsCard.tsx` (new)
- `webapp/src/pages/hospital/PatientDetail/index.tsx` (mount + deep-link wiring)
- `webapp/src/pages/hospital/PatientDetail/InsuranceTimelinePanel.tsx` (focusEmail + anchors + highlight)
- `webapp/src/hooks/intelligence/useAiDrafts.ts` (source_email + kind/confidence normalization)
- `Backend/src/Controllers/aiDrafts.controller.ts` (source_email JOIN)
