#!/bin/bash

# ClaimOS Backend - Startup Script
# This script sets up the correct Node version and starts the backend

# Download and use Node 18 (only needs to be done once)
if [ ! -d "/tmp/node-v18.20.8-darwin-arm64" ]; then
    echo "Downloading Node 18.20.8..."
    curl -sL https://nodejs.org/dist/v18.20.8/node-v18.20.8-darwin-arm64.tar.xz | tar -xJ -C /tmp/
fi

# Set up Node 18 in PATH
export PATH=/tmp/node-v18.20.8-darwin-arm64/bin:$PATH

# Verify Node version
echo "Using Node: $(node --version)"
echo "Using npm: $(npm --version)"

# Navigate to Backend directory
cd /Users/maverick/Documents/Finclarity-Tech/claimsos/Backend

# Kill any existing backend process
pkill -f "node dist/index.js" 2>/dev/null
sleep 2

# Start backend
echo ""
echo "Starting ClaimOS Backend..."
node dist/index.js &
BACKEND_PID=$!

# Wait for backend to start
sleep 5

# Check if backend is running
if curl -s http://localhost:8000/api/v1/health > /dev/null 2>&1; then
    echo "✅ Backend started successfully (PID: $BACKEND_PID)"
    echo "📊 Health: $(curl -s http://localhost:8000/api/v1/health | jq '.message')"
    echo ""
    echo "Backend is running on: http://localhost:8000"
    echo "Database status: $(curl -s http://localhost:8000/api/v1/health | jq '.database')"
else
    echo "❌ Failed to start backend"
    tail -50 /tmp/backend.log
    exit 1
fi

# Keep script running to show logs
tail -f /tmp/backend.log
