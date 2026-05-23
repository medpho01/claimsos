FROM node:22-alpine

RUN apk add --no-cache ghostscript

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

# Prod runs via tsx (same TS-aware runtime as dev) rather than precompiling
# with tsc. The intelligence-layer code has latent type errors that TS 5
# surfaces but TS 4.9 + tsx tolerated; fixing them is on the backlog.
# tsx adds ~200ms to cold start, which is fine for a long-running server.

EXPOSE 8000

CMD ["npm", "start"]
