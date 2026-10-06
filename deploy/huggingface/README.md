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

The single **Location or artist** field supports location searches and artist filtering. Date buttons offer Today, Next 7 days, This weekend, This month, and Next 3 months. Results sort latest event date first. More than three matching DJ entries sharing a named event, location, and occurrence become one festival card; smaller lineups remain individual shows. Multi-day festivals show a date range and sort by their start date.

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
