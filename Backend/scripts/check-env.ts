#!/usr/bin/env tsx
/**
 * Standalone environment check.
 *
 * Validates the same contract Backend/src/Utils/env.util.ts enforces at boot,
 * but without booting Express, opening a Postgres pool or touching Redis — so
 * CI and the Compose migrate gate can reject a bad config in ~2 seconds
 * instead of after a migration timeout or a 500 at first request.
 *
 * Usage:
 *   npm run check-env                 # role inferred from RUN_WORKERS
 *   npm run check-env:api             # force the api role
 *   npm run check-env:worker          # force the worker role (strict superset)
 *   tsx scripts/check-env.ts --strict # warnings become exit 2
 *   tsx scripts/check-env.ts --json   # machine-readable {role, issues, ok}
 *   tsx scripts/check-env.ts --env-file .env.ci
 *
 * Exit codes (contract for CI and for compose's migrate gate):
 *   0 = success / nothing to do
 *   1 = validation failure
 *   2 = warnings only, --strict passed
 */

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const wantJson = argv.includes("--json");
const strict = argv.includes("--strict");
const envFile = flagValue("--env-file");
const roleArg = flagValue("--role");

if (roleArg !== undefined && roleArg !== "api" && roleArg !== "worker") {
  console.error(`check-env: --role must be "api" or "worker" (got "${roleArg}")`);
  process.exit(1);
}

// dotenv reads DOTENV_CONFIG_PATH at import time, so the flag has to be applied
// before the side-effecting import below — hence the dynamic imports.
if (envFile) {
  process.env.DOTENV_CONFIG_PATH = envFile;
}

await import("dotenv/config");

const {
  collectEnvIssues,
  detectRole,
  formatEnvIssues,
  describeOptionalGroups,
} = await import("../src/Utils/env.util.js");

const role = (roleArg as "api" | "worker" | undefined) ?? detectRole();
const result = collectEnvIssues({ role, exitOnError: false });

const errors = result.issues.filter((i) => i.severity === "error");
const warnings = result.issues.filter((i) => i.severity === "warn");
const ok = errors.length === 0;

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        role: result.role,
        ok,
        issues: result.issues,
      },
      null,
      2
    )
  );
} else {
  console.log(formatEnvIssues(result.role, result.issues));

  if (ok) {
    console.log("");
    console.log("   Optional groups:");
    for (const g of describeOptionalGroups()) {
      console.log(
        `   ${g.configured ? "✓" : "·"} ${g.group.padEnd(14)} ${g.detail}`
      );
    }
    console.log("");
  }
}

if (!ok) {
  if (!wantJson) console.error("check-env: FAILED\n");
  process.exit(1);
}

if (strict && warnings.length > 0) {
  if (!wantJson) {
    console.error(
      `check-env: ${warnings.length} warning(s) and --strict was passed.\n`
    );
  }
  process.exit(2);
}

process.exit(0);
