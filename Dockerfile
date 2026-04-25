FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1
ARG VERSION=dev
LABEL org.opencontainers.image.title="klaus"
LABEL org.opencontainers.image.description="Headless personal AI agent: WhatsApp → TypeScript → Obsidian Vault"
LABEL org.opencontainers.image.source="https://github.com/janbassen1/klaus"
LABEL org.opencontainers.image.version="${VERSION}"
ENV VERSION=${VERSION}
WORKDIR /app

# Node 22 + obsidian-headless: bundles vault sync into the Klaus container so a
# single `docker run` covers WhatsApp + Obsidian Sync. Klaus supervises `ob` as
# a child process from src/infra/sync.ts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm i -g obsidian-headless \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/auth /app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
