# Rudraganga backend — Cloud Run image.
# Runs the Express API + Socket.IO + in-process job worker in one container.
FROM node:20-slim

WORKDIR /app

# Install prod deps first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Cloud Run injects PORT (8080). config/env.js already reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080

# Graceful shutdown is handled in server.js (SIGTERM → drain sockets + jobs).
CMD ["node", "server.js"]
