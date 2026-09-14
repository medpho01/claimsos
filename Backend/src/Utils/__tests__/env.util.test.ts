/**
 * Env validation tests.
 *
 * Run: npx tsx --test src/Utils/__tests__/env.util.test.ts
 *
 * These exist because of a specific miss: the "no boot regression" claim for
 * the role-aware validator was checked only against a NODE_ENV=development
 * .env, so none of the PRODUCTION-only hard errors were ever exercised — and
 * two of them (static AWS keys, ENC_KEY) would have refused to boot a
 * deployment that works today. Every case below therefore pins a SEVERITY, not
 * just "an issue was raised": the difference between `warn` and `error` is the
 * difference between a log line and an outage.
 *
 * collectEnvIssues is pure — it takes the environment as an argument and never
 * reads or writes process.env — so these run in-process with no fixtures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectEnvIssues, detectRole, type EnvIssue } from '../env.util.js';

// ── fixtures ────────────────────────────────────────────────────────────

/** A complete, production-shaped, all-dummy config for the strictest role. */
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: '8000',
    POSTGRES_HOST: 'db.internal',
    POSTGRES_PORT: '5432',
    POSTGRES_USER: 'claimsos',
    POSTGRES_PASSWORD: 'dummy-password',
    POSTGRES_DB: 'claimsos',
    ACCESS_TOKEN_SECRET: 'x'.repeat(48),
    ACCESS_TOKEN_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY_DAYS: '30',
    REDIS_URL: 'redis://redis:6379',
    ANTHROPIC_API_KEY: 'sk-ant-dummy',
    AWS_REGION: 'ap-south-1',
    AWS_S3_BUCKET: 'dummy-bucket',
    AWS_ACCESS_KEY_ID: 'AKIADUMMY',
    AWS_SECRET_ACCESS_KEY: 'dummy-secret',
    // 32 zero bytes, base64 — decodes to exactly 32 bytes.
    ENC_KEY: Buffer.alloc(32).toString('base64'),
    METRICS_TOKEN: 'dummy-metrics-token',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env as NodeJS.ProcessEnv;
}

const errorsFor = (issues: EnvIssue[], variable: string) =>
  issues.filter((i) => i.variable === variable && i.severity === 'error');
const warningsFor = (issues: EnvIssue[], variable: string) =>
  issues.filter((i) => i.variable === variable && i.severity === 'warn');

// ── role detection ──────────────────────────────────────────────────────

describe('detectRole', () => {
  it('treats UNSET RUN_WORKERS as the worker role, matching the runtime', () => {
    assert.equal(detectRole({} as NodeJS.ProcessEnv), 'worker');
    assert.equal(detectRole({ RUN_WORKERS: ' FALSE ' } as NodeJS.ProcessEnv), 'api');
    assert.equal(detectRole({ RUN_WORKERS: 'true' } as NodeJS.ProcessEnv), 'worker');
  });
});

// ── the baseline still passes ───────────────────────────────────────────

describe('a complete production config', () => {
  it('validates clean for both roles', () => {
    for (const role of ['api', 'worker'] as const) {
      const { issues, value } = collectEnvIssues({ role, env: baseEnv() });
      assert.deepEqual(
        issues.filter((i) => i.severity === 'error'),
        [],
        `${role}: expected no errors`
      );
      assert.ok(value, `${role}: expected a validated value`);
    }
  });
});

// ── AWS credentials: IAM roles must boot ────────────────────────────────

describe('AWS credentials', () => {
  it('WARNS (never errors) when both keys are absent on the worker role', () => {
    // s3.service.ts defaults both to '' precisely so the SDK falls through to
    // the ECS task / EC2 instance role. Erroring here exits(1) a deployment
    // that works.
    const env = baseEnv({
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    });
    const { issues, value } = collectEnvIssues({ role: 'worker', env });

    assert.deepEqual(errorsFor(issues, 'AWS_ACCESS_KEY_ID'), []);
    assert.deepEqual(errorsFor(issues, 'AWS_SECRET_ACCESS_KEY'), []);
    assert.equal(warningsFor(issues, 'AWS_ACCESS_KEY_ID').length, 1);
    assert.match(
      warningsFor(issues, 'AWS_ACCESS_KEY_ID')[0].message,
      /IAM|credential chain/i
    );
    assert.ok(value, 'boot must proceed on an IAM-role deployment');
  });

  it('stays silent about absent keys on the api role', () => {
    const env = baseEnv({
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    });
    const { issues } = collectEnvIssues({ role: 'api', env });
    assert.deepEqual(warningsFor(issues, 'AWS_ACCESS_KEY_ID'), []);
  });

  it('ERRORS on half a credential pair, which is wrong under either model', () => {
    const idOnly = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ AWS_SECRET_ACCESS_KEY: undefined }),
    });
    assert.equal(errorsFor(idOnly.issues, 'AWS_SECRET_ACCESS_KEY').length, 1);
    assert.equal(idOnly.value, null);

    const secretOnly = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ AWS_ACCESS_KEY_ID: undefined }),
    });
    assert.equal(errorsFor(secretOnly.issues, 'AWS_ACCESS_KEY_ID').length, 1);
    assert.equal(secretOnly.value, null);
  });
});

