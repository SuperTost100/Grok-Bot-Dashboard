FROM node:24-alpine
WORKDIR /app
# No runtime dependencies: mail, calendars and the rest are add-ons now, each bundled on its own.
# package.json only tells Node the .ts files are ES modules.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY bin ./bin
COPY runner/validate.mjs ./runner/validate.mjs
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/main.ts"]
