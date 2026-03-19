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
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/auth && chown -R bun:bun /app
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
