# One image for every process: the API, the validation worker and the three pipeline services.
# Each container picks its process with the command, so they all scale independently.

FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node models ./models
# Services keep no files of their own; everything lives in S3, Postgres and Redis.
USER node
CMD ["node", "dist/server.js"]
