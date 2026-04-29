FROM node:25-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:25-bookworm-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="klaus"
LABEL org.opencontainers.image.description="Headless personal AI agent: WhatsApp → TypeScript → Obsidian → OpenRouter"
LABEL org.opencontainers.image.source="https://github.com/jan-bassen/klaus"
LABEL org.opencontainers.image.version="${VERSION}"
ENV VERSION=${VERSION}
WORKDIR /app

# obsidian-headless: bundles vault sync into the Klaus container so a single
# `docker run` covers WhatsApp + Obsidian Sync. Klaus supervises `ob` as a
# child process from src/infra/vault/sync.ts.
RUN npm install -g obsidian-headless

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/defaults /app/vault /app/data \
	&& cp -R /app/vault/. /app/defaults/. \
	&& rm -rf /app/vault \
	&& mkdir -p /app/vault
VOLUME ["/app/vault", "/app/data"]
CMD ["node", "src/index.ts"]
