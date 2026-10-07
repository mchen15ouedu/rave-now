# Rave Now

Rave Now finds nearby electronic-music shows in a browser and includes an SMS/WhatsApp workflow with saved locations and daily weekend reminders.

**This public project runs with fictitious sample events. They are demonstrations, not actual show listings. Sample ticket links are placeholders; do not use them to purchase tickets.** Private event feeds, account credentials, and deployment data are not part of this repository.

## Run the browser app

Install [Node.js 24 or later](https://nodejs.org/), clone the repository, and run these commands from its root:

```sh
npm install
npm run build:feedback
npm run browser
```

Open [http://localhost:7860](http://localhost:7860). The browser command regenerates the sample events around the current date before starting the app, so the date filters remain useful when you try it later. It needs no messaging account, paid geocoding key, or event-source credentials. No `.env` file is required for this demonstration.

Try **New York, NY**, **Dallas, TX**, or **Las Vegas, NV** for nearby samples, or **artist: Sample Pulse** for an artist search. The sample notice below the search identifies the fictitious feed. Set `BROWSER_PORT` if port 7860 is already in use.

The page requests location access when opened. Your browser controls its permission dialog. If access is denied or unavailable, enter a city and state/country or a US ZIP code in **Location or artist**. An artist search uses the last accepted location; before a location is available, it searches matching appearances across all sample locations and displays that scope. Use `location: Paris, France` or `artist: Paris` to distinguish an artist from a place.

Slow searches show progress. Temporary search failures offer **Try again**; that button appears only after an error. Unavailable artist suggestions or an artist-list outage do not block valid city searches. During an artist-list outage, an unrecognized query may need `location: City` or `artist: Name` to clarify the search. Artist additions are reported as saved only after confirmation; an unconfirmed update is shown alongside any usable results.

A full artist name missing from Artist List is automatically verified before it can be saved. Verification requires a conservative exact-name match in a music catalog that identifies a music artist or DJ. A confirmed artist can be added even when no events match the chosen date range, provided catalog writes are connected. Existing names are reused without duplicate writes; partial searches do not create new entries. Uncertain matches and temporary verification failures leave the name unadded and explain that status alongside the search results. A write whose outcome cannot be confirmed retains the separate “Artist list update could not be confirmed” message. Verification uses [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) public records without an API key, with cached results and at most one request per second. Some real artists have incomplete records and will remain unadded. The sample demo does not write to a connected artist catalog.

Date filters offer **Today**, **Next 7 days**, **This weekend**, **This month**, and **Next 3 months**. Next 7 days includes today and the following six calendar days. Weekend results include the remaining Friday–Sunday dates. Month results include today through the last day of this month. Next 3 months ends the day before the same date three calendar months later, with shorter months handled at their last valid date. Searches use the accepted location's time zone and retain the last submitted location and artist when a date filter changes. Empty windows stay empty.

Results sort by the **soonest upcoming date first**. When more than three matching DJ entries share a named event, location, and festival occurrence, the list shows that festival once with its date range and links. Three entries or fewer remain individual shows. Filtering happens before grouping; separate locations and occurrences stay separate. Festival groups sort by their start date, soonest first. A dated event announcement can appear without a listed artist.

The default radius is **80 straight-line miles**, an approximation for a two-hour drive. Road routes, traffic, and actual driving times are not calculated. The bundled offline [GeoNames](https://www.geonames.org/) directory resolves cities and US ZIP codes without an external request. Address takes priority over City; unavailable street coordinates fall back to a labeled city or ZIP center. Add a state or country for ambiguous place names.

## Optional music-profile links

**Link music profiles** saves Instagram, YouTube Music/YouTube, and Spotify profile URLs in your browser's local storage. You can save any combination or remove a link by clearing its field and saving. The app strips query strings and fragments and reports when browser storage is unavailable.

These are saved links only. The app does not sign into providers, verify account ownership, import follows or listening history, infer music taste, or change show recommendations from these links. AI taste analysis and provider OAuth are not implemented.

Browser locations stay in page memory for searches and clear on reload. Browser searches do not register a phone number, open the messaging database, or enable reminders. Music-profile URLs remain on the current device unless you clear them.

## Missing artists and shows

**Missing artist?**, beside the search label, opens one text box for a DJ name and optional show details. Type or use **Record voice**, review the Whisper transcript, and press **Send details**. Include an official event or ticket link when possible. Recordings stay on the device; only the submitted text is saved in a separate private HF Dataset repository.

Submissions are saved before processing and the dialog displays their status. A small pinned [Qwen3 model](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX) runs on the Space CPU to extract the artist name and whether show information was included. It makes no paid inference calls. Independent music records verify the artist identity before the app reuses or adds the name. The model cannot declare an artist or event verified by itself.

Event additions require matching structured event facts from an official artist/venue source or supported ticket site: artist, upcoming date, venue, and city. Text alone is insufficient. Existing events are ignored or receive verified blank details; populated facts and formulas are preserved. Conflicts, ambiguous identities, incomplete sources, and verification outages remain saved with **Needs review** status. The app handles one artist and one event per submission. Verified updates use the current tracker connection and invalidate the event cache.

For a deployment, configure `CONTRIBUTIONS_HF_REPO` to a private HF Dataset, and `CONTRIBUTIONS_HF_TOKEN` to its read/write token. The existing `FEEDBACK_HF_TOKEN` may be reused when it has that repository access. Enable `CONTRIBUTIONS_WORKER_ENABLED=true` after connecting the writable catalog adapter. Secrets stay on the server. The unconfigured sample app reports that a save was not confirmed. Durable records and processing leases allow queued work to recover after a Space restart; duplicate retries reuse the submission ID and recheck the tracker before writing. The inbox supports up to 2,000 records and 120 confirmed submissions per server hour.

The first AI task downloads about 618 MB of model weights and can take longer. The worker runs outside the web request; show searches remain available. Model cache uses temporary disk, so a rebuilt Space may download it again. Owners can inspect saved transcripts, evidence URLs, and results in the private HF Dataset; there is no public transcript-list endpoint.

## Voice feedback

**Give feedback** opens a small form. Tap **Record voice**, speak for up to 60 seconds, then tap **Stop**. Whisper transcribes the recording on your device. Review or edit the text, then press **Send feedback**. Typing works too. Opening the form does not request microphone access or download the model; recording and transcription begin only when requested.

Only submitted text, a random submission ID, and a server timestamp are saved to a **private Hugging Face Dataset repository**. Audio is not uploaded or stored. There is no public complaint-list endpoint. Drafts stay in page memory and disappear on reload. Cancellation or an uncertain save keeps the same ID for an explicit retry to avoid duplicates.

The first transcription downloads Whisper model files, then the browser caches them when supported. Older devices or slow networks may take too long; users can always type instead. Microphone recording requires HTTPS or localhost. When embedding the app, the parent iframe must allow microphone access; the direct app URL works without that iframe restriction.

For your own deployment, create a private HF Dataset repository. Set server variable `FEEDBACK_HF_REPO=your-account/your-private-feedback` and server secret `FEEDBACK_HF_TOKEN` to a token permitted to read and write that repository. Keep both off the browser and out of Git. The app checks that the destination is private before saving. An unconfigured sample app reports that saving was not confirmed; it does not claim to save complaints locally.

An owner can export the text for review with those environment variables set:

```sh
node scripts/export-feedback.mjs > feedback-private.json
```

Keep the export private. Ask Codex to analyze the exported complaints, group recurring themes, cite representative feedback, and propose improvements for discussion. Choose changes together before implementation; feedback does not trigger automatic code changes. The inbox is limited to 2,000 records, with at most 120 confirmed submissions per server hour. Archive it privately before reaching that limit.

## Try the message simulator

After installing dependencies, run:

```sh
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). This separate simulator binds to localhost and sends **no real SMS or WhatsApp messages**. It uses fictitious events and coarse demo-city coordinates. Its fixed calendar date is **2026-10-05** so message examples are repeatable; browser searches use the current date instead.

The simulator generates its separate sample files in `work/demo-data`, so it can run alongside the browser without changing the browser's event dates.

Try `INFO`, then `Dallas TX`. Use **Preview 10 PM reminder** to inspect the weekend message. Demo locations include Dallas, Fort Worth, Austin, Las Vegas, Chicago, Houston, and Los Angeles with their state abbreviations. The fictional test sender is `+15550102026`; you do not need to enter your own number. Simulator registration and saved locations are stored locally in `work/show-finder.sqlite`.

| Message | Behavior |
| --- | --- |
| `INFO`, `SHOWS`, `START`, `JOIN` | Register the sender and request a location. |
| A location | Save or replace the location and time zone, enable reminders, and return nearby shows in the selected window. |
| `WEEKEND` | Return nearby upcoming Friday–Sunday shows using the saved location. |
| `FULL` | Return all dated future events across all locations, earliest date first, with no radius or date-window restriction. |
| `MORE` | Return the next page of the previous list while its ten-minute session is available. |
| `HELP`, `PRIVACY` | Explain commands or stored data. |
| `STOP` | Stop replies and automatic reminders. |
| `START` | Reactivate service. |
| `DELETE` | Remove registration, location, reminder history, cached replies, and the current session. |

Commands ignore case. SMS and WhatsApp use the same event-selection rules but keep separate registrations. `FULL` needs no saved location. Dated events without usable locations remain in `FULL`; nearby searches exclude them. The same festival grouping applies to replies and reminders.

## Messaging deployment

Real messaging requires a Twilio account, an SMS sender, an approved WhatsApp sender, an HTTPS webhook, location/time-zone lookup credentials, and durable database storage. Those services may incur charges. The browser app works without them.

The hosted entry point keeps messaging disabled until its configuration is complete and `HOSTED_SERVICE_ENABLED=true` is explicitly set. Keep credentials in local environment variables or your host's secret manager. Never put credentials in browser code or commit them. Configure incoming Twilio requests as **POST** to your deployment's exact `https://your-domain.example/webhooks/twilio` URL. Live requests validate the Twilio signature and account identity; the unsigned simulator is available only on localhost.

Configuration names and blank credential fields are documented in [`.env.example`](.env.example). Messaging uses Google's Geocoding and Time Zone APIs; browser discovery defaults to the offline directory. Set `APP_MODE=live`, the Twilio account/token and sender values, `GOOGLE_MAPS_API_KEY`, and `PUBLIC_WEBHOOK_URL` for a live messaging server. With reminders enabled, `WHATSAPP_REMINDER_CONTENT_SID` must identify an approved template with location, weekend dates, and show summary as its three variables:

```text
Weekend shows near {{1}} for {{2}}: {{3}}
In a different town? Send your location again to update it.
Reply WEEKEND for the full list. STOP to opt out.
```

Active users with a saved location receive at most one reminder per local date around **10 PM**. The worker checks each minute and sends during the ten-minute window from 22:00 through 22:09 in that location's IANA time zone. Monday–Thursday uses the coming weekend; Friday–Sunday uses the current weekend and omits earlier dates. Days without matching shows are skipped by default. Updating a location updates its time zone, including daylight-saving behavior.

The server must be running during that window. Durable SQLite delivery claims prevent duplicate reminder attempts after a restart; downtime beyond the window skips that day's reminder. An outbound response such as `queued` means accepted for processing, not confirmed delivery. Verify final delivery in Twilio's logs. Test registration, location updates, `WEEKEND`, `FULL`, reminders, `STOP`, and `DELETE` with your own phone before opening a private deployment to users.

See [Twilio's WhatsApp sender setup](https://www.twilio.com/docs/whatsapp/self-sign-up), [template sending](https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates), and [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security). `INFO` can be intercepted as a Twilio help keyword; `SHOWS` is an alternative registration keyword.

## Hosting and contributing

The Docker image exposes port **7860** and runs the browser service independently of messaging. Generic Hugging Face Docker Space instructions are in [`deploy/huggingface/README.md`](deploy/huggingface/README.md). Configure your own Space and endpoint; no deployment account is bundled.

Run the automated tests and syntax checks before submitting a change:

```sh
npm run build:feedback
npm test
npm run check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the public sample-data boundary and useful areas to improve. Private deployments can supply their own authorized event sources; contributions should use fictitious fixtures and avoid private listings or credentials.

Code is licensed under the [MIT License](LICENSE). The GeoNames city/ZIP directory is separate data licensed under **CC BY 4.0**; its attribution is in [`data/GEONAMES-LICENSE.md`](data/GEONAMES-LICENSE.md).