// ── ENC_KEY: only an error when Gmail can actually decrypt ──────────────

describe('ENC_KEY in production', () => {
  const gmailOn = {
    GOOGLE_OAUTH_CLIENT_ID: 'dummy-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'dummy-client-secret',
  };

  it('WARNS when unset and Gmail is not configured', () => {
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ ENC_KEY: undefined }),
    });
    assert.deepEqual(errorsFor(issues, 'ENC_KEY'), []);
    assert.equal(warningsFor(issues, 'ENC_KEY').length, 1);
    assert.ok(value);
  });

  it('WARNS when unset and the Gmail poll is explicitly disabled', () => {
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({
        ENC_KEY: undefined,
        ...gmailOn,
        GMAIL_POLL_ENABLED: 'false',
      }),
    });
    assert.deepEqual(errorsFor(issues, 'ENC_KEY'), []);
    assert.equal(warningsFor(issues, 'ENC_KEY').length, 1);
    assert.ok(value);
  });

  it('ERRORS when unset and Gmail IS enabled — a decrypt will really happen', () => {
    // GMAIL_POLL_ENABLED unset means the poll RUNS (gmailPoll.queue.ts:132
    // tests for the literal "false"), so this is the default Gmail install.
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ ENC_KEY: undefined, ...gmailOn }),
    });
    assert.equal(errorsFor(issues, 'ENC_KEY').length, 1);
    assert.equal(value, null);
  });

  it('is not required outside production', () => {
    const { issues } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ NODE_ENV: 'development', ENC_KEY: undefined, ...gmailOn }),
    });
    assert.deepEqual(issues.filter((i) => i.variable === 'ENC_KEY'), []);
  });

  it('still ERRORS on a MALFORMED key — absent can work, wrong cannot', () => {
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ ENC_KEY: 'too-short' }),
    });
    assert.equal(errorsFor(issues, 'ENC_KEY').length, 1);
    assert.match(errorsFor(issues, 'ENC_KEY')[0].message, /32 bytes/);
    assert.equal(value, null);

    const prev = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ ENC_KEY_PREVIOUS: 'also-too-short' }),
    });
    assert.equal(errorsFor(prev.issues, 'ENC_KEY_PREVIOUS').length, 1);
  });
});

// ── the hard errors that must NOT have been softened ────────────────────

describe('hard errors still hold', () => {
  it('rejects a worker with no REDIS_URL and no ANTHROPIC_API_KEY', () => {
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ REDIS_URL: undefined, ANTHROPIC_API_KEY: undefined }),
    });
    assert.equal(errorsFor(issues, 'REDIS_URL').length, 1);
    assert.equal(errorsFor(issues, 'ANTHROPIC_API_KEY').length, 1);
    assert.equal(value, null);
  });

  it('rejects localhost Redis in production', () => {
    const { issues } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ REDIS_URL: 'redis://localhost:6379' }),
    });
    assert.equal(errorsFor(issues, 'REDIS_URL').length, 1);
  });

  it('rejects a short ACCESS_TOKEN_SECRET and missing Postgres settings', () => {
    const { issues, value } = collectEnvIssues({
      role: 'api',
      env: baseEnv({ ACCESS_TOKEN_SECRET: 'short', POSTGRES_HOST: undefined }),
    });
    assert.equal(errorsFor(issues, 'ACCESS_TOKEN_SECRET').length, 1);
    assert.equal(errorsFor(issues, 'POSTGRES_HOST').length, 1);
    assert.equal(value, null);
  });

  it('rejects a value carrying leading/trailing whitespace', () => {
    const { issues, value } = collectEnvIssues({
      role: 'worker',
      env: baseEnv({ REDIS_URL: 'redis://redis:6379 ' }),
    });
    assert.equal(errorsFor(issues, 'REDIS_URL').length, 1);
    assert.equal(value, null);
  });
});
