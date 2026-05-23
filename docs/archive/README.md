# Archive

Historical docs preserved for reference. **Nothing here should be treated as authoritative for current code behavior** — see the root `PRODUCT_SPEC.md`, `TECHNICAL_SPEC.md`, and `TECH_DEBT.md` instead.

## Contents

### `audits/`
The May 2026 end-to-end audits that feed the canonical specs at the repo root. Useful when you want the raw file-and-line citations behind a tech-debt item.

- `2026-05-backend-audit.md` — backend architecture, API surface, schema, services, 10 confirmed bugs, security & migration concerns.
- `2026-05-webapp-audit.md` — React app structure, 18+ files >500 LOC, duplicate components, snake/camel mixing.
- `2026-05-mobile-audit.md` — Flutter app, iOS blockers, build & signing issues.

### `april-2026/`
The 34 ad-hoc markdown files that lived at the repo root from April 18–24, 2026. Mix of:
- Implementation logs (`*_FEATURE.md`, `*_ENHANCEMENT.md`)
- Status updates (`BACKEND_RUNNING.md`, `CURRENT_STATUS.md`, `STATUS_SUMMARY.md`)
- Setup/debug guides (`DOCKER_DEV.md`, `DEBUG_DOWNLOAD.md`)
- Original product & architecture docs (`PRODUCT_DOCUMENT.md`, `ARCHITECTURE_TDD.md`, `ADR-001_HOSPITAL_PROFILE_ARCHITECTURE_v2.md`)
- Testing guides (`TESTING_GUIDE.md`, `TESTING_COMPLETE_WORKFLOW.md`)

The two largest originals (`ARCHITECTURE_TDD.md` 50KB, `PRODUCT_DOCUMENT.md` 31KB) were the previous canonical docs. Their content has been distilled and re-organized into the new top-level specs.

### `webapp/`
Webapp-specific design notes — `COMPONENT_VERIFICATION.md`, `DOCUMENT_UPLOAD_INTEGRATION.md`, `STICKY_HEADERS_PLAN.md`.

### `migrations/`
Migration planning docs that lived inside `Backend/src/schema/migrations/`:
- `MIGRATION_PLAN_2026-04-27.md`
- `MIGRATION_SUMMARY_2026-04-27.md`
- `README_MIGRATION_2026-04-27.md`
- `QUICK_REFERENCE.md`

The migration framework adoption planned in `TECH_DEBT.md` P1-10 will supersede these.

---

## Policy

Going forward:
- **Specs & policy** → root (`README.md`, `PRODUCT_SPEC.md`, `TECHNICAL_SPEC.md`, `TECH_DEBT.md`).
- **Active design proposals (RFCs)** → `docs/rfcs/` once we have any.
- **Transient working notes** (sprint scratchpads, debug logs, demo prep) → `docs/working/` and `.gitignore` if truly throwaway.
- **Nothing else at repo root.**
