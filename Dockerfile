FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    APP_MODE=demo \
    HOST=0.0.0.0 \
    PORT=7860 \
    DATABASE_PATH=/app/work/show-finder.sqlite

RUN mkdir -p /app/work && chown node:node /app /app/work
WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml ./
USER node
RUN corepack pnpm@10.11.0 install --prod --frozen-lockfile

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
COPY --chown=node:node scripts ./scripts
RUN node scripts/build-feedback-assets.mjs
COPY --chown=node:node scripts ./scripts

EXPOSE 7860
CMD ["node", "scripts/start-browser.mjs"]
