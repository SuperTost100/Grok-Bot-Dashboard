FROM node:24-alpine
WORKDIR /app
# No runtime dependencies: the server uses only Node's standard library (HTTP, SQLite, fetch).
COPY package.json ./
COPY server ./server
COPY public ./public
COPY bin ./bin
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/main.ts"]
