# --- stage 1: build the React client ---
FROM node:24-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
RUN npm run build

# --- stage 2: install server deps (native modules compile here) ---
FROM node:24-alpine AS server-deps
WORKDIR /app/server
# better-sqlite3 needs build tools to compile against this image's Node version
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- stage 3: final runtime image ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Fly volume mounts at /data; point SQLite there for persistence across deploys
ENV DB_PATH=/data/data.db
ENV CLIENT_DIST=/app/client-dist

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY --from=client-build /app/client/dist ./client-dist

EXPOSE 8080
WORKDIR /app/server
CMD ["node", "index.js"]
