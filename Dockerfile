# AssessBank — Cloud Run container
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the application source. What ships is controlled by
# .dockerignore (excludes node_modules, secrets, .git, docs, .claude, *.md),
# so new runtime files are picked up automatically instead of being missed.
COPY . ./

# Cloud Run injects PORT; default to 8080 for local runs.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
