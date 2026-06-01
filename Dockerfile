FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development \
    PORT=3000 \
    DATABASE_PATH=/app/backend/data/aidesigner.sqlite \
    JWT_SECRET=local-dev-jwt-secret-please-change-in-production \
    ENABLE_LOCAL_IMAGE=true \
    ENABLE_IMAGE=true \
    IMAGE_PROVIDER=local \
    LOCAL_IMAGE_API_BASE_URL=http://host.docker.internal:18080/v1 \
    LOCAL_IMAGE_API_KEY=local-dev-key \
    LOCAL_IMAGE_MODEL=local-mock-image \
    IMAGE_BASE_URL=http://host.docker.internal:18080/v1 \
    IMAGE_API_KEY=local-dev-key \
    IMAGE_MODEL=local-mock-image \
    IMAGE_GENERATION_MODEL=local-mock-image \
    IMAGE_TIMEOUT_MS=600000 \
    DISABLE_PPT=true \
    DISABLE_VIDEO=true \
    DISABLE_PAYMENTS=true \
    DISABLE_MEMBERSHIP=true \
    ENABLE_ASSISTANT=false

COPY backend/package*.json ./backend/

RUN cd backend \
    && npm config set registry https://registry.npmmirror.com \
    && npm install --omit=dev --no-audit --no-fund

COPY backend ./backend
COPY *.html ./
COPY assets ./assets

WORKDIR /app/backend

EXPOSE 3000

CMD ["npm", "start"]
