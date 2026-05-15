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
import masterOptionsRouter from "./Routes/masterOptions.routes.js"
import doctorRouter from "./Routes/doctor.routes.js"

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

    // Hospital Router with catch-all routes (more general, goes last)
    app.use("/api/v1/hospitals",hospitalRouter);

    // V2 API Routes (S3 Storage)
    app.use("/api/v2/uploads",uploadsRouterV2);

    // Start Server
    app.listen(port, () => {
      logger.info({ port, environment: serviceInfo.environment }, `Server running on :${port}`);

      // Run startup tasks
      StartupService.recoverDriveBackups();
    });
  })
  .catch((error) => {
    logger.error({ err: error }, "Error connecting to Database");
    process.exit(1);
  });
