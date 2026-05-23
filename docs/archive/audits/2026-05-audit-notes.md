# May 2026 End-to-End Audit — Notes

**Date:** 2026-05-13
**Scope:** Backend, Webapp, Flutter mobile app.
**Outcome:** Three parallel deep audits whose findings have been distilled into the canonical specs at the repo root.

## Where the findings live now

- **Product framing & feature inventory** → [`/PRODUCT_SPEC.md`](../../../PRODUCT_SPEC.md)
- **Architecture, stack, folder layouts, API surface, build setup** → [`/TECHNICAL_SPEC.md`](../../../TECHNICAL_SPEC.md)
- **Confirmed bugs, security holes, prioritized debt with file:line citations** → [`/TECH_DEBT.md`](../../../TECH_DEBT.md)

## Headline findings (summary)

### Backend (`24eleven-backend`)
- 10 confirmed bugs in production code paths — see TECH_DEBT P0-1 through P0-4 and P1 items.
- Migration hygiene crisis: `_fixed` variants, hospital-specific exports living in `migrations/`, no tracking table.
- Three parallel verification subsystems with overlapping responsibilities.
- `Routes/doctors.routes.ts` imported but never mounted (dead code).
- `audit_logs` table referenced by code and routes but does not exist.

### Webapp
- Build script disables ESLint silently (`DISABLE_ESLINT_PLUGIN=true`).
- `tsconfig.json` has all strict flags **off**; 233 `: any` usages.
- 18+ files over 500 LOC; three near-duplicate ~900-LOC attribute-definition managers.
- Three credential-editing UIs, two `PublicSharingManager`s, two `ProfileForm`s, two dialog systems, two skeleton components.
- No error boundaries anywhere.

### Mobile (Flutter)
- iOS unshippable: `Info.plist` missing all permission usage descriptions; bundle id still `com.example.hospitalApp`.
- Android `applicationId` (`com.claimsos.app`) vs `namespace` (`com.twentyfoureleven.claims`) mismatch breaks in-app update deeplink.
- Signing credentials hardcoded in `android/app/build.gradle.kts` in plain text.
- No tests, no CI/CD, no state management library.
- 39 catch-all error handlers swallowing exceptions; no Crashlytics/Sentry.

## What's working well

- **Token refresh** mutex+queue implementation in webapp `services/api.ts` is correctly designed.
- **V2 upload pipeline** is the right architecture (S3-direct + Bull retry backbone).
- **Watermark overlay** in mobile camera flow (GPS + reverse-geocoded address + map thumbnail + timestamp) is a coherent solution to the on-site-capture evidentiary requirement.
- **Share-token system** for hospitals & doctors is clean and separable.
- **shadcn/ui adoption** in newer webapp pages.
- **Secure token storage** on mobile (Keychain / Android Keystore).
- **Bull queue graceful degradation** when Redis is down.

---

*Run by Claude as part of a comprehensive cleanup pass requested 2026-05-13. The full raw audit transcripts (with every file:line citation) are preserved in this run's session transcript at `/Users/maverick/.claude/projects/-Users-maverick-Documents-finclarity/6c2bdd94-4372-4d93-ad56-7841114f7377.jsonl`.*
