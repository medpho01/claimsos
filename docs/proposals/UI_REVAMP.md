# ClaimsOS Webapp — UI/UX Revamp Proposal

**Author:** Engineering
**Date:** 2026-05-13
**Status:** Proposal — pending approval before implementation
**Companion:** [`ui-revamp/wireframes.html`](./ui-revamp/wireframes.html) — interactive mockups (open in a browser)

This proposal diagnoses why the current ClaimsOS webapp feels bulky and visually noisy, lays out the design principles and tokens we'll adopt, and presents wireframes for the screens that will host the upcoming features (IPD statuses, analytics, panel management at scale, doctor workflow). Implementation is **not** in scope here — once the direction is approved we'll execute in phases.

---

## 1. Diagnosis — Why the current UI feels heavy

Most of these came out of the May 2026 audit and our last few working sessions. They're symptoms of a common root cause: **everything is wrapped in a Card and given equal visual weight.**

### 1.1 Card-on-card stacking
Every entity is wrapped in a shadcn `<Card>`. Attribute lists, panels, doctors, document rows — all 30+ attributes on the Attributes tab are 30 separate cards stacked vertically. The cards have padding, borders, headers, and footers — so even a one-line value occupies 120px of vertical space. On a 14" laptop you see 3–4 attributes per screen.

### 1.2 Inconsistent component vocabulary
- Two dialog primitives coexist (`dialog.tsx` and `flexible-dialog.tsx`)
- Two skeletons (`ui/skeleton` and `common/Skeleton`)
- `window.alert()` mixed with sonner toasts in 7 places
- Login page uses raw CSS; everything else uses Tailwind
- Three credential-editing UIs across `CredentialsTab.tsx` (legacy), `CredentialsTab/` (new), and `DoctorProfilePage/CredentialsManager.tsx`
- `react-multi-select-component` next to shadcn `Select`

The result: every page looks subtly different. Same primitive, different padding/border-radius/colour.

### 1.3 Verbose forms in narrow modals
Add User / Add Hospital / Add Attribute modals are stacked single-column with no grouping or progressive disclosure. Long forms with no scroll inside the modal mean the submit button drifts off-screen (we fixed AddUserModal last session — the pattern needs to apply globally).

### 1.4 No primary action per screen
Each page has 3-5 buttons of similar weight: "Refresh", "Add", "Configure", "Hospital Profile Configuration", "Public Sharing". Users have to read them all to know what matters. There's no concept of "the one thing you usually do here."

### 1.5 Status, expiry, completeness are buried
- Hospital list shows panel count + patient count — no health indicator
- Attribute cards show a generic verification badge but no clear "this expires in 3 weeks" colour priority
- No "needs attention" feed anywhere

### 1.6 Information architecture has duplicates and gaps
- `/hospital/:id` (legacy) and `/portal/:id` (new) coexist with overlapping data
- Hospital Profile Configuration is hidden behind a button on the legacy page
- No global "today" / dashboard view for admins
- `HospitalDocsAndDetails.tsx` (840 LOC) is rendered only on legacy page; the portal can't see it
- `VerificationDashboard.tsx` is buried inside the Profile tab

### 1.7 Typography and colour drift
- Headings range from `text-lg` to `text-3xl` without a clear scale
- Multiple blue gradients (`from-blue-600 to-blue-700`, `from-indigo-600 to-blue-700`, plain `bg-blue-600`) on different surfaces
- Slate vs gray vs neutral mixed within the same screen
- Body text inconsistently uses `text-slate-600`, `text-muted-foreground`, `text-gray-500`

### 1.8 No status workflow for IPDs / claims
The `claims.latest_status` column exists but is empty — there's no status state machine wired through the UI yet. Today the only signals on a patient row are admit date and discharge date. Ops can't tell at a glance "this one's stuck in pre-auth."

### 1.9 No analytics or export surfaces
`xlsx`, `exceljs`, `jspdf` are in the bundle, but no consistent export-this-table button exists. Users copy data by hand or screenshot.

### 1.10 Density vs. whitespace tension
Spacing is randomized — `gap-2`, `gap-3`, `gap-4`, `space-y-4`, `space-y-6` chosen ad-hoc. Padding uses `p-3`, `p-4`, `p-5`, `p-6`. Net effect: nothing aligns to a grid, the page feels squishy.

---

## 2. Design Principles

Six rules to govern every screen we design from this point forward.

### P1 — One surface per page, not nested cards
A page is a section, not a stack of cards. Use cards only when a sub-unit must visually detach (a modal, a popup, a true sidecar widget). Lists and tables sit directly on the page background.

