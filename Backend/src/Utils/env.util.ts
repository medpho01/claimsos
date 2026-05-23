/**
 * Environment-variable validation at boot.
 *
 * Backend review C9 — several middlewares use `process.env.ACCESS_TOKEN_SECRET!`
 * (non-null assertion) and DB code does `parseInt(process.env.POSTGRES_PORT || " ")`
 * which silently produces NaN. The result is that a misconfigured deploy boots
 * "successfully" and then explodes at request time with cryptic errors (or
 * worse: jwt.verify accepts unsigned tokens when the secret is empty).
 *
 * This module validates the required env vars exactly once at boot. If
 * anything critical is missing it logs the problem and exits non-zero so
 * the deploy is visibly broken instead of subtly broken.
 *
 * Optional vars (S3, Drive, Redis, CloudFront) are intentionally NOT
 * required — they should degrade gracefully when missing.
 */
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().regex(/^\d+$/, "must be a port number").optional(),
  // Accept any case (`Production`, `PRODUCTION`, `production`) — older
  // deployments wrote `NODE_ENV=Production` and we don't want validation to
  // hard-stop boot over a casing nit. We lowercase + normalise downstream.
  NODE_ENV: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(["development", "production", "test"]))
    .optional(),

  // Database — required
  POSTGRES_HOST: z.string().min(1, "POSTGRES_HOST is required"),
  POSTGRES_PORT: z.string().regex(/^\d+$/, "POSTGRES_PORT must be a port number"),
  POSTGRES_USER: z.string().min(1, "POSTGRES_USER is required"),
  POSTGRES_PASSWORD: z.string().min(1, "POSTGRES_PASSWORD is required"),
  POSTGRES_DB: z.string().min(1, "POSTGRES_DB is required"),

  // Auth — required, real values (no empty strings)
  ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, "ACCESS_TOKEN_SECRET must be at least 32 chars — short secrets defeat jwt.verify"),
  ACCESS_TOKEN_EXPIRY: z.string().min(1, "ACCESS_TOKEN_EXPIRY is required"),
  REFRESH_TOKEN_EXPIRY_DAYS: z
    .string()
    .regex(/^\d+$/, "REFRESH_TOKEN_EXPIRY_DAYS must be an integer"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print a readable summary then exit
    // eslint-disable-next-line no-console
    console.error("\n❌ Environment-variable validation failed:");
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      // eslint-disable-next-line no-console
      console.error(`   • ${path}: ${issue.message}`);
    }
    // eslint-disable-next-line no-console
    console.error(
      "\nFix the .env (or container env) and restart. Aborting boot.\n"
    );
    process.exit(1);
  }
  // Normalise NODE_ENV back into process.env so downstream comparisons like
  // `process.env.NODE_ENV === 'production'` work even when the .env had
  // `Production` / `PRODUCTION` / mixed case.
  if (parsed.data.NODE_ENV) {
    process.env.NODE_ENV = parsed.data.NODE_ENV;
  }
  return parsed.data;
}
