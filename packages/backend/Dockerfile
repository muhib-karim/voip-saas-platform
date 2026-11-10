FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

# Runtime dependencies only. The build context is this package, and the
# lockfile lives at the repository root, so versions are resolved at build
# time; build from the root with the lockfile if you need a reproducible image.
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Do not run the API as root.
USER node

EXPOSE 5000

# docker-compose.yml overrides this with `npm run dev` for local development.
CMD ["node", "src/index.js"]
