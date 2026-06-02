# ADR-001: Stage-7 Graceful Degradation — Harmonise Coherent Survivors Instead of Hard-Blocking on a Removable Anomaly

**Status:** Proposed
**Date:** 2026-05-29
**Deciders:** Pipeline v2 owner (sign-off required before any `identityGate`/`runState` code change)
**Lever:** A (of the systemic pipeline analysis) — a recall/throughput lever, not a field-accuracy lever.

---

## Context

Stage 7 (`Backend/src/Services/pipelineV2/runState.service.ts`) is a **hard AND-gate**. A claim may harmonise only when every upstream gate passes:

```ts
const canHarmonise = blockers.length === 0;          // runState.service.ts:140
```

One of the three gates is identity coherence:

```ts
if (!identity.coherent) {                            // runState.service.ts:113
  blockers.push({ gate: 'identity', status: 'QUARANTINE', reason: ... });
}
```

And `identity.coherent` (`identityGate.service.ts:588`) is **false** if *any* of these hold:

```ts
const coherent =
  quarantinedPageIds.length === 0 &&                 // (a) no page quarantined as foreign
  clusterCount(coherenceUhids) <= 1 &&               // (b) survivors collapse to one uhid cluster
  clusterCount(coherenceIpds) <= 1;                  // (c) ... and one ipd cluster
```

### The defect: a single removable page vetoes the whole claim

Clause **(a)** means **one** page quarantined as foreign (`quarantinedPageIds.length === 1`) forces `coherent = false` → an identity blocker → the entire claim is `QUARANTINE` and `canHarmonise = false`.

But Stage 4 (extraction) **already excludes quarantined pages from fusion** (`excludedPageIds = quarantined ∪ duplicates`). So the anomalous page is *already gone* from the fused episode. The pipeline does the correct thing at the page level — isolate and drop the intruder — and then **discards the perfectly good fused remainder at the claim level.** We pay for the precision twice: once to remove the page, once to block everything it touched.

### Evidence: this is structural, not per-patient

From the corrected, stage-attributed **error budget** (`harness/budget.ts`) over `bench12` (10 cached patients), the quarantine-behaviour roll-up:

| Quarantine flag | Count | Claims |
|---|---|---|
| **`QUARANTINE_OVER_BLOCK`** (one removable anomaly, coherent remainder) | **5** | Qamruddin, Agar Noori, Sushila, Kalksum, Nida |
| **`QUARANTINE_UNDER`** (foreign page **leaked into** fusion — genuine mix) | **1** | Divyansh |

6 of 10 claims land in `QUARANTINE`. **5 of those 6 are over-blocks** — each has exactly one removable page and a surviving set that forms a single coherent identity. The current gate cannot distinguish them from Divyansh, the one genuine two-patient bundle: both are simply `coherent === false`.

Point-fixing any single patient here is the local-maxima trap. The 5 over-blocks share **one** structural cause; Lever A removes it once.

---

## Decision

Add **graceful degradation** to Stage 7. When identity incoherence is caused *solely* by a removable minority of quarantined pages **and** the surviving pages form a single coherent identity, **harmonise the survivors** and emit an explicit `COMPLETE_DEGRADED` state — harmonised, with N pages quarantined and surfaced for review — instead of a blocking `QUARANTINE`.

Keep hard `QUARANTINE` whenever the survivors are **not** a single coherent identity (≥2 reconciled identity clusters among non-quarantined pages) — the genuine-mix / under-quarantine-leak case.

### Surface the discriminator the gate already computes but hides

