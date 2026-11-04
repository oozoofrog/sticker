# One official multi-architecture OCI index; build/runtime inherit the same pristine base.
# Pin evidence and update policy: docs/REPRODUCIBILITY.md (never replace with an arch digest).
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY server ./server
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
