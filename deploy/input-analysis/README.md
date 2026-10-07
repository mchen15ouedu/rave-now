---
title: Rave Now Input Analysis
emoji: 📨
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Rave Now Input Analysis

A separate CPU Basic Space processes saved user input at startup and roughly once an hour. The browser Space stays responsive while inference runs here. There is no public transcript, report, or processing-trigger endpoint; `/healthz` exposes only readiness and batch timing.

Copy this folder's Dockerfile to the Space root, with `package.json`, `pnpm-lock.yaml`, and `src/`. Do not upload a tracker snapshot, browser build, credentials, or runtime files.

Configure server variables:

- `CONTRIBUTIONS_HF_REPO`: existing private artist/show inbox.
- `FEEDBACK_HF_REPO`: existing private feedback inbox.
- `INPUT_ANALYSIS_HF_REPO`: a separate private dataset for feedback summaries.
- `INPUT_ANALYSIS_INTERVAL_MINUTES=60` and `CONTRIBUTIONS_BATCH_LIMIT=20`.

Configure server secrets:

- `FEEDBACK_HF_TOKEN`: token authorized to read/write those private datasets. Optional `CONTRIBUTIONS_HF_TOKEN` and `INPUT_ANALYSIS_HF_TOKEN` override it per dataset.
- `ARTIST_CATALOG_URL` and `ARTIST_CATALOG_SECRET`: the existing approved tracker connection.

On the browser Space, set `CONTRIBUTIONS_WORKER_ENABLED=false`, `CONTRIBUTIONS_PROCESSING_MODE=batch`, and `CONTRIBUTIONS_BATCH_INTERVAL_MINUTES=60`. The app saves submissions and checks a saved receipt when its dialog is reopened. Unknown artist searches also enter the private queue in batch mode.

The processor reuses one pinned quantized Qwen3 model on CPU, sequentially processes up to 20 artist/show submissions, then analyzes up to 10 previously unreported complaints. A busy batch does not overlap another batch. Interrupted contribution leases recover later; confirmed artist/event identities remain subject to independent evidence and tracker deduplication.

Feedback reports contain an AI summary, category, suggested improvement, source feedback UUID, and model revision. They are marked `owner-review` and cannot change the app. Model output can be wrong; inspect the original complaint before deciding. Invalid or unavailable analysis remains unreported for a later attempt. Reports and raw submissions stay in separate private HF datasets and survive Space rebuilds. Owner export: `node scripts/export-input-analysis.mjs` with the private environment configured.

Set the GitHub repository variable `HF_INPUT_ANALYSIS_URL` to the protected Space's public `https://your-space.hf.space` origin. The existing hourly health workflow can wake both Spaces. GitHub schedules and free hardware do not guarantee an exact processing time; every processor startup attempts pending work. CPU Basic has no hourly hardware charge under an eligible paid account; this deployment does not request upgraded hardware or paid inference.