`IdentityGateResult` today exposes only the **raw, un-reconciled** `distinctUhids` (deliberately raw, per the E2 contract at `identityGate.service.ts:406`). That list is too noisy to drive a claim-level decision — OCR variants, `NOTFULLYVISIBLE` placeholders, and misread phone numbers all inflate it (Kalksum's raw set has 5 entries that reconcile to 1 patient). The gate *internally* already collapses this noise via `clusterCount` / `idsReconcilable` / `isPhoneLikeId`, but only emits the boolean `coherent`.

**Expose a reconciled `survivorIdentityCount`** on `IdentityGateResult`, computed with those same existing primitives applied to the **surviving** page set. This is a byproduct the gate already has; it just isn't returned.

### The rule

```ts
// Computed over pages NOT in quarantinedPageIds:
const survivorsCoherent =
  clusterCount(survivorCoherenceUhids) <= 1 &&
  clusterCount(survivorCoherenceIpds) <= 1;
const survivorMajority =
  quarantinedPageIds.length >= 1 &&
  quarantinedPageIds.length < survivorPages.length &&   // anomaly is a strict minority
  survivorsCarryDominantAnchor;                          // the dominant patient is present

let identityVerdict: 'ok' | 'degrade' | 'hard';
if (identity.coherent)                       identityVerdict = 'ok';
else if (survivorsCoherent && survivorMajority) identityVerdict = 'degrade';
else                                         identityVerdict = 'hard';
```

- `ok` → unchanged (`COMPLETE_CLEAN` path).
- `degrade` → harmonise survivors, status `COMPLETE_DEGRADED`, `canHarmonise = true`, quarantined pages still reported in `counts.quarantined` and `blockers`-as-advisory.
- `hard` → unchanged blocking `QUARANTINE`.

### Why this keeps Divyansh blocked (the safety property)

Divyansh is `QUARANTINE_UNDER`: a foreign page **leaked into the fused set** (the gate caught one foreign page but a second genuine patient's page survived). Because the leak is *among the survivors*, `clusterCount(survivorCoherenceUhids) === 2` → `survivorsCoherent === false` → `hard`. **The very fact that makes Divyansh dangerous is what trips the survivor check.**

**Honest caveat:** this safety relies on the leaked page contributing a *distinct* survivor cluster. If a foreign page ever slips in via *wrongful corroboration* (name/hospital match folds it into the anchor at `identityGate.service.ts:502`), it would not add a cluster and the rule could wrongly `degrade`. The rule must therefore be backed by the interlock below — it is not safe on its own.

### Safety interlock (ties Lever A to the harness)

1. Pin `expectedCanHarmonise = false` in `ground_truth.json` for every known mixed bundle (starting with Divyansh). The scorer already reads this (`scorer.ts` → `harmoniseExpected` / `harmoniseHit`).
2. Extend the regression gate so that **flipping a GT-pinned `canHarmonise=false` claim to `true` is a HARD regression.** Today `regression.ts:173` treats `canHarmonise` `false → true` *only* as an improvement — that asymmetry is exactly the hole a wrong degradation would slip through. Closing it makes "Divyansh must never harmonise" a committed, enforced invariant rather than a hope.

---

## Options Considered

### Option A — `COMPLETE_DEGRADED` status (Recommended)

Add an explicit `RunStatus` for "harmonised on a reduced page set." Survivors fuse; quarantined pages are surfaced as advisory.

| Dimension | Assessment |
|---|---|
| Complexity | Medium — touches the `RunStatus` union + every consumer that switches on it |
| Recall lift | High — up to 5/10 corpus claims unblocked |
| Precision risk | Low (by design — Divyansh stays blocked) |
| Auditability | **High** — explicit state, matches Stage-7's "explicit non-clean state" philosophy |
| Blast radius | Medium |

**Pros:** Self-documenting in the review UI ("completed, 1 page quarantined"); honours the Stage-7 docstring intent (an explicit state "instead of yielding a vacuum a stale doc fills"); reviewers can see *why* a claim degraded.
**Cons:** New enum member ripples to every `switch (status)`; needs a UI affordance.

### Option B — Keep the enum, add a `degraded` flag + flip `canHarmonise`

Leave `RunStatus` alone; set `canHarmonise = true` while `counts.quarantined > 0` and add a `degraded: boolean` to `RunState`.

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Recall lift | High (same as A) |
| Precision risk | Low (same interlock) |
| Auditability | Medium — the caveat lives in a flag, not the headline |
| Blast radius | **Low** |

**Pros:** Smallest change; no consumer needs updating to avoid breaking.
**Cons:** A claim with `status` still implying clean-vs-blocked but `degraded=true` is muddier than a first-class state; the "we dropped a page" fact is easy to miss.

### Option C — Relax the gate: drop the quarantine→incoherent link

Remove clause **(a)** so a quarantine no longer forces incoherence.

**Rejected.** This *also* unblocks Divyansh — it cannot tell over-block from leak. It trades a precision-preserving fix for a precision-losing one.

### Option D — Point-fix each over-blocked patient

Tune thresholds per patient until each over-block clears.

**Rejected.** This is the local-maxima trap the systemic analysis exists to avoid: 5 claims, 1 structural cause, fixed once by A/B — not 5 brittle per-patient tweaks.

---

## Trade-off Analysis

**Recall vs precision.** A/B convert up to **5/10** corpus claims from `QUARANTINE` → `COMPLETE_DEGRADED` at *designed-zero* precision cost, because the survivor-coherence discriminator keeps the one genuine mix (Divyansh) blocked.

**What this does NOT do (scope honesty).** Lever A unblocks *harmonisation*; it does **not** fix the field misses *inside* those claims — Sushila's verbose-diagnosis `SELECTION` miss, Kalksum's AWMI-vs-TVD `SELECTION` miss, etc. are separate budget buckets addressed by other levers. And 2 of the 5 over-blocks (Qamruddin, Agar Noori) pin **no** ground-truth episode fields, so their gain is throughput/status only — real, but **unmeasurable as field accuracy on this corpus.** Sushila, Kalksum, and Nida pin fields and yield measurable harmonised output. Do not over-claim "+5 claims of accuracy."

**Explicit vs implicit state.** Option A's explicit `COMPLETE_DEGRADED` aligns with the Stage-7 design philosophy that non-clean outcomes should be *explicit and enumerated*. B is cheaper but pushes the caveat into a flag. Recommend **A**, with **B** as the low-blast-radius fallback if the enum ripple is judged too costly this cycle.

---

## Consequences

- **Easier:** 5/6 quarantined claims become processable; the adjuster gets a populated episode plus a "1 page quarantined" flag instead of a fully blocked claim.
- **Harder:** a new run state to render and to handle in every `RunStatus` consumer (Option A); the review UI needs a "degraded" affordance.
- **To revisit:** Divyansh's `QUARANTINE_UNDER` is a *separate upstream Stage-2 recall bug* (a foreign page that should have been quarantined wasn't). Graceful degradation must **not** be used to paper over it — Divyansh stays blocked, and fixing Stage-2 recall is its own lever. If Stage-2 recall is later fixed, Divyansh's survivors become coherent and it would *then* legitimately degrade.

---

## Action Items

1. [ ] Add reconciled `survivorIdentityCount` to `IdentityGateResult`, computed via existing `clusterCount`/`idsReconcilable`/`isPhoneLikeId` over the surviving (non-quarantined) page set.
2. [ ] Implement the `ok | degrade | hard` decision in `evaluateRunState`; add `COMPLETE_DEGRADED` to `RunStatus` (Option A) or a `degraded` flag (Option B).
3. [ ] Pin `expectedCanHarmonise = false` for Divyansh (and any other known mixed bundle) in `ground_truth.json`.
4. [ ] Extend `regression.ts`: a GT-pinned `canHarmonise=false` flipped to `true` is a **HARD regression** (close the `regression.ts:173` asymmetry).
5. [ ] **Shadow mode first** (mirroring the WAVE_12 discipline): compute the degrade/hard verdict off-path and diff it against current behaviour on the corpus before changing any harmonisation output.
6. [ ] **Promotion gate** — flip the behaviour on only when ALL hold:
   - `regression.ts` stays green (no field `HIT → MISS`, no `canHarmonise true → false`);
   - Divyansh stays `QUARANTINE` (`canHarmonise=false`);
   - the 5 over-blocks flip to `COMPLETE_DEGRADED`.
7. [ ] Re-bless `regression.baseline.json` **after** the intended status drift (`QUARANTINE → COMPLETE_DEGRADED` is *expected* drift, not a regression).

---

## References

- `Backend/src/Services/pipelineV2/runState.service.ts:113,140` — the identity blocker + hard AND-gate.
- `Backend/src/Services/pipelineV2/identityGate.service.ts:57` (`IdentityGateResult`), `:185` (`idsReconcilable`), `:203` (`clusterCount`), `:502` (corroboration), `:588` (`coherent`).
- `Backend/src/Services/pipelineV2/harness/errorBudget.ts` — `QUARANTINE_OVER_BLOCK` / `QUARANTINE_UNDER` flags (the 5-vs-1 split).
- `Backend/src/Services/pipelineV2/harness/regression.ts:173` — the `canHarmonise` asymmetry this ADR closes.
- `docs/proposals/WAVE_12_BUNDLE_CLASSIFIER.md` — the shadow-mode → eval → promotion-gate discipline mirrored in Action Items 5–6.
