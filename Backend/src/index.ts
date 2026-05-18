import "dotenv/config";
import { validateEnv } from "./Utils/env.util.js";
import { installRedisOfflineFilter } from "./Utils/redisOfflineFilter.js";

// Validate critical env vars at boot. Fail loudly here rather than silently
// later when jwt.verify accepts unsigned tokens or POSTGRES_PORT is NaN.
validateEnv();

// Prod-readiness #3: install once at the process level so all four Bull
// queues (notification / pdfGeneration / sheetSync / driveBackup) share a
// single unhandledRejection filter that swallows the multiple ioredis
// offline-error variants instead of just ECONNREFUSED.
installRedisOfflineFilter();

import app from "./app.js";
import { connectDB } from "./DB/db.js";
import os, { version } from "os";
import process from "process";
import client from "prom-client";
import pinoHttp from "pino-http";
import { nanoid } from "nanoid";
import { logger } from "./Utils/logger.js";

// Routers
import authRouter from "./Routes/auth.routes.js"
import patientRouter from "./Routes/patient.routes.js"
import userRouter from "./Routes/user.routes.js"
import uploadRouter from "./Routes/uploads.routes.js"
import adminRouter from "./Routes/admin.routes.js"
import auditRouter from "./Routes/audit.routes.js"
import hospitalRouter from "./Routes/hospital.routes.js"
import claimRouter from "./Routes/claim.routes.js"
import hospitalDocsRouter from "./Routes/hospitalDocs.routes.js"
import uploadsRouterV2 from "./Routes/v2/uploads.routes.js"
import doctorsRouter from "./Routes/doctors.routes.js"
import hospitalProfileRouter from "./Routes/hospitalProfile.routes.js"
import panelAttributeRouter from "./Routes/panelAttribute.routes.js"
import attributeDefinitionRouter from "./Routes/attributeDefinition.routes.js"
import panelAttributeDefinitionRouter from "./Routes/panelAttributeDefinition.routes.js"
import gmailAuthRouter from "./Routes/gmailAuth.routes.js"
import insuranceSubmissionRouter from "./Routes/insuranceSubmission.routes.js"
import gmailInboundRouter from "./Routes/gmailInbound.routes.js"
import emailInboxRouter from "./Routes/emailInbox.routes.js"
import masterOptionsRouter from "./Routes/masterOptions.routes.js"
import doctorRouter from "./Routes/doctor.routes.js"

// Intelligence Layer (Waves 1-5) — see docs/intelligence/ontology.md
import claimDossierRouter from "./Routes/claimDossier.routes.js"
import aiDraftsRouter from "./Routes/aiDrafts.routes.js"
import stageRequirementsRouter from "./Routes/stageRequirements.routes.js"
import adjudicationRouter from "./Routes/adjudication.routes.js"
import claimActionsRouter from "./Routes/claimActions.routes.js"
import kbPatternsRouter from "./Routes/kbPatterns.routes.js"
import episodicMemoryRouter from "./Routes/episodicMemory.routes.js"
import evalRouter from "./Routes/eval.routes.js"
import intelligenceRouter from "./Routes/intelligence.routes.js"

// Initialize background workers
import './Workers/driveBackup.queue.js'
import './Workers/notification.queue.js'
import StartupService from './Services/startup.service.js'

const port = process.env.PORT || 8000;

// Service metadata
const serviceInfo = {
  name: "24eleven-backend",
  version: process.env.npm_package_version || "1.0.0",
  environment: process.env.NODE_ENV || "development",
};

let dbConnected = false;

// Prometheus Metrics Setup
const collectDefaultMetrics = client.collectDefaultMetrics;
// Create registry
const registry = new client.Registry();

// Add default metrics
// client.collectDefaultMetrics({ register: registry });
collectDefaultMetrics({ prefix: "app_24eleven_" });

