# syntax=docker/dockerfile:1
# The MVP in one image: the game client, plus the services (web hosting, rooms, relay, AI
# gateway and metrics). The server serves the client build through WEB_ROOT.
#
#   docker build -t sticxcape .
#   docker run --rm -p 8080:8080 sticxcape
#
# Settings come from environment variables (see services/server/.env.example); on Fly.io from
# fly.toml and `fly secrets`.

FROM node:24-alpine AS build
WORKDIR /app
# Manifests first, so the install layer is reused until dependencies change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/netcode/package.json packages/netcode/
COPY services/server/package.json services/server/
COPY apps/client/package.json apps/client/
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY services services
COPY apps apps
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
ENV WEB_ROOT=/app/apps/client/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/netcode/package.json packages/netcode/
COPY services/server/package.json services/server/
COPY apps/client/package.json apps/client/
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/server/dist services/server/dist
COPY services/server/public services/server/public
COPY --from=build /app/apps/client/dist apps/client/dist
# Accounts live in a SQLite file under /data when DATABASE_FILE points there (a volume on Fly.io,
# which mounts it for the image's user). Owned by node, so a local `docker run -v` volume works too.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "services/server/dist/index.js"]
