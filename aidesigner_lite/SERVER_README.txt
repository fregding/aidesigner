AI Designer Docker release

1. Upload and extract this archive on the server into a stable directory:
   mkdir -p /srv/aidesigner
   tar -xzf aidesigner_20260516_213358.tar.gz --strip-components=1 -C /srv/aidesigner
   cd /srv/aidesigner

2. First deployment:
   ./scripts/deploy-docker.sh https://your-domain.example admin@your-domain.example

   Without a domain, expose Docker directly:
   ./scripts/deploy-docker.sh --direct http://your-server-ip:3000 admin@local

3. Later updates:
   tar -xzf aidesigner_20260516_213358.tar.gz --strip-components=1 -C /srv/aidesigner
   ./scripts/deploy-docker.sh

4. Confirm that the server AI service is running:
   curl -fsS http://127.0.0.1:3000/api/health
   docker compose --env-file .env.docker ps

   The deploy script only prints success after /api/health is reachable.
   For reverse-proxy deployment, .env.docker must keep:
   APP_BIND=127.0.0.1
   TRUST_PROXY=true

   Nginx/Caddy must forward the real client IP. With Nginx:
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;

Runtime data is stored on the server under runtime/data and runtime/uploads.
Do not commit or upload .env.docker back to Git.
