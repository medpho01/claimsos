# `Backend/src/schema/` — the operator's map

Everything that defines, migrates, and seeds the ClaimOS Postgres database
(schema `hospital`).

## Layout

```
schema/
├── README.md                   ← you are here
├── schema.sql                  SUPERSEDED. Documentation only; NOT applied.
│                               The genesis is migrations/000_genesis.sql.
├── db-url.cjs                  shared DATABASE_URL composition (+ RDS sslmode)
├── run-migrations.cjs          composes DATABASE_URL, does the genesis
│                               pre-flight stamp, execs node-pg-migrate
├── run-seeds.cjs               checksum-driven seed runner
├── reconcile-ledger.cjs        evidence-based hospital.pgmigrations repair
├── ledger-manifest.json        migration name -> "is it already applied?" probe
├── prod-bootstrap-final.sql    HISTORICAL one-time alignment script (audit only)
├── prod-bootstrap-consolidation.sql   likewise
├── migrations/                 append-only DDL, applied by node-pg-migrate
│   ├── 000_genesis.sql         the 13 core tables + update_modified_column()
│   ├── 001_*.sql … 075_*.sql
│   └── *_rollback.sql          manual helpers; excluded via --ignore-pattern
├── seeds/                      versioned catalog data (see seeds/README.md)
│   ├── 000_*.sql … 060_*.sql
│   └── _dev/                   destructive dev-only scripts; never auto-run
└── data-seeds/                 MANUAL-RUN ONLY; hospital-specific bundles,
                                diagnostics, historical rollbacks
```

## Genesis — and why `schema.sql` is no longer applied

`schema.sql` created the 13 core tables (`users`, `hospitals`, `panels`,
`ipds`, `claims`, `ipd_doc`, …) and `update_modified_column()`. **Nothing ever
executed it automatically**: `run-migrations.cjs` execs
`node-pg-migrate -m migrations`, which never looks at it. So
`migrate:up` against an empty database died at migration `001`, which attaches
a trigger calling `update_modified_column()`, and again at `002_core_fixed`,
which has FKs to `hospital.hospitals` / `hospital.ipds`.

