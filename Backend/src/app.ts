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
    // Production domains — hardcoded fallback so a missing CORS_ORIGIN env
    // doesn't lock the FE out. Extend via CORS_ORIGIN if you add more.
    "https://claims.24elevenhealthcare.com",
    "https://www.claims.24elevenhealthcare.com",
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map(s => s.trim()) : [])
];

const corsOptions = {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
        // Missing Origin header → allow. Browser requests always set Origin
        // (including sandboxed iframes via "Origin: null"), so a missing
        // header means non-browser traffic: curl, ELB health checks,
        // internal monitors. We auth via Bearer tokens in Authorization
        // headers (not cookies), so the CSRF concern that previously
        // motivated rejecting no-Origin requests doesn't apply — an
        // attacker can't reach a victim's localStorage token cross-origin.
        if (!origin) return callback(null, true);
        if (whitelist.indexOf(origin) !== -1) return callback(null, true);
        // Sandboxed-iframe canary: Origin literally "null". Reject —
        // these are browser-driven and not in our trust set.
        return callback(new Error(`Not allowed by CORS (origin: ${origin})`));
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