### P2 — One primary action per screen
The CTA you'd push 80% of the time is the only filled button. Everything else is a ghost or outline. The page header reserves a right-side slot for that primary action.

### P3 — Status is data, not decoration
Every IPD, every panel, every attribute, every doctor has a status that's a first-class column / pill. Coloured tokens are reserved for status — they're not used decoratively.

### P4 — Scrolling is vertical, full-bleed
The page scrolls — modals don't. Sub-areas of the page (search panes, role lists, attribute lists) are bounded with `max-height` so they scroll inside their card without trapping the page.

### P5 — Density before chrome
Show more data per row. Tabular numbers, single-line cells, hover-to-reveal actions. Cards only when grouping has semantic weight (e.g., a dashboard widget).

### P6 — Empty states do work
Empty states should answer "what do I do?" with one verb. No decorative emoji or 200px illustrations — a short sentence and a button.

### P7 — One side rail per page; sub-nav goes horizontal
A second left rail for category filtering is cargo-cult IA. It eats horizontal space, anchors the eye at the wrong location, and adds visual clutter. Replace it with:
- **Horizontal chip row** above the content when the user is *filtering down* to one category (Profile attributes, Attribute Configurator, Master Options).
- **Stacked content groups with sticky headers** when the user wants to *browse all categories at once* (Documents, Patient documents). Each group has a sticky `<thead>` so the category label stays visible while scrolling within it.

The only place a second rail is justified is when navigating a true hierarchical tree (e.g., a folder tree with arbitrary nesting). The eight category-buckets we have today are not that.

### P8 — Split responsibilities at the page level, not at the tab level
A page that mixes two different jobs done by two different users at two different cadences will always feel cluttered. Use an explicit **mode toggle** (segmented control) at the page header to swap the entire tab strip beneath it. The user picks the mode they're in, and only sees the tabs relevant to that mode.

Today's Hospital Workspace mixes daily Operations (Patients, Overview) with one-time Configuration (Panels, Doctors, Profile, Documents, Sharing) as peer tabs. After the revamp:

```
┌─ Hospital header ──────────────────────────────────────┐
│ Sadbhawana Nursing Home · Moradabad · [Edit] [⋯]       │
│ ●Profile 92%  ●1 expired  ●18 panels  ●21 admitted     │
├────────────────────────────────────────────────────────┤
│ [📊 Operations]  [⚙ Configuration]      mode toggle    │
│                                                          │
│ When Operations is on:    [Overview] [Patients] [Reports]
│ When Configuration is on: [Profile] [Panels] [Doctors] [Documents] [Public sharing]
└────────────────────────────────────────────────────────┘
```

The same pattern applies to any page where two audiences share a surface (e.g., a future Doctor self-service page split between "My credentials" and "My calendar/availability").

---

## 3. Visual Language (Design Tokens)

### 3.1 Colour
Reduce to **one** brand accent + neutrals + status semantic colours.

| Token | Hex | Use |
|---|---|---|
| `--brand-600` | `#1E40AF` (indigo-700) | Primary buttons, links, key brand mark |
| `--brand-700` | `#1E3A8A` | Hover for brand actions |
| `--surface-0` | `#FFFFFF` | Page background |
| `--surface-1` | `#F8FAFC` (slate-50) | Section backgrounds, table headers |
| `--surface-2` | `#F1F5F9` (slate-100) | Hover rows |
| `--border` | `#E2E8F0` (slate-200) | Dividers, inputs, table grid |
| `--text-1` | `#0F172A` (slate-900) | Primary text, headings |
| `--text-2` | `#475569` (slate-600) | Body text |
| `--text-3` | `#94A3B8` (slate-400) | Placeholder, meta |
| `--status-success` | `#16A34A` (green-600) | Verified, ready, settled |
| `--status-warning` | `#D97706` (amber-600) | Pending, expiring, partial |
| `--status-danger` | `#DC2626` (red-600) | Expired, rejected, errored |
| `--status-info` | `#0284C7` (sky-600) | In-progress, info |
| `--status-neutral` | `#64748B` (slate-500) | Draft, unknown |

**Drop:** indigo-600, multiple blue gradient combos, mixing gray-500 and slate-500.

### 3.2 Typography
Inter (currently Google-Fonts-loaded). One scale, one weight per role.

