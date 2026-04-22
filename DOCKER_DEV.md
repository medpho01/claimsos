# Docker Development Setup with Hot Reload

This guide explains how to run the ClaimOS application in development mode with hot reload enabled.

## Quick Start

### 1. Stop Current Production Containers
If you have the production containers running, stop them first:
```bash
docker-compose down
```

### 2. Start Development Containers with Hot Reload
```bash
docker-compose -f docker-compose.dev.yml up --build
```

The `--build` flag rebuilds the Docker images with the new Dockerfiles.dev.

### 3. Access the Application
- **Frontend**: http://localhost:5001
- **Backend API**: http://localhost:6001
- **Redis**: localhost:6379

## Features

### ✅ Hot Reload Enabled

#### Backend (Node.js + TypeScript)
- Uses `tsx watch` to automatically restart on file changes
- Changes to files in `Backend/src/` are instantly reflected
- No manual restart needed
- Terminal will show compilation and runtime errors in real-time

#### Frontend (React with Craco)
- Uses the React development server with live reload
- Changes to files in `webapp/src/` trigger instant page refresh
- Supports Fast Refresh (preserves component state during edits)
- Terminal will show eslint warnings and build errors

### ✅ Volume Mounts
- `./Backend/src` → `/usr/src/app/src` (source code)
- `./Backend/dist` → `/usr/src/app/dist` (compiled output)
- `./webapp/src` → `/app/src` (React components)
- `./webapp/public` → `/app/public` (static files)

### ✅ Fixed Database Connection
- `POSTGRES_HOST=host.docker.internal` allows containers to reach the host machine
- If you have PostgreSQL running locally, the backend can now connect to it

## File Structure

```
claimsos/
├── docker-compose.yml              (Production)
├── docker-compose.dev.yml          (Development with hot reload) ← USE THIS FOR DEV
├── Backend/
│   ├── Dockerfile                  (Production)
│   ├── Dockerfile.dev              (Development)
│   └── src/
├── webapp/
│   ├── Dockerfile                  (Production)
│   ├── Dockerfile.dev              (Development)
│   └── src/
└── redis/
```

## Workflow Example

### Backend Development
```bash
# 1. Start dev environment
docker-compose -f docker-compose.dev.yml up

# 2. Make changes to Backend/src/index.ts or any route file
# 3. Save the file
# 4. Watch the terminal - tsx automatically recompiles and restarts
# 5. API changes are immediately available
```

### Frontend Development
```bash
# 1. Start dev environment
docker-compose -f docker-compose.dev.yml up

# 2. Make changes to webapp/src/components/MyComponent.tsx
# 3. Save the file
# 4. Check http://localhost:5001 - page auto-refreshes with your changes
# 5. No need to rebuild or restart
```

## Viewing Logs

### Backend Logs
```bash
docker logs -f hospital_backend_dev
```

### Frontend Logs
```bash
docker logs -f hospital_webapp_dev
```

### All Logs
```bash
docker-compose -f docker-compose.dev.yml logs -f
```

## Stopping Development Environment

### Stop All Containers
```bash
docker-compose -f docker-compose.dev.yml down
```

### Stop and Remove Data
```bash
docker-compose -f docker-compose.dev.yml down -v
```

## Switching Between Production and Development

### Run Production
```bash
docker-compose up
```

### Run Development with Hot Reload
```bash
docker-compose -f docker-compose.dev.yml up --build
```

## Troubleshooting

### Port Already in Use
If you get "port already in use" errors:
```bash
# Stop all Docker containers
docker stop $(docker ps -q)

# Or kill specific containers
docker stop hospital_backend_dev hospital_webapp_dev hospital_redis_dev
```

### Changes Not Reflecting
1. **Backend**: Check that files are in `Backend/src/` directory
2. **Frontend**: Check browser console for errors
3. **Volume Mounts**: Verify with `docker inspect hospital_backend_dev` and look for "Mounts"

### Build Errors
1. Clear Docker cache: `docker-compose -f docker-compose.dev.yml down --rmi all`
2. Rebuild: `docker-compose -f docker-compose.dev.yml up --build`

### Database Connection Error
If backend can't reach PostgreSQL:
1. Ensure PostgreSQL is running on your host machine
2. Check Backend/.env has correct credentials
3. Verify POSTGRES_HOST is set to `host.docker.internal` (it is in docker-compose.dev.yml)

## Performance Notes

- **First build**: Takes longer as dependencies are installed
- **Hot reload speed**: Typically 1-3 seconds for backend changes, instant for frontend
- **Disk space**: Development mode keeps extra build artifacts
- **Memory usage**: Similar to production, plus dev server overhead

## Development Best Practices

1. **Always use docker-compose.dev.yml for development**
2. **Keep your local PostgreSQL running** if using external database
3. **Check logs frequently** for errors that might not show in UI
4. **Don't edit .env during runtime** - needs container restart
5. **Use named volumes** for Redis data persistence

## Next Steps

✅ **Start Development**
```bash
cd /Users/maverick/Documents/Finclarity-Tech/claimsos
docker-compose -f docker-compose.dev.yml up --build
```

Then make changes to your code and watch them hot reload!
