# Backend Environment & Node Version Fix

## Problem
- **Current Node version:** v12.22.3  
- **Required minimum:** Node 14.0.0 (for optional chaining support)
- **Error:** `SyntaxError: Unexpected token '.'` when running backend
- **Root cause:** TypeScript v5.9.3 transpiles to ES2020 which includes optional chaining, but Node v12 doesn't support it

## Solutions (Pick One)

### Solution 1: Use Node via Docker (Recommended - Easiest)
```bash
# Create a Dockerfile in Backend/
cat > Dockerfile << 'EOF'
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8000
CMD ["node", "dist/index.js"]
EOF

# Build and run
docker build -t claimsos-backend .
docker run -p 8000:8000 --env-file .env claimsos-backend
```

### Solution 2: Install Node 18 via Direct Binary (If nvm has issues)
```bash
# Download Node 18 LTS directly
curl -O https://nodejs.org/dist/v18.20.8/node-v18.20.8-darwin-arm64.tar.xz
tar -xf node-v18.20.8-darwin-arm64.tar.xz
mv node-v18.20.8-darwin-arm64 ~/.local/nodejs

# Add to PATH
export PATH=~/.local/nodejs/bin:$PATH

# Verify
node --version  # Should be v18.20.8

# Rebuild and run
npm run build
node dist/index.js
```

### Solution 3: Fix nvm Caching Issue and Use nvm
```bash
# Reset nvm cache
rm -rf ~/.nvm/versions/node/*
nvm install 18
nvm use 18
nvm alias default 18

# Verify and run
node --version  # Should be v18.x.x
npm run build
node dist/index.js
```

### Solution 4: Update TypeScript Configuration (Temporary Workaround)
Only if you cannot upgrade Node - downgrade more dependencies:
```bash
npm install -D typescript@4.5.5 zod@3.11.11
# Update tsconfig.json target to ES2017
# Run: npm run build && node dist/index.js
```

---

## Recommended Steps

1. **Choose one solution above** - Solution 1 (Docker) or Solution 2 (Direct Binary) are easiest
2. **Verify Node version:**
   ```bash
   node --version  # Should be v14+, preferably v18
   npm --version   # Should be v6+
   ```

3. **Build backend:**
   ```bash
   npm run build  # Should complete without errors
   ```

4. **Start backend:**
   ```bash
   node dist/index.js
   # Should output: Server running on port 8000
   ```

5. **Test endpoints:**
   ```bash
   # Health check
   curl http://localhost:8000/api/v1/health
   
   # List hospitals (requires auth)
   curl http://localhost:8000/api/v1/hospitals \
     -H "Authorization: Bearer $TOKEN"
   ```

6. **Build and run frontend:**
   ```bash
   cd ../webapp
   npm install
   npm start  # Should start on http://localhost:3000
   ```

---

## Verification Checklist

- [ ] Node version is 14+ (preferably 18)
- [ ] `npm run build` completes without errors
- [ ] Backend starts without "SyntaxError" or "out of memory" 
- [ ] `curl localhost:8000/api/v1/health` returns 200 OK
- [ ] Frontend starts on http://localhost:3000
- [ ] Document upload API endpoint is accessible from frontend

---

## Quick Test After Backend is Running

```bash
# In another terminal, test document upload endpoint
curl -X POST http://localhost:8000/api/v1/hospitals/{hospitalId}/documents/upload \
  -H "Authorization: Bearer {token}" \
  -F "file=@test.pdf" \
  -F "documentName=Test Document" \
  -F "documentCategory=certifications"
```

If you get a 200/201 response with document metadata, the feature is working!
