FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY scripts ./scripts
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "--env-file=/app/config/portal.env", "server/index.mjs"]
