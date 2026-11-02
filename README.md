# Book Sale

Storefront for selling Jordan's books in Medellín. Text a photo of a book to the WhatsApp line, AI drafts the listing (title, author, condition, rarity, format, price), review it in admin, buyers add books to a cart and send the list to Jordan on WhatsApp.

- Store: https://jctitan1045.github.io/book-sale/
- Admin: https://jctitan1045.github.io/book-sale/admin.html (token in `worker/.dev.vars`, `ADMIN_TOKEN`)
- Worker: https://book-sale-worker.jctitan.workers.dev

## Adding books

1. WhatsApp a photo of the book to **+1 762-266-0628**. One book per photo. A back cover or copyright-page photo sent right after gets attached to the same book.
2. Add a caption for anything the photo can't show: `signed`, `first edition`, `hardcover`, `pages highlighted`. The AI trusts the caption over the photo.
3. You get a reply with the draft and price. Open admin to fix and publish, or turn on **Auto-publish new books** to skip review (likely duplicates and unreadable photos still wait for review).

You can also upload photos from the laptop with **+ Upload photos** in admin.

## Statuses

| Status | Storefront |
|---|---|
| Draft | Hidden, waiting for review |
| Available | Shown, can be added to cart |
| Reserved | Shown greyed out with a "Reserved" ribbon, can't be added to cart |
| Sold | Hidden; kept in admin with the actual sale price |

## Pricing scale

`price = rarity base × format × condition`, rounded to 5,000 COP. The AI picks the grades, the worker does the math. In admin, changing any grade moves the price to the scale; you can still type any price.

| Rarity (paperback) | Like new | Very good | Good | Fair | Poor |
|---|---|---|---|---|---|
| Common: in print, easy to buy new | 30k | 25k | 20k | 15k | 10k |
| Uncommon: niche/imported, or OOP but cheap used | 45k | 40k | 30k | 25k | 15k |
| Scarce: OOP and hard to find, older/limited editions | 80k | 70k | 55k | 40k | 25k |
| Collectible: signed, true first edition, special edition | 150k+ | 130k+ | 105k+ | 75k+ | 45k+ |

Hardcover ×1.5, pocket/mass-market ×0.75. Collectible is a floor: the AI also estimates from comps and the higher number wins. Each admin card has a "Check AbeBooks" link for checking rarity before publishing.

### Bulk discounts

5–9 books 10% off, 10–19 books 15%, 20+ books 25% (`BULK_TIERS` in `docs/js/pricing.js`). Every book counts toward the tier; collectibles are never discounted. The cart shows the discount and a "add N more for X% off" nudge, and the WhatsApp message carries subtotal, discount and total. At 25% off, a 20k Common/Good book lands at ~15k, about what moving-sale books actually sold for.

The scale is defined twice and must stay in sync: `docs/js/pricing.js` (storefront + admin) and the top of `worker/worker.js` (AI drafts).

## Deploy

- Frontend: push to `main`, GitHub Pages serves `/docs`.
- Worker: `cd worker && npx wrangler deploy` (needs `CLOUDFLARE_API_TOKEN` from `~/Claude Code/.env`).
- Local preview: launch config `book-sale-docs` (port 4174; the worker allows that origin).
