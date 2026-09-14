/**
 * Role-aware environment-variable validation at boot.
 *
 * Backend review C9 — several middlewares use `process.env.ACCESS_TOKEN_SECRET!`
 * (non-null assertion) and DB code does `parseInt(process.env.POSTGRES_PORT || " ")`
 * which silently produces NaN. The result is that a misconfigured deploy boots
 * "successfully" and then explodes at request time with cryptic errors (or
 * worse: jwt.verify accepts unsigned tokens when the secret is empty).
 *
 * Deployment hardening (§5.2) extends that mechanism past Postgres + JWT to the
 * vars that are *silently* required — the ones with a hard-coded default that
 * looks fine at boot and fails opaquely hours later:
 *
 *   REDIS_URL             20 worker files default to `redis://localhost:6379`,
 *                         which inside a container resolves to the container's
 *                         own loopback. The queue never drains and nothing logs.
 *   ANTHROPIC_API_KEY     read lazily in documentExtraction.service.ts; the SDK
 *                         throws at first call, i.e. mid-pipeline.
 *   AWS_ACCESS_KEY_ID /   s3.service.ts defaults both to '' — every upload dies
 *   AWS_SECRET_ACCESS_KEY with an opaque SDK error.
 *   ENC_KEY               crypto.util.ts throws only at the first Gmail token
 *                         decrypt, long after boot.
 *
 * WHAT IS *NOT* A HARD ERROR, AND WHY. A boot guard that refuses a config the
 * runtime can actually serve is worse than no guard: it turns a deploy into an
 * outage. Two cases are therefore warnings, deliberately:
 *
 *   AWS_ACCESS_KEY_ID /   the empty-string default in s3.service.ts:25-26 is
 *   AWS_SECRET_ACCESS_KEY exactly how the AWS SDK falls through to its own
 *                         credential chain, so an ECS/EC2 deployment running on
 *                         an instance/task IAM ROLE has no static keys by
 *                         design and uploads work. Erroring here would
 *                         process.exit(1) a deployment that boots today.
 *   ENC_KEY in production only Gmail token encrypt/decrypt uses it. A prod
 *                         install with no Google OAuth client configured, or
 *                         with GMAIL_POLL_ENABLED=false, never reaches a
 *                         decrypt — see checkEncKey for the exact condition
 *                         under which it is still an error.
 *
 * A MALFORMED value stays a hard error in both cases: a 17-byte ENC_KEY cannot
 * work, whereas an absent one can.
 *
 * Validation is ROLE-AWARE: `worker` is a strict superset of `api` (the worker
 * runs the same index.ts entrypoint and still serves JWT-protected internals),
 * so the only difference is the queue/AI/S3 block. The role is derived from
 * RUN_WORKERS exactly the way the 20+ runtime call-sites derive it, so the
 * validator and the runtime can never disagree: unset means workers RUN.
 *
 * Every value is trimmed, and leading/trailing whitespace on a secret/URL/key
 * is a hard error rather than a silent trim — `docker run --env-file` rejects
 * those values outright while Compose tolerates them, which is exactly how they
 * got into the live .env in the first place.
 *
 * ALL problems are reported in one block before exiting; warnings alone never
 * abort boot.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export type AppRole = "api" | "worker";

export type EnvSeverity = "error" | "warn";

export interface EnvIssue {
  /** The offending variable name, e.g. "REDIS_URL". "" for cross-variable checks. */
  variable: string;
  /** Human-readable, actionable. Must name the fix, not just the defect. */
  message: string;
  severity: EnvSeverity;
}

export interface ValidatedEnv {
  role: AppRole;
  NODE_ENV: "development" | "production" | "test";
  PORT: number;

  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SSLMODE?: string;
  DB_SSL: boolean;

  ACCESS_TOKEN_SECRET: string;
  ACCESS_TOKEN_EXPIRY: string;
  REFRESH_TOKEN_EXPIRY_DAYS: number;

  /** Required when role === "worker". */
  REDIS_URL?: string;
  /** Required when role === "worker". Canonical name; CLAUDE_API_KEY is a legacy alias. */
  ANTHROPIC_API_KEY?: string;

  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_S3_BUCKET: string;

  /** Required when NODE_ENV === "production". */
  ENC_KEY?: string;

  CORS_ORIGIN?: string;
  APP_BASE_URL?: string;
  METRICS_TOKEN?: string;
}

