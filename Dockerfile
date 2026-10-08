FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# Bun runs the TypeScript sources directly; tsconfig.json carries the decorator settings Nest needs.
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Non-root user that ships with the oven/bun image.
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:3000/health/ready'); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "src/main.ts"]
