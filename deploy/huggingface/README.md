---
title: Rave Now
emoji: 🎵
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
full_width: true
---

# Rave Now on Hugging Face

This Docker Space runs the Rave Now browser demo on port **7860**. Its included events are **fictitious samples**, not actual listings; ticket links are placeholders and must not be used to purchase tickets. You do not need an SMS account or event-source credentials to try the browser workflow.

## Create your Space

1. Create a Hugging Face Space with the **Docker** SDK and choose hardware appropriate for your account and budget. The browser application can run on CPU hardware.
2. Upload the root `Dockerfile`, dependency manifests/lockfile, and the `src`, `public`, and `data` folders. Use this file as the Space repository's root `README.md` so Hugging Face reads the Docker metadata above.
3. Let Hugging Face build the image, then open your Space's app. Its direct address uses `https://<your-space-subdomain>.hf.space`; use your own address wherever an endpoint is required.
4. Keep `HOSTED_SERVICE_ENABLED` unset or `false` for the browser demonstration. `/healthz` reports browser availability independently of messaging activation.

The image uses Node.js 24, installs production dependencies from the lockfile, and runs as UID 1000. The browser launch regenerates sample dates at startup. Rebuild or restart the demonstration to refresh that sample schedule. Do not upload local `.env` files, runtime databases, account credentials, or private event data.

## Browser behavior

The page requests location permission when opened; city/state/country or a US ZIP is available when permission is denied. If the embedded frame blocks location access, open your Space's direct app URL. Browser locations stay in page memory and do not register messaging users or enable reminders.

The single **Location or artist** field supports location searches and artist filtering. Date buttons offer Today, Next 7 days, This weekend, This month, and Next 3 months. Results sort soonest upcoming date first. Festival-category entries sharing an Event name, location, and occurrence become one festival card. Other shows retain all performer names when combined at the same venue and time. Multi-day festivals show a date range and sort by their start date, soonest first.

Non-festival browser results at the same venue and listed show time combine into one card with all performer names, music styles, categories, unique ticket links, and labeled YouTube links. When only a date is listed, matching date-only entries at that venue combine. Different listed times, venues, conflicting known street addresses, and unknown sites stay separate. Artist and date filtering happen before merging. A `Festival` category uses the Event name as the card heading, regardless of the number of matching artists; its ticket links and one festival YouTube search remain available. Distinct festivals and regular shows stay separate. If a festival has no usable Event name, artist headings remain until the feed supplies that name. Listed times appear on single-date cards, and known times sort earliest first within each day.

The default geocoder uses a bundled GeoNames city/US ZIP directory without a paid API key. The radius is **80 straight-line miles**, an approximate two-hour driving proxy. It does not calculate road travel time. Address takes priority over City, with approximate city/ZIP centers labeled where necessary. GeoNames data is CC BY 4.0; preserve `data/GEONAMES-LICENSE.md` and the app's attribution.

**Link music profiles** saves optional Instagram, YouTube Music/YouTube, and Spotify profile URLs on the visitor's device. It does not send them to the Space, sign into providers, import follows/listening history, infer taste, or change the event feed. Clear fields and save to remove saved links.

## Optional messaging deployment

Live SMS/WhatsApp requires your own Twilio account and senders, an approved WhatsApp reminder template, location/time-zone lookup credentials, and durable database storage. These services can incur charges. Keep secrets in the Space's **Settings → Secrets**, never in source code or browser assets. The main project README and `.env.example` describe the messaging configuration.

Set `PUBLIC_WEBHOOK_URL` to your own exact HTTPS endpoint:

```text
https://<your-space-subdomain>.hf.space/webhooks/twilio
```

Point both Twilio incoming-message webhooks there using **POST**. Set `HOSTED_SERVICE_ENABLED=true` only after messaging configuration and durable storage are ready. Test registration, location changes, reminders, `STOP`, and `DELETE` with your own phone. The unsigned localhost message simulator is not available through the hosted browser service.

Hugging Face's default Space disk is temporary. Registrations, saved messaging locations, and reminder claims in `/app/work/show-finder.sqlite` can be lost on a restart. Add a suitable durable database/volume arrangement before relying on live messaging. Browser discovery does not require a user database.

The reminder worker sends during the ten-minute window after 10 PM in each saved location's time zone. Downtime beyond that window skips the day's reminder. An hourly health check may help detect availability, but scheduled jobs and Space restarts do not guarantee continuous operation or preserve data.

See [Hugging Face Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker), [Space storage](https://huggingface.co/docs/hub/spaces-storage), and [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Private text feedback

The Docker build includes the browser Whisper assets. For durable complaint transcripts, use a private HF Dataset repository and configure server variable `FEEDBACK_HF_REPO` plus server secret `FEEDBACK_HF_TOKEN`. The token needs read/write access to that repository. No paid inference endpoint is required. Users review the transcript and explicitly send it; recordings stay on the device. See the root README for owner export and joint review.

## Private artist and event submissions

**Missing artist?** opens a voice/text form beside the search label. Configure a separate private HF Dataset with `CONTRIBUTIONS_HF_REPO` and a server read/write token in `CONTRIBUTIONS_HF_TOKEN`, or reuse `FEEDBACK_HF_TOKEN` when authorized for that dataset. This browser Space uses `CONTRIBUTIONS_WORKER_ENABLED=false`, `CONTRIBUTIONS_PROCESSING_MODE=batch`, and `CONTRIBUTIONS_BATCH_INTERVAL_MINUTES=60`. The [dedicated input-analysis Space](../input-analysis/README.md) owns CPU inference and hourly verification. Complaints remain in their separate feedback repository. No raw recordings are uploaded.

A pinned quantized Qwen3 0.6B ONNX model runs only in the processor Space. Independent music records and structured primary event sources authorize additions. Duplicate events are ignored; verified missing details can fill blank cells. Uncertain or conflicting submissions remain in the private inbox for owner review. Each record stores its processing status, evidence URLs, and a lease for restart recovery. The processor also saves complaint summaries and suggested improvements in a separate private HF dataset for owner review. No paid inference endpoint or upgraded hardware is required.
