# Book Sale

Storefront for selling Jordan's books in Medellín. Text a photo of a book to the WhatsApp line, AI drafts the listing (title, author, condition, rarity, format, price), review it in admin, buyers add books to a cart and send the list to Jordan on WhatsApp.

- Store: https://jctitan1045.github.io/book-sale/
- Admin: https://jctitan1045.github.io/book-sale/admin.html (token in `worker/.dev.vars`, `ADMIN_TOKEN`)
- Worker: https://book-sale-worker.jctitan.workers.dev

## Adding books

1. WhatsApp a photo of the book to **+1 762-266-0628**. One book per photo. A back cover or copyright-page photo sent right after gets attached to the same book.
2. Add a caption for anything the photo can't show: `signed`, `first edition`, `hardcover`, `pages highlighted`. The AI trusts the caption over the photo.
3. Once you pause for ~45 seconds you get ONE WhatsApp summary of everything you sent (one reply per photo tripped Twilio's spam block, error 14107, which dropped 36 photos on 2026-11-02). Open admin to fix and publish, or turn on **Auto-publish new books** to skip review (likely duplicates and unreadable photos still wait for review).

You can also upload photos from the laptop with **+ Upload photos** in admin.

## Statuses

| Status | Storefront |
|---|---|
| Draft | Hidden, waiting for review |
| Available | Shown, can be added to cart |
| Reserved | Shown greyed out with a "Reserved" ribbon, can't be added to cart |
| Sold | Hidden; kept in admin with the actual sale price |

## Pricing scale

`price = rarity base × format × condition`, rounded to 1,000 COP, minimum 10,000 COP (~$3). Lowered ~15% on 2026-11-03 so most books land at $3–10 USD. The AI picks the grades, the worker does the math. In admin, changing any grade moves the price to the scale; you can still type any price.

| Rarity (paperback) | Like new | Very good | Good | Fair | Poor |
|---|---|---|---|---|---|
| Common: in print, easy to buy new | 25k | 21k | 18k | 13k | 10k |
| Uncommon: niche/imported, or OOP but cheap used | 38k | 32k | 27k | 19k | 11k |
| Scarce: OOP and hard to find, older/limited editions | 68k | 58k | 48k | 34k | 20k |
| Collectible: signed, true first edition, special edition | 125k+ | 106k+ | 88k+ | 63k+ | 38k+ |

Hardcover ×1.5, pocket/mass-market ×0.75. Collectible is a floor: the AI also estimates from comps (discounted 15% like the scale) and the higher number wins. Each admin card has a "Check AbeBooks" link for checking rarity before publishing.

### Bulk discounts

5–9 books 10% off, 10–19 books 15%, 20+ books 25% (`BULK_TIERS` in `docs/js/pricing.js`). Applies to every book in the cart, collectibles included. The cart shows the discount and a "add N more for X% off" nudge, and the WhatsApp message carries subtotal, discount and total. 

The scale is defined twice and must stay in sync: `docs/js/pricing.js` (storefront + admin) and the top of `worker/worker.js` (AI drafts).

## Deploy

- Frontend: push to `main`, GitHub Pages serves `/docs`.
- Worker: `cd worker && npx wrangler deploy` (needs `CLOUDFLARE_API_TOKEN` from `~/Claude Code/.env`).
- Local preview: launch config `book-sale-docs` (port 4174; the worker allows that origin).
