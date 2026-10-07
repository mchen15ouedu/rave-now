FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=7860 \
    CONTRIBUTIONS_WORKER_ENABLED=true \
    CONTRIBUTIONS_PROCESSING_MODE=batch \
    CONTRIBUTIONS_BATCH_LIMIT=20 \
    INPUT_ANALYSIS_INTERVAL_MINUTES=60 \
    ARTIST_AI_CACHE_DIR=work/models

RUN mkdir -p /app/work && chown node:node /app /app/work
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml ./
USER node
RUN corepack pnpm@10.11.0 install --prod --frozen-lockfile
COPY --chown=node:node src ./src
EXPOSE 7860
CMD ["node", "src/input-analysis.mjs"]