export interface ValidateEnvOptions {
  /** Defaults to detectRole(env). */
  role?: AppRole;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to true. When false, throws EnvValidationError instead of exiting. */
  exitOnError?: boolean;
  /** Defaults to true. Writes trimmed/normalised values back into process.env. */
  applyNormalisation?: boolean;
}

export interface EnvValidationResult {
  role: AppRole;
  issues: EnvIssue[];
  /** null iff issues contains at least one severity === "error". */
  value: ValidatedEnv | null;
}

export class EnvValidationError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    const errors = issues.filter((i) => i.severity === "error");
    super(
      `Environment validation failed: ${errors
        .map((i) => (i.variable ? `${i.variable}: ${i.message}` : i.message))
        .join("; ")}`
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/** Back-compat alias — Backend/src/index.ts and anything else importing AppEnv must keep compiling. */
export type AppEnv = ValidatedEnv;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vars whose value is a secret, URL, key or identifier — a stray space in any
 * of these is a deploy-breaking typo, never intent. Erroring (rather than
 * silently trimming) is what stops the value from being re-pasted with the
 * space still on it next time.
 */
const WHITESPACE_SENSITIVE = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_SSLMODE",
  "ACCESS_TOKEN_SECRET",
  "REDIS_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_S3_BUCKET",
  "S3_BUCKET",
  "ENC_KEY",
  "ENC_KEY_PREVIOUS",
  "CORS_ORIGIN",
  "APP_BASE_URL",
  "FRONTEND_URL",
  "METRICS_TOKEN",
] as const;

/** Hosts that mean "this container", i.e. never a reachable Redis in Compose. */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/**
 * Legacy → canonical name pairs. The runtime reads `CANONICAL || LEGACY`, so a
 * legacy-only config still works; it just drifts from the documented contract.
 */
const ALIAS_PAIRS: Array<{ legacy: string; canonical: string }> = [
  { legacy: "S3_BUCKET", canonical: "AWS_S3_BUCKET" },
  { legacy: "CLAUDE_API_KEY", canonical: "ANTHROPIC_API_KEY" },
  { legacy: "FRONTEND_URL", canonical: "APP_BASE_URL" },
];

/** Runtime defaults, duplicated here verbatim so validation never shifts behaviour. */
const DEFAULT_PORT = "8000";
const DEFAULT_AWS_REGION = "ap-south-1";
const DEFAULT_AWS_S3_BUCKET = "hospital-app-images";

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas — three composable shapes so the role branch is data, not an
// if-ladder. `worker` = `api` + queue/AI/S3; `api` = `base` + JWT.
// ─────────────────────────────────────────────────────────────────────────────

/** Required, trimmed, non-empty. */
const req = (message: string) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .transform((s) => s.trim())
    .pipe(z.string().min(1, message));

/** Optional, trimmed; an empty/whitespace-only value collapses to undefined. */
const opt = () =>
  z
    .string()
    .optional()
    .transform((s) => {
      const t = (s ?? "").trim();
      return t.length > 0 ? t : undefined;
    });

const numeric = (message: string) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .transform((s) => s.trim())
    .pipe(z.string().regex(/^\d+$/, message))
    .transform((s) => Number(s));

const baseShape = {
  // Accept any case (`Production`, `PRODUCTION`, `production`) — older
  // deployments wrote `NODE_ENV=Production` and we don't want validation to
  // hard-stop boot over a casing nit. We lowercase + normalise downstream.
  NODE_ENV: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["development", "production", "test"])),
  PORT: numeric("PORT must be a port number"),

  // Database — required
  POSTGRES_HOST: req("POSTGRES_HOST is required"),
  POSTGRES_PORT: numeric("POSTGRES_PORT must be a port number"),
  POSTGRES_USER: req("POSTGRES_USER is required"),
  POSTGRES_PASSWORD: req("POSTGRES_PASSWORD is required"),
  POSTGRES_DB: req("POSTGRES_DB is required"),
  POSTGRES_SSLMODE: opt(),
  // DB/db.ts compares against the literal string "true"; mirror that exactly.
  DB_SSL: z
    .string()
    .optional()
    .transform((s) => (s ?? "").trim().toLowerCase() === "true"),

  // S3 targeting has runtime defaults; the credentials do not (see workerShape).
  AWS_REGION: req("AWS_REGION is required"),
  AWS_S3_BUCKET: req("AWS_S3_BUCKET is required"),

  ENC_KEY: opt(),
  CORS_ORIGIN: opt(),
  APP_BASE_URL: opt(),
  METRICS_TOKEN: opt(),
};

