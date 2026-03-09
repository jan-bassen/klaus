FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN addgroup --system --gid 1001 bun && \
    adduser --system --uid 1001 --ingroup bun bun && \
    chown -R bun:bun /app
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
