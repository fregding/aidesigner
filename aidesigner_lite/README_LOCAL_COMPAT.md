# Local/Docker compatible startup

This patched project supports two equivalent development entry points:

## Windows without Docker

Double-click `start_all.bat` or run:

```bat
start_all.bat
```

It uses `backend/.env.local`, starts the local mock image server on `127.0.0.1:18080`, and starts the Node backend on `localhost:3000`. It does not reuse `backend/.env`, so production/domain settings will not break localhost access.

## macOS/Linux without Docker

```bash
bash scripts/dev.sh
```

## Docker

Docker remains unchanged and continues to use `.env.docker`:

```bash
docker compose up --build
```

## Why this fixes the .bat problem

The previous Windows launcher reused `backend/.env`. In this package that file contains production-style/domain settings such as `ALLOWED_ORIGINS=https://your-domain.example` and remote image provider defaults. That works for deployment-like setups but conflicts with browser access from `localhost`. The patched launcher always uses `backend/.env.local` with:

- `ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000`
- `SITE_PUBLIC_BASE_URL=http://localhost:3000`
- `ENABLE_LOCAL_IMAGE=true`
- `IMAGE_BASE_URL=http://127.0.0.1:18080/v1`
- `NODE_ENV=development`

Keep `.env.docker` for Docker, keep `backend/.env.local.example` in GitHub for collaborators, and do not require every collaborator to install Docker.
