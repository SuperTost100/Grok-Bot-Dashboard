# The Docker CLI with Compose, plus Node for the small HTTP server that drives it.
FROM docker:27-cli
RUN apk add --no-cache nodejs
WORKDIR /runner
COPY validate.mjs server.mjs ./
ENV APPS_DIR=/apps APP_NETWORK=grokdash PORT=8790 KEY_FILE=/keys/runner.key
# The base image's entrypoint would read "node" as "docker node".
ENTRYPOINT ["node", "server.mjs"]