const httpRequestDurationMicroseconds = new client.Histogram({
  name: "app_24eleven_http_requests_total",
  help: "Duration of HTTP requests in microseconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});

// Request-id + structured access logging (M2/L5).
// Generates a short id per request, exposes it as `X-Request-Id`, and pipes
// every access log line through pino (with PII redacted via Utils/logger).
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id =
        (Array.isArray(incoming) ? incoming[0] : incoming) || nanoid(12);
      res.setHeader("X-Request-Id", id);
      return id;
    },
    // Health endpoints are noisy; log them at debug only.
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      if (req.url === "/health/live" || req.url === "/health/ready" || req.url === "/metrics") {
        return "debug";
      }
      return "info";
    },
    // Trim verbose serializer output — we only want method/url/status here.
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// Middleware to track requests
app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.route?.path || req.path, code: res.statusCode });
  });
  next();
});

// Database + Server
connectDB()
  .then(() => {
    dbConnected = true;

    // Root route
    app.get("/", (_req, res) => {
      res.send({
        message: "Welcome to the 24Eleven Hospital Backend API",
      });
    });

    // Basic liveness probe
    app.get("/health/live", (req, res) => {
      res.status(200).json({
        status: "UP",
        service: serviceInfo.name,
        timestamp: new Date().toISOString(),
      });
    });

    // Readiness probe (checks DB)
    app.get("/health/ready", async (req, res) => {
      const status = dbConnected ? "UP" : "DOWN";

      res.status(dbConnected ? 200 : 503).json({
        status,
        dependencies: {
          database: dbConnected ? "Connected" : "Not Connected",
        },
        timestamp: new Date().toISOString(),
      });
    });

    /**
     * Worker health endpoint (S4).
     *   - On the worker container (RUN_WORKERS!=false): reports queue depths
     *     for gmail-poll + email-outbox, the last poll across all hospitals,
     *     and the last successful send.
     *   - On the API container (RUN_WORKERS=false): reports {workers_enabled:
     *     false} so monitors can tell who's responsible.
     */
    app.get("/health/worker", async (_req, res) => {
      const workersEnabled = process.env.RUN_WORKERS !== "false";
      if (!workersEnabled) {
        return res.status(200).json({
          status: "API_ONLY",
          workers_enabled: false,
          note: "Workers run in a separate container (RUN_WORKERS=false here).",
        });
      }
      try {
        // Dynamic imports so this code only loads the queue modules when
        // workers are actually enabled.
        const [outboxMod, gmailPollMod, { pool }] = await Promise.all([
          import("./Workers/emailOutbox.queue.js"),
          import("./Workers/gmailPoll.queue.js").catch(() => null),
          import("./DB/db.js"),
        ]);
        const outboxQueue: any = outboxMod.default;
        const gmailPollQueue: any = (gmailPollMod as any)?.default;

        // Queue depths (best-effort; some methods return 0 on stub queues)
        const safeCount = async (q: any, m: string) => {
          try { return typeof q?.[m] === "function" ? await q[m]() : 0; }
          catch { return -1; }
        };
        const outboxDepth = {
          waiting:   await safeCount(outboxQueue, "getWaitingCount"),
          active:    await safeCount(outboxQueue, "getActiveCount"),
          delayed:   await safeCount(outboxQueue, "getDelayedCount"),
          failed:    await safeCount(outboxQueue, "getFailedCount"),
        };
        const pollDepth = {
          waiting:   await safeCount(gmailPollQueue, "getWaitingCount"),
          active:    await safeCount(gmailPollQueue, "getActiveCount"),
          delayed:   await safeCount(gmailPollQueue, "getDelayedCount"),
          failed:    await safeCount(gmailPollQueue, "getFailedCount"),
        };

        // DB-derived liveness signals — survive worker restarts.
        const lastPoll = await pool.query<{
          hospital_id: string; last_polled_at: string | null; status: string;
        }>(
          `SELECT hospital_id, last_polled_at::text AS last_polled_at, status
             FROM hospital.hospital_interfaces
            WHERE kind = 'email'
            ORDER BY last_polled_at DESC NULLS LAST
            LIMIT 5`
        );
        const lastSend = await pool.query<{ sent_at: string | null }>(
          `SELECT MAX(sent_at)::text AS sent_at FROM hospital.emails_outbound`
        );
        const outboxStuck = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM hospital.emails_outbound
            WHERE status = 'queued' AND queued_at < NOW() - INTERVAL '2 minutes'`
        );
        const sendingStuck = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM hospital.emails_outbound
            WHERE status = 'sending' AND queued_at < NOW() - INTERVAL '5 minutes'`
        );

        res.status(200).json({
          status: "UP",
          workers_enabled: true,
          queues: { email_outbox: outboxDepth, gmail_poll: pollDepth },
          last_poll_per_hospital: lastPoll.rows,
          last_send_at: lastSend.rows[0]?.sent_at ?? null,
          stuck_rows: {
            outbox_queued_over_2min: outboxStuck.rows[0]?.n ?? 0,
            outbox_sending_over_5min: sendingStuck.rows[0]?.n ?? 0,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        res.status(500).json({
          status: "ERROR",
          workers_enabled: true,
          error: err?.message ?? "unknown",
        });
      }
    });

    // Full system health (for dashboards)
    app.get("/api/v1/health", async (req, res) => {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();

      res.status(200).json({
        message: "Server is Up and Running!",
        service: serviceInfo.name,
        version: serviceInfo.version,
        environment: serviceInfo.environment,
        database: dbConnected ? "Connected" : "Not Connected",
        uptime: `${process.uptime().toFixed(2)}s`,
        memory: {
          rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
          heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        },
        cpu: {
          user: `${(cpuUsage.user / 1000).toFixed(2)} ms`,
          system: `${(cpuUsage.system / 1000).toFixed(2)} ms`,
        },
        host: {
          hostname: os.hostname(),
          platform: os.platform(),
          uptime: `${(os.uptime() / 60).toFixed(1)} min`,
        },
        timestamp: new Date().toISOString(),
      });
    });

    // Prometheus metrics endpoint
    // Sprint 1A: lock with a shared secret. Was completely open — anyone on
    // the network could scrape internal histogram + process metrics, which
    // is a recon goldmine (uptime, route names, latency, request volume).
    // Configure METRICS_TOKEN in the env and have Prometheus scrape with
    // `bearer_token: <token>` in its scrape config. If METRICS_TOKEN is
    // unset we deny by default rather than silently allowing.
    app.get("/metrics", async (req, res) => {
      try {
        const expected = process.env.METRICS_TOKEN;
        if (!expected) {
          res.status(503).json({ error: "Metrics disabled (METRICS_TOKEN not configured)" });
          return;
        }
        const header = req.headers.authorization || "";
        const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (presented !== expected) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        res.set("Content-Type", client.register.contentType);
        res.end(await client.register.metrics());
      } catch (err) {
        res.status(500).json({ error: "Failed to collect metrics" });
      }
    });

    app.get("/api/v1/version",async (req,res)=>{
      try{
        res.status(200).json({
          version:process.env.APP_VERSION
        })
      }catch(err){
        res.status(500).json({
          error:"Failed to get version"
        })
      }
    })

    //Routers
    app.use("/api/v1/auth",authRouter);
    app.use("/api/v1/patient",patientRouter);
    app.use("/api/v1/user",userRouter);
    app.use("/api/v1/uploads",uploadRouter);
    app.use("/api/v1/admin",adminRouter);
    app.use("/api/v1/audit-logs",auditRouter);
    app.use("/api/v1/hospital-docs",hospitalDocsRouter);
    app.use("/api/v1/claims",claimRouter);

    // Hospital Profile API Routes (Hospital Profile Management) - MUST come before hospitalRouter
    // because hospitalRouter has catch-all /:hospitalId route
    app.use("/api/v1",hospitalProfileRouter);

    // Panel Attributes API Routes (Panel Attributes & Documents Management)
    app.use("/api/v1",panelAttributeRouter);
    app.use("/api/v1",gmailAuthRouter);
    app.use("/api/v1",insuranceSubmissionRouter);
    app.use("/api/v1",gmailInboundRouter);
    app.use("/api/v1",emailInboxRouter);

    // Attribute Definitions API Routes (Hospital & Panel Attribute Definitions Management)
    app.use("/api/v1", attributeDefinitionRouter);
    app.use("/api/v1", panelAttributeDefinitionRouter);

    // Master Options API Routes (Generic Dropdown/Select Field Management)
    app.use("/api/v1/master-options", masterOptionsRouter);

    // Doctor Configuration API Routes (Doctor Management, Attributes, Definitions)
    // Contains routes with different base paths:
    // - /register, /me, /search, /:doctorId/* for individual doctor endpoints
    // - /hospitals/:hospitalId/doctors* for hospital-doctor relationship endpoints
    // - /admin/doctor-attributes/* for attribute definition endpoints
    // - /public/* for public endpoints
    // Mount at /api/v1 so all these routes work correctly
    app.use("/api/v1", doctorRouter);

    // ─── Intelligence Layer (Waves 1-5) ──────────────────────────────
    // ClaimDossier — per-claim case file (Wave 1)
    app.use("/api/v1", claimDossierRouter);
    // AI Drafts — email intelligence review surface (Wave 2)
    app.use("/api/v1", aiDraftsRouter);
    // Stage Requirements — deterministic rules engine config (Wave 3A)
    app.use("/api/v1", stageRequirementsRouter);
    // Adjudication — readiness reports per claim (Wave 3B)
    app.use("/api/v1", adjudicationRouter);
    // Claim Actions — WhatsApp / in-app dispatch queue (Wave 3C)
    app.use("/api/v1", claimActionsRouter);
    // KB Patterns — mined patterns + admin review (Wave 4A)
    app.use("/api/v1", kbPatternsRouter);
    // Episodic Memory — similar past cases lookup (Wave 4B)
    app.use("/api/v1", episodicMemoryRouter);
    // Eval Harness — prediction accuracy metrics (Wave 5A)
    app.use("/api/v1/eval", evalRouter);
    // Intelligence orchestrator — operator-triggered "analyze this claim"
    app.use("/api/v1", intelligenceRouter);

    // Hospital Router with catch-all routes (more general, goes last)
    app.use("/api/v1/hospitals",hospitalRouter);

    // V2 API Routes (S3 Storage)
    app.use("/api/v2/uploads",uploadsRouterV2);

    // Start Server
    app.listen(port, () => {
      logger.info({ port, environment: serviceInfo.environment }, `Server running on :${port}`);

      // Run startup tasks
      StartupService.recoverDriveBackups();

      // Cashless Everywhere: schedule Gmail polling cron (replaces Pub/Sub).
      // Best-effort; if Redis isn't available the helper logs and continues.
      import("./Workers/gmailPoll.queue.js")
        .then(({ startGmailPollCron }) => startGmailPollCron())
        .catch((err) => logger.warn({ err }, "gmailPoll cron startup skipped"));

      // Cashless Everywhere: load the email outbox worker module at startup
      // so its setInterval poll (rescues stuck/stranded outbound rows) starts
      // firing immediately. Previously this module was only loaded via
      // dynamic imports from preauthSubmission.send() — meaning a freshly
      // restarted backend had no outbox poll until the first send request
      // triggered the import. A row queued before that first import would
      // sit forever. Importing here makes the poll always-on.
      import("./Workers/emailOutbox.queue.js")
        .then(() => logger.info("emailOutbox worker loaded"))
        .catch((err) => logger.warn({ err }, "emailOutbox worker startup skipped"));

      // Inbound notification worker (A8): wraps WhatsApp dispatch in a Bull
      // queue with retry. Static-import for the same reason as above —
      // workers should be alive on boot, not lazy-loaded by the first call.
      import("./Workers/inboundNotification.queue.js")
        .then(() => logger.info("inboundNotification worker loaded"))
        .catch((err) => logger.warn({ err }, "inboundNotification worker startup skipped"));

      // ─── Intelligence Layer Workers (Waves 1-5) ──────────────────
      // All workers self-gate via RUN_WORKERS env var; on the API
      // container (RUN_WORKERS=false) they no-op at module load. On the
      // worker container they register Bull processors + cron schedules.
      // Each import is best-effort with a warn-log fallback so a single
      // worker failure doesn't crash boot.

      // Wave 1 — ClaimDossier projector (subscribes to event firehose)
      import("./Workers/claimDossierProjector.queue.js")
        .then(() => logger.info("claimDossierProjector worker loaded"))
        .catch((err) => logger.warn({ err }, "claimDossierProjector worker startup skipped"));

      // Wave 2 — Document intelligence pipeline
      import("./Workers/docSegmenter.queue.js")
        .then(() => logger.info("docSegmenter worker loaded"))
        .catch((err) => logger.warn({ err }, "docSegmenter worker startup skipped"));
      import("./Workers/docClassifier.queue.js")
        .then(() => logger.info("docClassifier worker loaded"))
        .catch((err) => logger.warn({ err }, "docClassifier worker startup skipped"));
      import("./Workers/docExtractor.queue.js")
        .then(() => logger.info("docExtractor worker loaded"))
        .catch((err) => logger.warn({ err }, "docExtractor worker startup skipped"));

      // Wave 2 — Email intelligence
      import("./Workers/emailIntelligence.queue.js")
        .then(() => logger.info("emailIntelligence worker loaded"))
        .catch((err) => logger.warn({ err }, "emailIntelligence worker startup skipped"));

      // Wave 3 — Adjudication + Action engine
      import("./Workers/adjudicationEngine.queue.js")
        .then(() => logger.info("adjudicationEngine worker loaded"))
        .catch((err) => logger.warn({ err }, "adjudicationEngine worker startup skipped"));
      import("./Workers/adjudicationTriggerFromDossier.js")
        .then((mod: any) => {
          if (typeof mod.startAdjudicationTriggerFromDossier === "function") {
            mod.startAdjudicationTriggerFromDossier();
            logger.info("adjudicationTriggerFromDossier listener started");
          }
        })
        .catch((err) => logger.warn({ err }, "adjudicationTriggerFromDossier startup skipped"));
      import("./Workers/actionEngine.queue.js")
        .then(() => logger.info("actionEngine workers loaded"))
        .catch((err) => logger.warn({ err }, "actionEngine workers startup skipped"));

      // Wave 4 — KB pattern feedback + Episodic embedder + crons
      import("./Workers/kbPatternFeedback.queue.js")
        .then(() => logger.info("kbPatternFeedback worker loaded"))
        .catch((err) => logger.warn({ err }, "kbPatternFeedback worker startup skipped"));
      import("./Workers/kbPatternMiner.cron.js")
        .then((mod: any) => {
          if (typeof mod.startKbPatternMinerWorker === "function") mod.startKbPatternMinerWorker();
          if (typeof mod.scheduleKbPatternMiner === "function") mod.scheduleKbPatternMiner();
          logger.info("kbPatternMiner cron scheduled");
        })
        .catch((err) => logger.warn({ err }, "kbPatternMiner cron startup skipped"));
      import("./Workers/caseEmbedder.queue.js")
        .then(() => logger.info("caseEmbedder worker loaded"))
        .catch((err) => logger.warn({ err }, "caseEmbedder worker startup skipped"));
      import("./Workers/episodicMemoryBackfill.cron.js")
        .then((mod: any) => {
          if (typeof mod.startEpisodicMemoryBackfill === "function") mod.startEpisodicMemoryBackfill();
          if (typeof mod.scheduleEpisodicMemoryBackfill === "function") mod.scheduleEpisodicMemoryBackfill();
          logger.info("episodicMemoryBackfill cron scheduled");
        })
        .catch((err) => logger.warn({ err }, "episodicMemoryBackfill cron startup skipped"));

      // Wave 5 — Eval harness cron + triggers
      import("./Workers/evalHarness.cron.js")
        .then((mod: any) => {
          if (typeof mod.startEvalHarnessCron === "function") mod.startEvalHarnessCron();
          if (typeof mod.scheduleEvalHarnessCron === "function") mod.scheduleEvalHarnessCron();
          logger.info("evalHarness cron scheduled");
        })
        .catch((err) => logger.warn({ err }, "evalHarness cron startup skipped"));
      import("./Workers/evalHarnessTriggers.js")
        .then((mod: any) => {
          if (typeof mod.startEvalHarnessTriggers === "function") {
            mod.startEvalHarnessTriggers();
            logger.info("evalHarness triggers started");
          }
        })
        .catch((err) => logger.warn({ err }, "evalHarnessTriggers startup skipped"));
    });
  })
  .catch((error) => {
    logger.error({ err: error }, "Error connecting to Database");
    process.exit(1);
  });
