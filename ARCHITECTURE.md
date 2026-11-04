# ARCHITECTURE

Forked from `moving-sale` (same cart → wa.me checkout, same photo → AI draft → admin review loop), with a book-specific data model and a deterministic pricing scale.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Static HTML/CSS/vanilla JS in `docs/`, GitHub Pages |
| Backend | Cloudflare Worker `book-sale-worker` |
| Storage | Cloudflare KV (`3d310744eb0545e297c34be7ac10f7a4`) |
| AI | Anthropic `claude-sonnet-5-5`, one vision call per photo |
| Messaging | Twilio WhatsApp line +17622660628 (shared with voice-notes and daily-assistant) |

## Photo intake path

WhatsApp → Twilio → `daily-assistant-webhook` (checks Twilio signature + sender is Jordan) → image messages go over the `BOOK_SALE` service binding to `POST /twilio-intake` (header `X-Internal-Secret` = `BOOK_SALE_SECRET` there, `INTERNAL_FORWARD_SECRET` here) → photo downloaded from Twilio, stored in KV, drafted, reply sent from the same line.

Audio on that line still goes to voice-notes; text still goes to the daily-assistant chat. The forwarding code lives in `../daily-assistant/worker.js` (not in git; deploy with `npx wrangler deploy` from that folder).

Unlike moving-sale, there's no public `/twilio-webhook` route, so nobody can trigger paid AI calls without the internal secret or the admin token.

## KV schema

- `listing:{id}` → `{ title, author, genre, language, format, condition, rarity, rarity_reason, edition_notes, description_en, description_es, collectible_estimate_cop, price_suggested_cop, price_cop, price_usd, inventory, image_keys[], possible_duplicate_of[], status: draft|available|reserved|sold, sold_price_cop?, sold_at?, created_at, source_phone }`
- `image:{id}` → raw bytes, `metadata.contentType`
- `recent_draft:{from}` → `{ listingId }`, 15-min TTL. The comparison anchor for the next photo; the model decides if it's the same copy.
- `config:fx_rate`, `config:auto_publish`

`GET /api/listings` returns available + reserved only and strips admin-only fields (`source_phone`, `rarity_reason`, AI estimates, dup flags).

## Pricing

AI assigns grades (condition, rarity, format); `scalePrice()` does the math. Keeping arithmetic out of the model makes prices consistent across books and easy to change in one table. Collectible: scale is a floor, `collectible_estimate_cop` from the model can raise it.

## Gotchas found while building

- `claude-sonnet-5-5` rejects forced `tool_choice` (`tool`/`any`). We use `auto` plus "Respond only by calling create_book_listing"; a missing call falls back to a "Needs review" draft.
- The model thinks before the tool call (~1k output tokens). With `max_tokens: 800` the tool input was truncated and descriptions came back empty. Now 4000.
- `~/Claude Code/.env`'s `TWILIO_AUTH_TOKEN` authenticates API calls but doesn't produce signatures daily-assistant accepts (probably the secondary token), so a simulated signed webhook gets 403. Real Twilio traffic passes. Test intake by calling `/twilio-intake` directly with the internal secret.
- Replies only deliver inside WhatsApp's 24h session window (error 63016 otherwise). Not an issue in practice since every reply follows a photo Jordan just sent.
- **Twilio error 14107 (runaway-loop protection):** a reply per photo doubled the traffic in a burst and Twilio started dropping inbound photos (36 lost on 2026-11-02, recovered from Twilio via `/api/admin/import-twilio-media`). Replies are now queued in KV (`reply:{to}:{ts}:{rand}`) and a 1-minute cron sends one summary after 45s of quiet.
- **Delete vs. stale KV reads:** deleting a listing right after creating it could read the listing as missing and leave its photos orphaned. Admin now passes `?images=` with the exact keys to delete.
- **Out of API credits:** Anthropic returns "credit balance is too low"; drafts become "Needs review" and the reply says so. "Retry AI" in admin re-reads them.
- **KV free tier: 1,000 `list()` calls a day, shared across the whole Cloudflare account.** A per-minute cron that called `list()` exhausted it on 2026-11-03 and took down this store, admin, and moving-sale until midnight UTC. Rules now: the cron reads a `reply_due` flag and lists only when replies are waiting; the storefront serves `cache:store_snapshot` (rebuilt at most every 5 minutes, last good copy served on failure), so the public store lags admin by up to 5 minutes. Don't add anything that lists on a timer or per visitor.
