import app from "./app.js";
import { connectDB } from "./DB/db.js";
import "dotenv/config";
import os from "os";
import process from "process";
import client from "prom-client";

// Routers


const port = process.env.PORT || 8000;

// Service metadata
const serviceInfo = {
  name: "medpho-crm-backend",
  version: process.env.npm_package_version || "1.0.0",
  environment: process.env.NODE_ENV || "development",
};

let dbConnected = false;

// Prometheus Metrics Setup
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: "medpho_"});

const httpRequestCounter = new client.Counter({
  name: "medpho_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

// Middleware to track requests
app.use((req, res, next) => {
  res.on("finish", () => {
    httpRequestCounter.inc({
      method: req.method,
      route: req.path,
      status_code: res.statusCode,
    });
  });
  next();
});

// Database + Server
connectDB()
  .then(() => {
    dbConnected = true;

    // Root route
    app.get("/", (req, res) => {
      res.status(200).json({
        message: "Welcome to the Medpho Hospital Backend API",
        service: serviceInfo.name,
        version: serviceInfo.version,
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
