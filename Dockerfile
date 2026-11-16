FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js tsconfig.json ./
COPY src ./src
COPY public ./public
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production TZ=Europe/Moscow
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=frontend /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "server/index.js"]

FROM python:3.12-slim-bookworm AS worker
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TZ=Europe/Moscow
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends antiword ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY worker/requirements.txt ./worker/requirements.txt
RUN pip install --no-cache-dir -r worker/requirements.txt
COPY worker ./worker
COPY shared ./shared
RUN useradd --uid 1000 --create-home app && mkdir -p /app/data && chown app:app /app/data
USER app
CMD ["python", "-m", "uvicorn", "worker.service:app", "--host", "0.0.0.0", "--port", "8790", "--workers", "1"]
