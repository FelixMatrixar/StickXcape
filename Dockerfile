# syntax=docker/dockerfile:1
# The MVP services in one image: web hosting, rooms, relay, AI gateway and metrics.
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
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY services services
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/netcode/package.json packages/netcode/
COPY services/server/package.json services/server/
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/server/dist services/server/dist
COPY services/server/public services/server/public
USER node
EXPOSE 8080
CMD ["node", "services/server/dist/index.js"]
