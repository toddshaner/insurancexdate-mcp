# Container image for the remote streamable-HTTP entrypoint (dist/http.js).
# The stdio entrypoint ships as a .mcpb instead — this image is only for
# hosting a shared instance. See src/http.ts for required env vars.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/http.js"]