const apiShape = {
  ...baseShape,
  // Auth — required, real values (no empty strings)
  ACCESS_TOKEN_SECRET: req(
    "ACCESS_TOKEN_SECRET is required"
  ).pipe(
    z
      .string()
      .min(
        32,
        "ACCESS_TOKEN_SECRET must be at least 32 chars — short secrets defeat jwt.verify"
      )
  ),
  ACCESS_TOKEN_EXPIRY: req("ACCESS_TOKEN_EXPIRY is required"),
  REFRESH_TOKEN_EXPIRY_DAYS: numeric(
    "REFRESH_TOKEN_EXPIRY_DAYS must be an integer"
  ),
  // The API process imports the queue modules to .add() jobs but never
  // consumes them, so Redis is a warning here, not an error (see checkRedis).
  REDIS_URL: opt(),
  ANTHROPIC_API_KEY: opt(),
  AWS_ACCESS_KEY_ID: opt(),
  AWS_SECRET_ACCESS_KEY: opt(),
};

const workerShape = {
  ...apiShape,
  REDIS_URL: req(
    "required for the worker role — set REDIS_URL=redis://redis:6379"
  ),
  ANTHROPIC_API_KEY: req(
    "required for the worker role (AI extraction) — set ANTHROPIC_API_KEY"
  ),
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are deliberately NOT req() here:
  // absent static keys is the normal shape of an IAM-role deployment. They are
  // checked in checkAwsCredentials, which warns instead (see the module
  // docblock).
};

const apiSchema = z.object(apiShape);
const workerSchema = z.object(workerShape);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** RUN_WORKERS === "false" (trimmed, case-insensitive) => "api", else "worker". */
export function detectRole(env: NodeJS.ProcessEnv = process.env): AppRole {
  // Must MATCH the runtime check used in 20+ files (`process.env.RUN_WORKERS
  // === 'false'`, e.g. Workers/actionEngine.queue.ts, index.ts:191). Unset
  // means workers RUN, so validating for the stricter role is correct.
  return (env.RUN_WORKERS ?? "").trim().toLowerCase() === "false"
    ? "api"
    : "worker";
}

