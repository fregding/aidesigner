FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    LOCAL_IMAGE_ONLY_MODE=true \
    ENABLE_PPT=false \
    ENABLE_VIDEO=false \
    ENABLE_PAYMENTS=false \
    ENABLE_ASSISTANT=false
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY . .
WORKDIR /app/backend
EXPOSE 3000
CMD ["npm", "start"]
