FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Employee documents live on a mounted volume owned by the unprivileged user.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=4s --retries=8 CMD wget -q -O /dev/null http://127.0.0.1:5000/api/health || exit 1
CMD ["node", "dist/server.js"]