/** Trimmed value, or undefined when unset/blank. */
function pick(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Number of bytes an ENC_KEY-shaped value decodes to, mirroring
 * Utils/crypto.util.ts exactly (64-char hex, else base64).
 */
function decodedKeyBytes(raw: string): number {
  try {
    const buf =
      raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return buf.length;
  } catch {
    return -1;
  }
}

/** Hostname of a redis:// URL, brackets stripped; null when unparseable. */
function redisHost(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-variable checks
// ─────────────────────────────────────────────────────────────────────────────

function checkWhitespace(env: NodeJS.ProcessEnv, issues: EnvIssue[]): void {
  for (const name of WHITESPACE_SENSITIVE) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (raw !== raw.trim()) {
      issues.push({
        variable: name,
        severity: "error",
        message:
          `${name} has leading/trailing whitespace — strip it ` +
          `(docker run --env-file rejects these values while Compose silently tolerates them)`,
      });
    }
  }
}

function checkRedis(
  env: NodeJS.ProcessEnv,
  role: AppRole,
  nodeEnv: string,
  issues: EnvIssue[]
): void {
  const url = pick(env.REDIS_URL);

  if (!url) {
    if (role === "api") {
      issues.push({
        variable: "REDIS_URL",
        severity: "warn",
        message:
          "unset — the API imports the queue modules to .add() jobs, so enqueues will fail. " +
          "Set REDIS_URL=redis://redis:6379",
      });
    }
    // role === "worker" is already a schema-level error.
    return;
  }

  if (!/^rediss?:\/\//i.test(url)) {
    issues.push({
      variable: "REDIS_URL",
      severity: "error",
      message: "must start with redis:// or rediss:// — e.g. redis://redis:6379",
    });
    return;
  }

  const host = redisHost(url);
  if (host === null) {
    issues.push({
      variable: "REDIS_URL",
      severity: "error",
      message: "is not a parseable URL — e.g. redis://redis:6379",
    });
    return;
  }

  if (nodeEnv === "production" && LOOPBACK_HOSTS.has(host.toLowerCase())) {
    issues.push({
      variable: "REDIS_URL",
      severity: "error",
      message:
        "REDIS_URL points at localhost in production — in Compose this must be redis://redis:6379; " +
        "the localhost default means the worker silently never drains its queues",
    });
  }
}

function checkAnthropic(
  env: NodeJS.ProcessEnv,
  issues: EnvIssue[]
): void {
  const canonical = pick(env.ANTHROPIC_API_KEY);
  const legacy = pick(env.CLAUDE_API_KEY);

  if (!canonical && legacy) {
    issues.push({
      variable: "CLAUDE_API_KEY",
      severity: "warn",
      message: "CLAUDE_API_KEY is a legacy alias; set ANTHROPIC_API_KEY",
    });
  }
}

/**
 * Static S3 credentials. A WARNING, never an error.
 *
 * s3.service.ts:25-26 passes `process.env.AWS_ACCESS_KEY_ID || ''` into the v3
 * client; an empty/absent pair makes the SDK use its default provider chain
 * (env → shared config → ECS task role → EC2 instance role), which is how every
 * IAM-role deployment is supposed to be configured. So "unset" is either a
 * correct IAM-role setup or a broken static-key setup, and this validator
 * cannot tell them apart without calling STS. It says so, and lets boot
 * proceed — the failure it used to prevent (an opaque SDK error on first
 * upload) is strictly less bad than refusing to boot a working deployment.
 *
 * Half a pair, however, is never right in either model.
 */
function checkAwsCredentials(
  env: NodeJS.ProcessEnv,
  role: AppRole,
  issues: EnvIssue[]
): void {
  const id = pick(env.AWS_ACCESS_KEY_ID);
  const secret = pick(env.AWS_SECRET_ACCESS_KEY);

  if (id && secret) return;

  if (id || secret) {
    issues.push({
      variable: id ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID",
      severity: "error",
      message:
        `${id ? "AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is not" : "AWS_SECRET_ACCESS_KEY is set but AWS_ACCESS_KEY_ID is not"} — ` +
        "half a credential pair authenticates nothing. Set both, or neither (and rely on the instance/task IAM role)",
    });
    return;
  }

  if (role === "worker") {
    issues.push({
      variable: "AWS_ACCESS_KEY_ID",
      severity: "warn",
      message:
        "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are unset — uploads will use the AWS SDK's " +
        "default credential chain (ECS task role / EC2 instance role). That is correct for an " +
        "IAM-role deployment; if this host has no role attached, every S3 upload fails with an " +
        "opaque SDK error. Verify with `aws sts get-caller-identity` inside the container",
    });
  }
}

function checkAws(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  issues: EnvIssue[]
): void {
  if (nodeEnv !== "production") return;

  if (!pick(env.AWS_REGION)) {
    issues.push({
      variable: "AWS_REGION",
      severity: "warn",
      message: `unset in production — falling back to the hard-coded default '${DEFAULT_AWS_REGION}'`,
    });
  }
  if (!pick(env.AWS_S3_BUCKET) && !pick(env.S3_BUCKET)) {
    issues.push({
      variable: "AWS_S3_BUCKET",
      severity: "warn",
      message: `unset in production — falling back to the hard-coded default bucket '${DEFAULT_AWS_S3_BUCKET}'`,
    });
  }
}

/**
 * Is anything that needs ENC_KEY actually turned on?
 *
 * ENC_KEY exists solely to encrypt stored Gmail OAuth tokens. Gmail is reachable
 * only when an OAuth client is configured; Workers/gmailPoll.queue.ts:132 then
 * additionally skips the cron when GMAIL_POLL_ENABLED === "false" (note: UNSET
 * means the poll RUNS, which is why the test is against the literal "false").
 */
function gmailEnabled(env: NodeJS.ProcessEnv): boolean {
  const oauthConfigured =
    !!pick(env.GOOGLE_OAUTH_CLIENT_ID) && !!pick(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const pollDisabled = (env.GMAIL_POLL_ENABLED ?? "").trim().toLowerCase() === "false";
  return oauthConfigured && !pollDisabled;
}

function checkEncKey(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  issues: EnvIssue[]
): void {
  const key = pick(env.ENC_KEY);

  if (!key) {
    if (nodeEnv === "production") {
      // Hard error ONLY when Gmail is actually wired up, i.e. when a decrypt
      // will genuinely happen. crypto.util.ts throws at the first decrypt and
      // nowhere else, so a prod install with no Google OAuth client (or with
      // the poll switched off) runs indefinitely without an ENC_KEY — refusing
      // to boot it would be a self-inflicted outage.
      const enabled = gmailEnabled(env);
      issues.push({
        variable: "ENC_KEY",
        severity: enabled ? "error" : "warn",
        message: enabled
          ? "required in production once Gmail is configured — GOOGLE_OAUTH_CLIENT_ID/SECRET are set " +
            "and the poll is not disabled, so stored OAuth tokens WILL be decrypted and crypto.util.ts " +
            "throws at the first one. Generate with `openssl rand -base64 32`"
          : "unset in production — Gmail token encrypt/decrypt would throw, but Gmail is not enabled " +
            "here (GOOGLE_OAUTH_CLIENT_ID/SECRET unset, or GMAIL_POLL_ENABLED=false), so boot proceeds. " +
            "Set it with `openssl rand -base64 32` BEFORE connecting a Gmail account",
      });
    }
    return;
  }

  const bytes = decodedKeyBytes(key);
  if (bytes !== 32) {
    // Never print the value — only its length, so logs stay safe to paste.
    issues.push({
      variable: "ENC_KEY",
      severity: "error",
      message:
        "ENC_KEY must decode to 32 bytes — generate with `openssl rand -base64 32` " +
        `(got ${bytes < 0 ? "an undecodable value" : `${bytes} bytes`} from a ${key.length}-char value)`,
    });
  }

  const prev = pick(env.ENC_KEY_PREVIOUS);
  if (prev) {
    const prevBytes = decodedKeyBytes(prev);
    if (prevBytes !== 32) {
      issues.push({
        variable: "ENC_KEY_PREVIOUS",
        severity: "error",
        message:
          "ENC_KEY_PREVIOUS must decode to 32 bytes — generate with `openssl rand -base64 32` " +
          `(got ${prevBytes < 0 ? "an undecodable value" : `${prevBytes} bytes`} from a ${prev.length}-char value)`,
      });
    }
  }
}

function checkAliases(env: NodeJS.ProcessEnv, issues: EnvIssue[]): void {
  for (const { legacy, canonical } of ALIAS_PAIRS) {
    const l = pick(env[legacy]);
    const c = pick(env[canonical]);
    if (l && !c) {
      // CLAUDE_API_KEY gets its own, more specific message in checkAnthropic.
      if (legacy === "CLAUDE_API_KEY") continue;
      issues.push({
        variable: legacy,
        severity: "warn",
        message: `legacy alias; prefer ${canonical}`,
      });
    } else if (l && c && l !== c) {
      issues.push({
        variable: legacy,
        severity: "warn",
        message:
          `both ${legacy} and ${canonical} are set to DIFFERENT values — the runtime reads ` +
          `${canonical} first, so ${legacy} is silently ignored. Remove one`,
      });
    }
  }
}

function checkMetrics(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  issues: EnvIssue[]
): void {
  if (nodeEnv === "production" && !pick(env.METRICS_TOKEN)) {
    issues.push({
      variable: "METRICS_TOKEN",
      severity: "warn",
      message: "unset in production — /metrics will return 503 (index.ts:312-315)",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Pure: never exits, never mutates process.env. This is what tests and the CLI use. */
export function collectEnvIssues(
  opts: ValidateEnvOptions = {}
): EnvValidationResult {
  const env = opts.env ?? process.env;
  const role = opts.role ?? detectRole(env);
  const issues: EnvIssue[] = [];

  // Whitespace is checked against the RAW values, before any trimming, or the
  // defect disappears before we can report it.
  checkWhitespace(env, issues);

  // Resolve the documented fallbacks exactly the way the runtime does, so the
  // schema sees what the services will see.
  const nodeEnv = (pick(env.NODE_ENV) ?? "development").toLowerCase();
  const input: Record<string, string | undefined> = {
    NODE_ENV: pick(env.NODE_ENV) ?? "development",
    PORT: pick(env.PORT) ?? DEFAULT_PORT,

    POSTGRES_HOST: pick(env.POSTGRES_HOST),
    POSTGRES_PORT: pick(env.POSTGRES_PORT),
    POSTGRES_USER: pick(env.POSTGRES_USER),
    POSTGRES_PASSWORD: pick(env.POSTGRES_PASSWORD),
    POSTGRES_DB: pick(env.POSTGRES_DB),
    POSTGRES_SSLMODE: pick(env.POSTGRES_SSLMODE),
    DB_SSL: pick(env.DB_SSL),

    ACCESS_TOKEN_SECRET: pick(env.ACCESS_TOKEN_SECRET),
    ACCESS_TOKEN_EXPIRY: pick(env.ACCESS_TOKEN_EXPIRY),
    REFRESH_TOKEN_EXPIRY_DAYS: pick(env.REFRESH_TOKEN_EXPIRY_DAYS),

    REDIS_URL: pick(env.REDIS_URL),
    // documentExtraction.service.ts:14 reads `CLAUDE_API_KEY || ANTHROPIC_API_KEY`,
    // so the legacy alias genuinely satisfies the requirement.
    ANTHROPIC_API_KEY: pick(env.ANTHROPIC_API_KEY) ?? pick(env.CLAUDE_API_KEY),

    AWS_REGION: pick(env.AWS_REGION) ?? DEFAULT_AWS_REGION,
    AWS_ACCESS_KEY_ID: pick(env.AWS_ACCESS_KEY_ID),
    AWS_SECRET_ACCESS_KEY: pick(env.AWS_SECRET_ACCESS_KEY),
    // preauthPdfFill/gmailSend/emailMatching all read `AWS_S3_BUCKET || S3_BUCKET`.
    AWS_S3_BUCKET:
      pick(env.AWS_S3_BUCKET) ?? pick(env.S3_BUCKET) ?? DEFAULT_AWS_S3_BUCKET,

    ENC_KEY: pick(env.ENC_KEY),
    CORS_ORIGIN: pick(env.CORS_ORIGIN),
    APP_BASE_URL: pick(env.APP_BASE_URL) ?? pick(env.FRONTEND_URL),
    METRICS_TOKEN: pick(env.METRICS_TOKEN),
  };

  const schema = role === "worker" ? workerSchema : apiSchema;
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? "");
      issues.push({ variable, message: issue.message, severity: "error" });
    }
  }

  checkRedis(env, role, nodeEnv, issues);
  checkAnthropic(env, issues);
  checkAwsCredentials(env, role, issues);
  checkAws(env, nodeEnv, issues);
  checkEncKey(env, nodeEnv, issues);
  checkAliases(env, issues);
  checkMetrics(env, nodeEnv, issues);

  const hasError = issues.some((i) => i.severity === "error");
  if (hasError || !parsed.success) {
    return { role, issues, value: null };
  }

  const value: ValidatedEnv = { role, ...parsed.data } as ValidatedEnv;
  return { role, issues, value };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the issue block. Shared by validateEnv() and scripts/check-env.ts so
 * an operator sees byte-identical output whether it came from a boot or a
 * pre-deploy check.
 */
export function formatEnvIssues(
  role: AppRole,
  issues: EnvIssue[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warn");
  const runWorkers = env.RUN_WORKERS === undefined ? "(unset)" : env.RUN_WORKERS;

  const lines: string[] = [];
  lines.push("");
  lines.push(
    errors.length > 0
      ? `❌ Environment validation failed — role: ${role}  (RUN_WORKERS=${runWorkers})`
      : `✅ Environment validated — role: ${role}  (RUN_WORKERS=${runWorkers})`
  );
  for (const e of errors) {
    lines.push(`   • ${e.variable ? `${e.variable}: ` : ""}${e.message}`);
  }
  for (const w of warnings) {
    lines.push(`   ⚠ ${w.variable ? `${w.variable}: ` : ""}${w.message}`);
  }
  if (errors.length > 0) {
    lines.push("");
    lines.push(
      "Fix the .env (or container env) and restart. Note: `docker compose restart` does NOT " +
        "reload env_file — use `docker compose up -d --force-recreate`."
    );
  }
  return lines.join("\n");
}

/**
 * Which optional capability groups are actually configured. Used by the
 * check-env CLI so an operator can see at a glance that (say) Gmail is off
 * because ENC_KEY is unset, rather than discovering it at the first poll.
 */
export function describeOptionalGroups(
  env: NodeJS.ProcessEnv = process.env
): Array<{ group: string; configured: boolean; detail: string }> {
  const encKey = pick(env.ENC_KEY);
  const googleOauth =
    !!pick(env.GOOGLE_OAUTH_CLIENT_ID) && !!pick(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const pollDisabled =
    (env.GMAIL_POLL_ENABLED ?? "").trim().toLowerCase() === "false";
  return [
    {
      group: "redis",
      configured: !!pick(env.REDIS_URL),
      detail: pick(env.REDIS_URL) ? "queues enabled" : "queues cannot enqueue or drain",
    },
    {
      group: "anthropic",
      configured: !!(pick(env.ANTHROPIC_API_KEY) ?? pick(env.CLAUDE_API_KEY)),
      detail: pick(env.ANTHROPIC_API_KEY)
        ? "ANTHROPIC_API_KEY"
        : pick(env.CLAUDE_API_KEY)
          ? "via legacy CLAUDE_API_KEY"
          : "AI extraction disabled",
    },
    {
      group: "s3",
      configured:
        !!pick(env.AWS_ACCESS_KEY_ID) && !!pick(env.AWS_SECRET_ACCESS_KEY),
      detail:
        `bucket ${pick(env.AWS_S3_BUCKET) ?? pick(env.S3_BUCKET) ?? DEFAULT_AWS_S3_BUCKET} @ ${pick(env.AWS_REGION) ?? DEFAULT_AWS_REGION}` +
        (pick(env.AWS_ACCESS_KEY_ID) && pick(env.AWS_SECRET_ACCESS_KEY)
          ? " (static keys)"
          : " (no static keys — SDK default chain / instance-task IAM role)"),
    },
    {
      group: "gmail+ENC_KEY",
      configured: !!encKey && googleOauth,
      detail: !encKey
        ? googleOauth && !pollDisabled
          ? "ENC_KEY unset while Gmail IS enabled — the first token decrypt will throw"
          : "ENC_KEY unset (Gmail not enabled here, so nothing decrypts yet)"
        : googleOauth
          ? pollDisabled
            ? "ready — poll disabled via GMAIL_POLL_ENABLED=false"
            : pick(env.ENC_KEY_PREVIOUS)
              ? "ENC_KEY_PREVIOUS set — key rotation in progress"
              : "ready"
          : "GOOGLE_OAUTH_CLIENT_ID/SECRET unset",
    },
    {
      group: "metrics",
      configured: !!pick(env.METRICS_TOKEN),
      detail: pick(env.METRICS_TOKEN) ? "/metrics authenticated" : "/metrics returns 503",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boot guard. Prints role + ALL issues, then process.exit(1) on any error
 * (or throws EnvValidationError when exitOnError === false).
 */
export function validateEnv(opts: ValidateEnvOptions = {}): ValidatedEnv {
  const env = opts.env ?? process.env;
  const exitOnError = opts.exitOnError !== false;
  const applyNormalisation = opts.applyNormalisation !== false;

  const result = collectEnvIssues({ role: opts.role, env });
  const errors = result.issues.filter((i) => i.severity === "error");

  if (errors.length > 0 || result.value === null) {
    // eslint-disable-next-line no-console
    console.error(formatEnvIssues(result.role, result.issues, env));
    if (!exitOnError) {
      throw new EnvValidationError(result.issues);
    }
    // eslint-disable-next-line no-console
    console.error("Aborting boot.\n");
    process.exit(1);
  }

  // Warnings are surfaced but never abort boot.
  for (const w of result.issues) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠ env: ${w.variable ? `${w.variable}: ` : ""}${w.message}`
    );
  }

  if (applyNormalisation && env === process.env) {
    // Normalise NODE_ENV back into process.env so downstream comparisons like
    // `process.env.NODE_ENV === 'production'` work even when the .env had
    // `Production` / `PRODUCTION` / mixed case, and write every trimmed value
    // back so the scattered defensive `.trim()` calls (s3.service.ts:23-29)
    // become redundant rather than load-bearing.
    process.env.NODE_ENV = result.value.NODE_ENV;
    for (const name of WHITESPACE_SENSITIVE) {
      const raw = process.env[name];
      if (raw !== undefined) process.env[name] = raw.trim();
    }
    // documentExtraction.service.ts reads CLAUDE_API_KEY first, but everything
    // written since prefers ANTHROPIC_API_KEY. Mirror the legacy value forward
    // so both spellings resolve.
    if (!pick(process.env.ANTHROPIC_API_KEY) && result.value.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = result.value.ANTHROPIC_API_KEY;
    }
    if (pick(process.env.ENC_KEY_PREVIOUS)) {
      // eslint-disable-next-line no-console
      console.info(
        "ℹ env: ENC_KEY_PREVIOUS is set — ENC_KEY rotation is in progress (decrypt falls back to the previous key)."
      );
    }
  }

  return result.value;
}
