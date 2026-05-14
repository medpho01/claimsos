# ClaimsOS

**Hospital-network operations platform for India's cashless health-insurance ecosystem.**
Built by Finclarity-Tech / 24Eleven Healthcare.

ClaimsOS captures, verifies, and routes the evidence required to process insurance claims — patient documents, doctor credentials, hospital empanelment proofs — and surfaces a verifiable public profile per hospital and per doctor that insurers, regulators, and patients can trust.

---

## Documentation

| Doc | Purpose |
|---|---|
| [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) | What we're building, for whom, and the roadmap. |
| [`TECHNICAL_SPEC.md`](./TECHNICAL_SPEC.md) | How the system is built — backend, webapp, mobile. |
| [`TECH_DEBT.md`](./TECH_DEBT.md) | Prioritized list of known bugs, security holes, and cleanup work. |
| [`docs/archive/`](./docs/archive/) | Historical design docs, plans, and audit reports. |

Start here before opening a ticket or shipping a change.

---

## Repository Layout

```
claimsos/
├── Backend/      Node.js + TypeScript + Express 5 (service name: 24eleven-backend)
├── webapp/       React 19 + Tailwind + shadcn/ui (CRA + CRACO)
├── Frontend/     Flutter mobile app (Android primary, iOS in progress)
└── docs/         Archived design docs and audit reports
```

See `TECHNICAL_SPEC.md` for the full architecture and folder conventions inside each app.

---

## Quick Start (Local Dev)

### Backend
```bash
cd Backend
cp .env.example .env       # populate ACCESS_TOKEN_SECRET, DB creds, AWS keys, etc.
npm install
npm run dev                # starts on :6001
```
Requires Postgres + Redis. See `Backend/Dockerfile.dev`.

### Webapp
```bash
cd webapp
npm install
npm start                  # starts on :3000, proxies API to localhost:6001
```

### Mobile
```bash
cd Frontend
flutter pub get
flutter run                # connects to BASE_ADDRESS from Frontend/.env
```

For Docker-based dev see `Backend/Dockerfile.dev` and `webapp/Dockerfile.dev`.

---

## Production

- Backend deployed at `https://claims.24elevenhealthcare.com`.
- Webapp served by nginx (see `webapp/nginx.conf`).
- Mobile Android release configured (`com.claimsos.app`); iOS release blocked — see TECH_DEBT P0-5/P0-6.

---

## Conventions

- **Commits:** present-tense imperatives, scoped where useful (e.g., `fix(api): correct deletePatient ownership`).
- **Branches:** `feature/<name>`, `fix/<name>`, `chore/<name>`.
- **PRs:** must reference a TECH_DEBT id or a roadmap item from PRODUCT_SPEC. Type-check (`tsc --noEmit`) must pass.
- **New docs:** if it's a design proposal that will become canon, fold it into `TECHNICAL_SPEC.md`. If it's transient (sprint plan, debug session), put it in `docs/working/` — not the repo root.

---

## License

Proprietary. © 2026 Finclarity-Tech.