| Token | Size / Line | Weight | Use |
|---|---|---|---|
| `display` | 32 / 40 | 600 | Page title (hero — sparingly) |
| `h1` | 24 / 32 | 600 | Page heading |
| `h2` | 18 / 28 | 600 | Section heading |
| `h3` | 14 / 20 | 600 | Card / table column heading (uppercase optional) |
| `body` | 14 / 20 | 400 | Default body |
| `body-sm` | 13 / 18 | 400 | Tables, meta |
| `caption` | 12 / 16 | 500 | Labels, badges |
| `mono` | 13 / 18 | 400 | IDs, credentials, timestamps |

No italics, no underlines outside links.

### 3.3 Spacing — 4-pt grid
Use only: `0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64` px. Translates cleanly to Tailwind's default scale. Remove `p-3.5`, `gap-2.5` style off-grid values.

### 3.4 Radius
- `6px` (`rounded-md`) for inputs, buttons, table rows on hover
- `8px` (`rounded-lg`) for cards, table containers, modals
- `9999px` (`rounded-full`) for pills, avatars

### 3.5 Elevation
Two levels only:
- `shadow-sm` — cards at rest
- `shadow-lg` — modals / popovers

Drop all other shadow combos.

### 3.6 Component patterns
- **Buttons:** filled (one per screen), outline, ghost, destructive. Sizes: `sm` (h-8), `md` (h-9, default), `lg` (h-10).
- **Pills:** uppercase, 11px, weight 600, status colour with 10% bg.
- **Tables:** sticky header, hover row highlight, `tabular-nums` on number columns, right-align numerics.
- **Empty states:** centred, icon-light (24px), one short sentence, one CTA.

---

## 4. Information Architecture

### 4.1 New global shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ Logo  ClaimsOS    [⌘K search]                Notifications  Avatar   │  ← top bar (48px)
├────────┬─────────────────────────────────────────────────────────────┤
│        │                                                              │
│  📊    │   Page content                                               │
│  🏥    │                                                              │
│  👨‍⚕️    │                                                              │
│  📑    │                                                              │
│  ⚙     │                                                              │
│        │                                                              │
└────────┴─────────────────────────────────────────────────────────────┘
   side rail (56px collapsed, 224px expanded)
```

**Side rail items** depend on role:

- **Superadmin:** Dashboard, Hospitals, Doctors, Panels (master), Attributes (configurator), Master Options, Validators, Audit
- **Admin:** Dashboard, My Hospitals, Doctors, Reports
- **Hospital User:** Today, Patients (IPD), Doctors, Panels, Profile, Reports
- **Doctor:** My Profile, Hospitals, Credentials

The top bar is constant; the rail changes by role. No tab-strip nested inside a tab — instead, when a "thing" has sub-views (e.g., Hospital workspace), the sub-views go in a horizontal pill-tab strip immediately under the page H1.

### 4.2 Sitemap revamp

```
/                              → role redirect
/login