`migrations/000_genesis.sql` is now the authoritative, executable genesis —
the same objects, fully schema-qualified and 100 % idempotent (guarded
`CREATE`s, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` pairs).

`schema.sql` is retained because several docs reference it by path. **If you
change one, mirror it into the other.**

## Migrations vs seeds

|  | `migrations/` | `seeds/` |
| --- | --- | --- |
| Contains | DDL + one-time data moves | catalog data (desired current state) |
| Matched by | filename, in `hospital.pgmigrations` | filename **and sha256**, in `hospital.seed_applications` |
| Re-runs? | never | whenever the file's bytes change |
| Renaming a file | **dangerous** — silently re-runs on prod | breaks the ledger row |
| Runner | `node-pg-migrate` via `run-migrations.cjs` | `run-seeds.cjs` |

Authoring rules for each are enforced by `npm run lint:migrations`. The seed
rules are in [`seeds/README.md`](seeds/README.md); the migration rules are
below.

## Command sequences

### (a) A brand-new, empty database

```bash
npm run db:bootstrap        # = migrate:up && seed
```

`migrate:up` sees an empty (or absent) ledger, applies `000_genesis` for real,
and runs through `075`. `seed` then applies all seven seed files and records
their checksums. Under Docker this is the `migrate` one-shot service that
`backend` and `worker` gate on; `docker compose up -d` is the whole story.

### (b) An existing production database

Production's schema came from a **dump**, so `hospital.pgmigrations` does not
describe reality. Do this in order, and read the plan before applying:

```bash
npm run db:reconcile-ledger:dry    # READ THIS. Expect 000_genesis -> STAMP,
                                   # 066..073 -> STAMP or already present,
                                   # zero UNKNOWN, zero ORDER VIOLATION.
npm run db:reconcile-ledger        # also de-dupes pgmigrations and adds the
                                   # missing UNIQUE index on `name`
npm run check-env:api              # before deploying, not after
npm run check-env:worker
# deploy, then:
npm run migrate:up                 # applies only 074 / 075
npm run seed                       # first run applies all seeds, records checksums
```

`run-migrations.cjs` also stamps `000_genesis` on any database with a
non-empty ledger, as a belt-and-braces backstop for the reconciliation step.
That is safe by construction: a non-empty ledger proves `001+` ran, and `001`
depends on genesis objects.

### (c) After editing a seed

```bash
npm run seed:dry     # confirm exactly one file is listed as changed
npm run seed
```

Never renumber a seed; never rename a migration.

## Idempotency rules the CI guard enforces

Every file under `migrations/` (excluding `*_rollback.sql`) must satisfy:

| | Rule |
| --- | --- |
| R1 | `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS` |
| R2 | `CREATE [UNIQUE] INDEX` → `... IF NOT EXISTS` |
| R3 | `CREATE TRIGGER x ON t` must be preceded by `DROP TRIGGER IF EXISTS x ON t` |
| R4 | every `DROP ...` carries `IF EXISTS`, or sits inside a guarded `DO $$` block |
| R5 / R6 | `CREATE OR REPLACE VIEW` / `FUNCTION` |
| R7 | `CREATE EXTENSION IF NOT EXISTS` |
| R8 | `ADD COLUMN IF NOT EXISTS` |
| R9 | `ADD CONSTRAINT` inside a **conrelid-scoped** `DO $$` guard (or preceded by a matching `DROP CONSTRAINT IF EXISTS`) |
| R12 | no filename duplicates a number+slug, and no released migration is renamed |

`ADD CONSTRAINT` has no `IF NOT EXISTS`, so the guard looks like this — note
that it is scoped by `conrelid` **and** namespace, because `conname` is not
unique across a cluster and a same-named constraint on another relation would
otherwise mask it:

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'hospital'
       AND t.relname = 'my_table'
       AND c.conname = 'my_constraint'
  ) THEN
    ALTER TABLE hospital.my_table ADD CONSTRAINT my_constraint ...;
  END IF;
END $$;
```

## Things that will bite you

**node-pg-migrate does not order by filename.** It orders by
`getNumericPrefix(basename.split('_')[0])`, and *any prefix that is not all
digits falls back to 0*. So `002b_*`, `002c_*` and `003b_*` all sort to 0 and
run **before** `001_add_s3_support` and `002_core_fixed`. Several of those
files therefore carry explicit ordering guards (they skip when the objects a
later-numbered file creates are not there yet). `reconcile-ledger.cjs`
reproduces this ordering exactly for its order-safety check. If you add a
migration, give it an all-digits prefix.

**Migration files that contain their own `BEGIN;` / `COMMIT;`** (most of them
do) commit node-pg-migrate's outer transaction early. A failure mid-run
therefore leaves partial state instead of rolling everything back. Do not add
new ones; if you do, know that this is why a failed run can leave a half-built
schema.

**Prod-history caveats.** These were applied by hand and are not reflected in
the ledger the way you would expect:

* the whole schema came from a **dump**, so `hospital.pgmigrations` is
  unreliable — always reconcile before trusting it;
* `018_fix_ipd_doc_column_names` (the `"doc_metadata "` → `doc_metadata`
  rename — the original column name really did end in a space);
* `hospital.doctor_share_tokens` from
  `005_create_doctor_configuration_system`;
* three columns on `panel_attribute_documents`;
* `prod-bootstrap-final.sql` stamped 65 names with an `ON CONFLICT DO NOTHING`
  that could never fire, because `hospital.pgmigrations` has no unique index
  on `name`. Re-running it duplicated every row. That block has been removed
  and `reconcile-ledger.cjs` repairs the damage.

**`hospital.doctors` has two competing definitions.** Genesis creates a
narrow, hospital-scoped table; `005_create_doctor_configuration_system.sql`
declares a wide independent registry. Genesis wins the `CREATE TABLE IF NOT
EXISTS` race on a fresh database, so 005 carries an `ADD COLUMN IF NOT EXISTS`
shim that converges the two shapes. The same pattern appears for
`hospital_profile`, `panel_empanelments` and `panel_documents`, where
`002_core_fixed.sql` wins with a narrower shape than
`002_hospital_profile.sql` / `002_core_new_tables_v2.sql` declare.

**`pgvector` is required.** `039_episodic_memory.sql` does
`CREATE EXTENSION IF NOT EXISTS vector`. A stock `postgres:16` image does not
have it — use `pgvector/pgvector:pg16` (or an RDS instance with the extension
available) for local and CI databases.
