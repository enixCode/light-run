FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

# docker-cli is needed so light-runner (spawned by this service) can drive
# the host Docker daemon via the mounted /var/run/docker.sock. Spawned
# containers land as siblings on the host, not nested.
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/src/bin/light-run.js", "serve", "--port", "3001", "--host", "0.0.0.0"]