# Superadmin
/superadmin                    → dashboard (today)
/superadmin/hospitals          → list
/superadmin/hospitals/:id      → hospital workspace (replaces /hospital/:id + /portal/:id/* for SA view)
/superadmin/doctors
/superadmin/panels
/superadmin/attributes/{hospital|panel|doctor}
/superadmin/master-options
/superadmin/audit

# Admin (24Eleven ops)
/admin                         → my hospitals dashboard
/admin/hospitals/:id           → hospital workspace
/admin/patients                → cross-hospital patient queue with status filters
/admin/reports

# Hospital
/portal                        → today
/portal/patients               → IPD list with status pipeline
/portal/patients/:id           → patient detail (claim packet)
/portal/doctors
/portal/panels                 → Overview / Configure (already built)
/portal/profile
/portal/reports

# Doctor (planned)
/me                            → profile + credentials
/me/hospitals

# Public
/hospitals                     → public directory
/hospitals/share/:token        → share-token gated view
/doctors                       → public directory
/public-doctor/:token
```

**Deprecated:** `/hospital/:id` (legacy superadmin view), `/portal/:hospitalId/profile` (Profile sub-route inside portal — folded into hospital workspace tabs).

### 4.3 The Hospital Workspace — split by responsibility, not by feature

Today: `/hospital/:id` (legacy) AND `/portal/:id/profile` show overlapping subsets. Original draft of this proposal kept them as one page with six peer tabs — but that mixed two unrelated jobs (daily claim ops vs one-time setup). Final design: **one URL, two modes, mode-specific tab strips**:

```
/admin/hospitals/:id     (or /portal for hospital users)

┌── Hospital Workspace ─────────────────────────────────────────┐
│ Header card: Sadbhawana Nursing Home · Moradabad · Edit  ⋯    │
│ Pill bar:  ●Profile 92%  ●1 expired  ●18 panels  ●21 admitted │
├───────────────────────────────────────────────────────────────┤
│  [📊 Operations] [⚙ Configuration]            mode toggle     │
├───────────────────────────────────────────────────────────────┤
│  ⌜ When Operations is on:                                     │
│     [Overview] [Patients · 21] [Reports]                      │
│  ⌞ When Configuration is on:                                  │
│     [Profile] [Panels] [Doctors] [Documents] [Public sharing] │
└───────────────────────────────────────────────────────────────┘
```

**Operations mode** (daily, claim-ops user):
- **Overview** → KPIs, patient pipeline visual, needs-attention, recent activity
- **Patients** → IPD list with status pipeline (→ patient detail with documents)
- **Reports** → hospital-scoped reports (this hospital's IPD volume, time-in-status, etc.)

**Configuration mode** (occasional, admin/setup user):
- **Profile** → 43 attributes (banking, certifications, beds, equipment, …)
- **Panels** → fleet overview + configure (already shipped pattern)
- **Doctors** → doctor table + credential drilldown
- **Documents** → hospital-level docs grouped by folder
- **Public sharing** → share-link CRUD

The split also affects audit / permissioning naturally — `Operations` actions should be permissible to claim-ops admins (`can_edit`, `can_discharge` permissions); `Configuration` actions should be restricted to hospital admins + superadmin.

---

## 5. Key Screens — Redesign Briefs

(Each rendered in `ui-revamp/wireframes.html`.)

### 5.1 Today (Dashboard)
A new top-level home for each role.

For a hospital user:
- 4 KPI tiles: Admitted, Pending pre-auth, Submitted, Settled-this-week
- A "needs attention" feed: expiring credentials, claims sitting in pre-auth > 48h, missing documents on admitted patients
- Quick actions: New patient, Open panel portal X, Mark discharge

For a superadmin: hospital health overview + verification queue + system stats.

### 5.2 Patients (IPD) — new status pipeline
The most important new surface. Today there's no claim state machine in the UI. Proposal:

| Column | Notes |
|---|---|
| Patient | Name + ID, phone hover |
| Hospital | (cross-hospital views) |
| Panel | Pill — colour from panel brand |
| **Status** | Pill — pre-auth submitted / approved / discharge / submitted / queried / settled / paid |
| Admitted | Date · days |
| Last action | Time + actor |
| Claim amount | Approved vs requested |
| Actions | Hover row → ⋯ menu |

Filter bar above: status multi-select, panel, date range, "needs attention only" toggle. Bulk select for export.

### 5.3 Panels (already shipped, light revamp)
The Overview/Configure split is good. We'll align headings and spacing to the new system.

### 5.4 Doctors
Currently the doctors list inside a hospital is a card grid. Proposal: a table with columns Name, Department, Designation, NMC #, Credentials (X verified, Y expiring), Status. Expand row for full credential breakdown. Click into doctor for full profile editor.

### 5.5 Documents
Folder-style left pane (categories: registration / accreditation / fire / biomedical / clinical / banking) + right pane file list with preview, expiry, verification state. Reuse the table pattern.

### 5.6 Hospital Profile (attributes flat-list collapse)
30 attributes today are 30 cards. Proposal: 30 rows in a tight table grouped by category (collapsible sections). Inline edit on click. Add/remove from a single Add button at top.

### 5.7 Reports / Analytics
A reports landing page with the standard set:
- IPD volume by panel and month
- Time-in-status by stage
- Document completeness by hospital
- Verification SLA
- Doctor credential expiry pipeline

Every report has Export-CSV / Export-XLSX / Export-PDF buttons. The export utility is shared (reuse the `xlsx`/`jspdf` libs that are already in the bundle).

### 5.8 Component & token gallery
Showcase of the design tokens — colours, type scale, button variants, status pills, input states, table example, modal example, empty state example.

---

## 6. New Surfaces (to be designed under the new system)

### 6.1 IPD Status Pipeline (P0 for the new release)
A `claims.latest_status` enum with these stages (proposed):

```
draft → pre_auth_pending → pre_auth_approved → admitted → discharge_pending
     → submitted → queried → approved → settled → paid
                            ↘ rejected
```

Each transition timestamped in a new `claim_status_history` table for the time-in-stage report.

### 6.2 Panel Management at scale
- Bulk-link panels across hospitals
- Connectivity probe (HEAD request from backend to Portal URL with timeout) → Health column shows real status, not just completeness
- Per-panel credential rotation log
- RPA job tray (when wired)

### 6.3 Doctor workflow
- Doctor-side mobile-friendly profile (covered in Phase 5 of the original product doc, not started)
- Credential expiry nudges (in-app + WhatsApp)
- Bulk verify by validator visit

### 6.4 Analytics & Download
- Saved views per user
- Schedule recurring exports (daily/weekly)
- One-click "send to my email" for any table

---

## 7. Phased Rollout

### Phase A — Foundation (1 sprint)
- Land the design tokens (Tailwind theme extension + CSS variables in `index.css`)
- Build the new shell (top bar + side rail) and migrate Profile page to use it as a smoke test
- Consolidate Dialog / Skeleton duplicates
- Replace `window.alert` → sonner toasts (codemod)
- Move LoginPage to shadcn

### Phase B — Hospital Workspace (1 sprint)
- Build the unified `/admin/hospitals/:id` and `/portal` (same component, role-aware)
- Migrate Profile sub-tabs into workspace tabs
- Retire `/hospital/:id` and `/portal/:id/profile` (redirects)

### Phase C — IPD status pipeline (2 sprints)
- Backend migration: `claims.latest_status` enum + `claim_status_history`
- New `/portal/patients` page with status filter pipeline
- Patient detail page (one stop for documents, status history, claim packet)

### Phase D — Doctors revamp (1 sprint)
- Doctor list → table, expand row for credentials
- Folds in the work already done on `CredentialsTab/` refactor

### Phase E — Documents + Reports (2 sprints)
- Documents tab (foldered)
- Reports landing + 5 starter reports with export

### Phase F — Panel Mgmt at scale (1 sprint)
- Connectivity probe
- Bulk link
- RPA job tray

Total: ~8 sprints. Phases A–C unlock the most user-visible improvement. The wireframes in the companion HTML reflect the **post-Phase-E** state.

---

## 8. Out of scope here

- Mobile app redesign (separate proposal)
- Public profile redesign (separate proposal — they should match the new system but the public surface is its own product)
- i18n / l10n
- A11y deep dive (will follow Phase A — design tokens make this easier)

---

## Walkthrough: Super Admin journey (mirrored in the wireframes)

The mockups in `ui-revamp/wireframes.html` start from sign-in and step deeper, matching the order a Super Admin actually moves through the app:

1. **Login** — clean shadcn-based card, replaces the raw-CSS LoginPage.
2. **SA Dashboard** — KPIs + hospital health rollup + needs-attention queue. The default route on login.
3. **Hospitals list** — every hospital with profile %, panels, admitted count, health pill, public-profile state. Row click → workspace.
4. **Hospital Workspace · Overview** — KPIs, patient pipeline visual, needs-attention, top panels, verification queue, recent activity. The page that didn't exist before.
5. **Hospital Workspace · Patients** — IPD status pipeline with pills as filter+KPI, bulk select, time-in-stage visible.
6. **Hospital Workspace · Panels** — Overview/Configure sub-tabs (already shipped) plus the RPA-probe Health column for Phase F.
7. **Hospital Workspace · Doctors** — table with expand-row credential drilldown.
8. **Hospital Workspace · Documents** — folder rail + file table with expiry colour priority. Replaces the 840-LOC <span class="mono">HospitalDocsAndDetails</span>.
9. **Hospital Workspace · Profile** — 43 attributes in dense rows by category. Replaces the card-grid.
10. **Doctors** (cross-hospital) — SA-level roster; self-registered doctors awaiting approval surface here.
11. **Master Panels** — coverage + settlement-rate columns; today's screen is just names.
12. **Admin users** — assigned hospitals + permission chips + last-seen.
13. **Attribute definitions** (unified) — entity switcher for Hospital/Panel/Doctor; replaces the three near-duplicate 800-950 LOC managers with one screen.
14. **Master options** — inline drag-to-reorder; same flow with the new visual language.
15. **Validators** — new surface for the validator workflow that the backend already supports.
16. **Reports** — analytics landing with 6 standard reports, CSV/XLSX/PDF exports, scheduled exports.
17. **Audit log** — every mutation, filterable.
18. **Tokens & components** — canonical gallery; all reusable patterns in one place.

The side rail in the mockups is grouped Platform / Configurators / Operations / Inside a hospital / Design system so the journey is browseable in order.

---

## How to review this

1. **Read this doc** for the rationale and phasing.
2. **Open `ui-revamp/wireframes.html` in a browser** to walk the proposed screens.
3. Leave feedback as comments on this document or in chat. Particularly want feedback on:
   - Whether the workspace consolidation (Section 4.3) makes sense before we burn down the old routes.
   - Whether the IPD status state machine (Section 6.1) covers your real flows.
   - Whether anything critical is missing from the side rail (Section 4.1).

Once approved, we'll convert this into a tracked epic and execute Phase A.
