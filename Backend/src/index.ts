import app from "./app.js";
import { connectDB } from "./DB/db.js";
import "dotenv/config";
import os, { version } from "os";
import process from "process";
import client from "prom-client";

// Routers
import authRouter from "./Routes/auth.routes.js"
import patientRouter from "./Routes/patient.routes.js"
import userRouter from "./Routes/user.routes.js"
import uploadRouter from "./Routes/uploads.routes.js"
import adminRouter from "./Routes/admin.routes.js"
import auditRouter from "./Routes/audit.routes.js"
import hospitalRouter from "./Routes/hospital.routes.js"
import claimRouter from "./Routes/claim.routes.js"
import uploadsRouterV2 from "./Routes/v2/uploads.routes.js"

// Initialize background workers
import './Workers/driveBackup.queue.js'

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
    app.get("/metrics", async (req, res) => {
      try {
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
    app.use("/api/v1/hospitals",hospitalRouter);
    app.use("/api/v1/claims",claimRouter);

    // V2 API Routes (S3 Storage)
    app.use("/api/v2/uploads",uploadsRouterV2);

    // Start Server
    app.listen(port, () => {
      console.log(` Server running on :${port}`);
      console.log(` Environment: ${serviceInfo.environment}`);
    });
  })
  .catch((error) => {
    console.error("Error connecting to Database:", error);
    process.exit(1);
  });
