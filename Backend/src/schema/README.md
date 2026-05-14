# `Backend/src/schema/`

Database schema, migrations, and data-seed scripts for the ClaimOS Postgres
database.

## Layout

```
schema/
├── README.md                 ← you are here
├── schema.sql                 baseline DDL referenced by the docs; historical
├── run-migrations.cjs         shim that composes DATABASE_URL from POSTGRES_*
│                              and execs node-pg-migrate
├── migrations/                files applied by the migration runner
│   ├── 001_*.sql … 010_*.sql
│   └── …
├── data-seeds/                MANUAL-RUN ONLY scripts (NOT applied automatically)
│   ├── PRODUCTION_*.sql       hospital-name-specific data bundles
│   ├── 006_verify_seed_data.sql
│   ├── 007/008_export_*.sql   diagnostic exports
│   ├── 009_migration_status_report.sql
│   ├── 00*_*_rollback.sql     standalone rollback scripts
│   └── INDEX_2026-04-27.txt
└── seeds/                     legacy directory of one-off cleanup SQL
```

`migrations/` is the only directory that the runner reads.  Everything in
`data-seeds/` is invoked by hand with `psql` after a human review — it includes
hospital-name-specific data dumps, diagnostic queries, and historical rollback
scripts that were never wired up to a proper down-migration runner.

## Migration runner

We use [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) (PG-only,
zero JS code in our migrations — every file is plain SQL with `IF NOT EXISTS`
guards so it can be re-applied safely).

The runner is invoked through a small shim (`run-migrations.cjs`) which composes
a `DATABASE_URL` connection string from the same `POSTGRES_*` env vars that the
runtime application reads from `Backend/.env`.

### Daily workflow

```bash
# Apply all pending migrations.
npm run migrate:up

# Roll back the last applied migration (rarely used; review the down SQL first).
npm run migrate:down

# Create a new migration file. The runner timestamps it for you.
npm run migrate:create -- add_my_new_table
```

Inside Docker:

```bash
docker compose exec backend npm run migrate:up
```

The runner records applied migrations in `hospital.pgmigrations` (created on
first run because the script is launched with `--schema hospital
--create-schema`).

### Conventions for new migrations

1.  One logical change per file.
2.  Filename: `NNN_short_snake_case_name.sql` where `NNN` is the next free
    integer.  (`npm run migrate:create` will hand back a timestamp-prefixed
    name; either convention works — both sort lexicographically.)
3.  Always wrap DDL/DML in `IF NOT EXISTS` / `DO $$ ... END $$` guards so the
    file is idempotent.  We expect production operators to re-run on partial
    failure.
4.  Wrap the body in `BEGIN; ... COMMIT;` unless the file uses statements that
    can't run inside a transaction (e.g. `CREATE INDEX CONCURRENTLY`).
5.  No environment-specific data.  Hospital-specific data goes in
    `data-seeds/`.

### Adding hospital-specific data

Do **not** put one-off `INSERT INTO hospitals VALUES (…)` statements into
`migrations/`.  Put them in `data-seeds/<hospital_short_name>.sql` and apply
them by hand with `psql` against the target environment.

## Schema-prefix convention

All current tables live in the `hospital` schema.  The runtime
(`Backend/src/DB/db.ts`) sets `options: '-c search_path=hospital'` on every
pooled connection so most queries can omit the prefix and Just Work.

**Going forward, prefer `hospital.<table>` in new SQL.**  Bare references still
resolve because of the search-path setting, but the explicit prefix:

- makes it obvious in audit logs/EXPLAIN output which schema is being touched,
- survives connections that don't get the search-path option (psql shells,
  ad-hoc tooling, future read replicas pointed at the same DB),
- keeps the door open to running multiple tenant schemas in one cluster.

Migration `010` is the first to follow this convention strictly; older
migrations are mixed.  Do not rewrite them — the next time you touch a table,
prefix the new references.

## Known schema drift (deferred, NOT touched here)

The current state has duplicate tables created across the unmanaged migration
history.  This document records them so future work has a starting point.  We
deliberately did **not** consolidate them in this change — the unification
needs careful data-migration and is a separate PR.

| Concept           | Tables that currently exist           | Plan                                           |
|-------------------|----------------------------------------|------------------------------------------------|
| Doctor            | `doctors` (schema.sql), `hospital.doctors` (005) | Pick `hospital.doctors`; backfill + drop the other. (BE M26) |
| Doctor documents  | `doctor_doc`, `hospital.doctor_attribute_documents` | `doctor_attribute_documents` is the new model; `doctor_doc` is the legacy upload table. Decide one. (BE M27) |
| Hospital docs     | `hospital_doc`, `hospital.hospital_documents` | Same story — pick the polymorphic-attribute model and migrate. |

`validator_*` tables (created by `004_create_validator_verification_system.sql`)
exist but have no controllers/services referencing them yet (BE M28).  Left in
place; consolidation lives with the doctor/document cleanup.

## What migration 010 changed

Closes BE-review items **M23**, **M24**, **M29**.  See
`migrations/010_consolidate_constraints_and_audit_logs.sql`.

- `UNIQUE(hospital_id, panel_id)` constraint on `hospital_panels` (M24).
- `ipds.phone` and `hospital_panels.contact` widened from `CHAR(10)` to
  `VARCHAR(20)` (M23) — `CHAR(10)` was left-padding numbers and failed for
  country-code-prefixed numbers.
- Creates `hospital.audit_logs` with indexes on `created_at DESC`,
  `(entity_type, entity_id)`, `user_id`, and `action` (M29).

### Note on `audit_logs` column names

The original review (REVIEW_BACKEND.md M29) proposed
`actor_user_id / resource_type / resource_id / payload`.  The migration
intentionally uses the names the running application code already writes to —
`user_id / entity_type / entity_id / details / ip_address / user_agent` — so
that `Backend/src/Services/audit.service.ts` and
`Backend/src/Controllers/audit.controller.ts` start working without code
changes.  If we want to rename to the review's spec later, that goes in a
follow-up migration paired with a service-layer rename.

## CI / production tips

- Always run `npm run migrate:up` before starting the new container revision.
- `DATABASE_URL` overrides the assembled `POSTGRES_*` connection string if both
  are set — useful for one-off psql-style runs against a replica.
- `hospital.pgmigrations` is the runner's bookkeeping table.  Do **not** drop
  it without also clearing the migration files you want re-applied.
