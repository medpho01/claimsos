FROM node:22-alpine

# pdf-to-png-converter shells out to ghostscript for rasterisation.
RUN apk add --no-cache ghostscript

WORKDIR /usr/src/app

COPY package*.json ./

# `npm ci` (not `npm install`): package-lock.json is committed, and only `ci`
# guarantees the image gets exactly the locked tree. `install` silently
# re-resolves ranges at build time, so two builds of the same commit could
# ship different dependency versions.
#
# Deliberately NOT --omit=dev: there is no tsc build step (prod runs via tsx,
# see CMD below), so the TypeScript toolchain and @types/* are load-bearing at
# runtime, not build-time-only. node-pg-migrate has been promoted to
# `dependencies` so the compose `migrate` service keeps working even if this
# ever does switch to a production-only install.
RUN npm ci

COPY . .

# Run as the unprivileged `node` user that the base image already ships. The
# process binds 8000 (not a privileged port), so nothing here needs root.
RUN chown -R node:node /usr/src/app
USER node

# Prod runs via tsx (same TS-aware runtime as dev) rather than precompiling
# with tsc. The intelligence-layer code has latent type errors that TS 5
# surfaces but TS 4.9 + tsx tolerated; fixing them is on the backlog.
# tsx adds ~200ms to cold start, which is fine for a long-running server.

EXPOSE 8000

# Alpine has no curl and adding one just for a healthcheck is waste — node 22's
# global fetch does the same job with zero extra image weight.
#
# --start-period=45s: tsx cold start plus the worker's 20+ dynamic queue
# imports (index.ts:440+) takes real time. A short start period flaps the
# container into `unhealthy` during an entirely normal boot, which in turn
# blocks anything gated on `service_healthy`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
