# Contributing to Rave Now

The public repository is a runnable browser demo and a local SMS/WhatsApp simulator using fictitious events. Private event feeds, deployed account settings, credentials, and user records stay outside this project.

## Local development

1. Fork the repository and create a branch for your change.
2. Install Node.js 24 or later and run `npm install` from the project root.
3. Run `npm run browser` and open `http://localhost:7860` for the browser app. This command regenerates current-date sample events.
4. Run `npm start` and open `http://127.0.0.1:8787` for the local message simulator. Its calendar date is fixed at `2026-10-05` and it sends no real messages.
5. Run `npm test` and `npm run check` before opening a pull request.

Keep pull requests focused on one problem. Explain the resulting behavior and how you checked it. Include screenshots when changing the browser layout. Add or update meaningful tests when behavior changes, especially date boundaries, ambiguous locations, event grouping, input validation, and message-delivery state.

## Useful improvements

- Improve keyboard, screen-reader, mobile, and location-permission flows.
- Make city/artist ambiguity and approximate distances easier to understand.
- Expand fictitious fixtures for time zones, month boundaries, festival occurrences, and missing locations.
- Improve error recovery, pagination, and duplicate-message handling.
- Add source adapters behind the existing event-source boundary using documented, authorized APIs and fictitious test responses.
- Improve deployment documentation and configuration validation without adding account-specific defaults.

Discuss a substantial dependency, storage migration, provider sign-in, or AI integration in an issue before building it. Saved profile URLs currently do not authenticate users or import listening history; do not label a feature as connected or personalized until it works and its provider access is established.

## Public data and secret boundary

Use fictitious event and user data in examples and tests. Sample ticket links must remain clear placeholders. Do not add real tracker snapshots, personal phone numbers, precise user locations, provider tokens, service-account files, private source URLs or IDs, `.env` files, or runtime databases. Configure any private deployment through its own environment and secret manager.

Keep source retrieval separate from event parsing, searching, and presentation. Tests should inject fixtures instead of requiring a private account or contacting a live private feed. Browser code must not receive server credentials. Any future account integration must accurately describe what it imports and how users can disconnect and delete data.

## Licenses

Contributions to application code use the project's MIT License. The bundled GeoNames directory remains under CC BY 4.0 with its attribution in `data/GEONAMES-LICENSE.md`. Preserve that attribution and identify the license and source of any additional data or assets.
