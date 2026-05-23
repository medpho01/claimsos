import express from "express";
import cors from "cors";
import helmet from "helmet";
// import cookieParser from "cookie-parser";

const app = express();

// Sets secure-by-default HTTP response headers (CSP, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, etc.). Disable the default CSP
// for now since the public hospital share routes serve HTML that loads
// third-party fonts and images; enabling CSP needs explicit policy work.
app.use(helmet({ contentSecurityPolicy: false }));

const whitelist = [
    "http://localhost:9001",
    "http://localhost:3000", // React webapp
    "http://localhost:5001",
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : [])
];

const corsOptions = {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
        // Missing Origin header → allow ONLY for same-origin/server-side
        // tools that don't carry a browser context (curl, healthchecks).
        // Browser requests always set Origin, including sandboxed iframes
        // (which can set Origin: null — a real string, not falsy). The
        // previous `!origin` branch let through sandboxed iframes which,
        // combined with `credentials: true`, would be a CSRF foothold the
        // day auth moves to cookies.
        if (!origin) {
            // Allow non-browser requests in dev for tooling. In production,
            // be stricter: require an explicit Origin.
            if (process.env.NODE_ENV !== 'production') return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        }
        if (whitelist.indexOf(origin) !== -1) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
};

app.use(cors(corsOptions));

// 2 MB is comfortably above the largest legitimate JSON payload (a patient
// record with all claims fields is ~10 KB). Was 100 MB which exposed the API
// to trivial DoS via oversized JSON bodies. Multipart file uploads go through
// multer middleware and are NOT bounded by express.json — multer sets its own
// per-file limits in Middlewares/multer.middleware.ts.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(express.static("public"));

export default app;
