# `seeds/` — versioned, checksum-driven catalog data

Applied by `src/schema/run-seeds.cjs` (`npm run seed`, `npm run seed:dry`).

## Why seeds are not migrations

Migrations are **append-only DDL**, matched by filename and never re-run.
Seed data is a **desired current state** that has to be re-asserted whenever
the catalog changes — a new `doc_category`, a corrected field schema, a
retuned extraction hint.

Squeezing that into migrations forces a new numbered file for every catalog
tweak, and (because the historical seed migrations all used
`ON CONFLICT ... DO NOTHING`) corrections never actually reached an
environment that had already run the original. So this directory exists, with
its own ledger:

```
hospital.seed_applications(
  seed_name     TEXT PRIMARY KEY,
  checksum      TEXT        NOT NULL,   -- sha256 hex of the file bytes
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rows_affected INTEGER     NOT NULL DEFAULT 0
)
```

created by migration `075_seed_ledger.sql` (and re-asserted defensively by the
runner). **Apply rule:** a seed is applied when its `seed_name` is absent from
the ledger *or* its checksum differs. Then the row is upserted.

Change a seed's bytes → its checksum changes → the next `npm run seed`
re-applies exactly that one file. That is the intended release mechanism.

## What is in here

| File | Table | Conflict behaviour |
| --- | --- | --- |
| `000_master_options_doc_category_groups.sql` | `master_options` (`doc_category_group`) | `DO UPDATE` |
| `010_master_options_doc_category.sql` | `master_options` (`doc_category`) | `DO UPDATE` |
| `020_document_field_schemas.sql` | `document_field_schemas` | `DO UPDATE` |
| `030_concept_aliases.sql` | `concept_aliases` | `DO NOTHING` (additive; never clobber a curated alias) |
| `040_insurer_rule_sets.sql` | `insurer_rule_sets` + rules + 3 child catalogues | `DO UPDATE` |
| `050_attribute_definitions.sql` | `attribute_definitions` | `DO UPDATE` |
| `060_panel_attribute_definitions.sql` | `panel_attribute_definitions` | `DO UPDATE` |

Files are applied in **lexical order**, so the numeric prefix is the
dependency order: groups before categories, rule sets before their children.

`_dev/` holds destructive, developer-only scripts (currently
`cleanup_pragati_hospital.sql`, which wipes one hospital's data). **The runner
skips any path containing a `_dev/` segment** — those never run as part of a
bootstrap. Run them by hand, deliberately, with `psql`.

## Authoring rules (enforced by `npm run lint:migrations`)

1. **Every statement is `INSERT ... ON CONFLICT ...` or `UPDATE ... WHERE`.**
   No bare `INSERT`.
2. **No `DELETE`.** A seed asserts what should exist; it never removes rows a
   human or the app may have added.
3. **No DDL.** Tables, columns and constraints belong in `migrations/`. A seed
   assumes its target table already exists, because `npm run db:bootstrap`
   runs `migrate:up` first.
4. **No `BEGIN` / `COMMIT` / `ROLLBACK`.** The runner owns the transaction —
   one transaction per file, rolled back entirely if any statement fails.
5. **Order-independent apart from the numbered prefix.** Do not rely on a
   later file having run.
6. **Never renumber or rename a seed.** The ledger keys on `seed_name` (the
   basename without `.sql`); renaming makes the old row an orphan and
   re-applies the file under its new name.
7. **Declare state, do not replay history.** One-time renames and backfills
   belong in a migration. A seed that renames a row breaks the moment an
   earlier seed re-creates the old row — write the final desired row instead.

## `extraction_mode` is operator-owned

One column in `010_master_options_doc_category.sql` breaks the "the file is the
desired state" rule on purpose.

`master_options.extraction_mode` (`ocr` | `vision` | `auto`, NULL = fall through
to `DOC_EXTRACT_DEFAULT_MODE`) decides, per document category, whether a page
goes to Tesseract or to a **per-page Claude Vision call**. It is a live cost
dial, and it is the dial an operator reaches for during a spend incident.

**The rule: a non-NULL `extraction_mode` in the database is operator intent and
is never overwritten by an automated re-run.**

Both re-run paths obey it:

| Path | Mechanism |
| --- | --- |
| `npm run seed` | `extraction_mode = COALESCE(hospital.master_options.extraction_mode, EXCLUDED.extraction_mode)` — the DB value wins; the file only supplies it for a new row or a NULL one |
| migration replay (`052_vision_routing_for_handwritten_categories.sql`) | every `UPDATE` is guarded `AND extraction_mode IS NULL`, so the statement falsifies its own predicate and a replay touches nothing |

The half-fix that preceded this was `COALESCE(EXCLUDED, existing)` — "the seed
wins unless the seed is NULL". That protected only the 140 rows whose seed value
is NULL; the 106 rows the file pins explicitly (98 `vision`, 8 `auto`) were
reverted on the next re-seed. Same operator action, opposite outcome, decided by
whether that row happened to carry a literal.

**Changing a category's routing, by who you are:**

* **Operator, one environment, now** — `UPDATE hospital.master_options SET
  extraction_mode = 'ocr' WHERE category = 'doc_category' AND code = '…';`
  It survives every subsequent `npm run seed` and `migrate:up`.
* **Operator, undoing your own pin** — set it back to `NULL`, then
  `node src/schema/run-seeds.cjs --force --only 010_master_options_doc_category`
  to let the committed default re-apply.
* **Fleet-wide, permanent, reviewed** — ship a **new numbered migration** that
  names the categories it re-routes (that is exactly what `050` and `052` are).
  A migration is applied once, by name, and is reviewable. Editing the mode
  column in the seed file does **not** travel to an environment that already has
  a value, and rule 7 below is the reason: one-time transitions belong in
  `migrations/`.

Guarding `052` does not change what a fresh bootstrap produces: composing
`050 → 052` over this file's 246-code universe yields an identical per-code mode
with and without the guard (no code is set by `050` and then re-routed to a
different value by `052`). A new environment still ends up at exactly the
committed catalog.

## Regenerating a seed from a known-good database

These files are declarative snapshots: they were generated from a database
that had run every migration in order, so they are the union of the historical
seed migrations with every later rename and correction folded in. If a future
migration changes the catalog again, the cheapest way to refresh a seed is to
`migrate:up` a scratch database and emit the table back out with
`quote_literal` / `quote_nullable`, rather than hand-merging.

Child rows that reference a parent by surrogate UUID (the insurer rule-set
children) must be written as `INSERT ... SELECT rs.id ... WHERE rs.rule_set_id
= '<business key>'` — the UUID differs per environment.

## Commands

```bash
npm run seed          # apply everything whose checksum changed
npm run seed:dry      # print the plan, touch nothing
node src/schema/run-seeds.cjs --only 020_document_field_schemas
node src/schema/run-seeds.cjs --force        # re-apply regardless of checksum
```

The runner takes `pg_advisory_lock(hashtext('claimsos_seeds'))` for the whole
run, so two containers in a scaled-out deploy cannot interleave.
