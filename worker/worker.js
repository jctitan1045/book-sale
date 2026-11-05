// book-sale-worker
// Backend for Jordan's book sale: WhatsApp photo intake (forwarded by daily-assistant-webhook)
// -> AI-drafted book listing priced on the rarity x condition scale, public storefront API,
// admin review API. Checkout is a wa.me link built client-side, so there's no checkout route.

const DEFAULT_FX_RATE = 4000; // COP per USD, admin-editable via /api/admin/config
const MODEL = "claude-sonnet-5-5";
// A sender's most-recent draft stays the "reference" a new incoming photo is compared
// against for this long (back cover / copyright page of the same book). Grouping is
// decided by the vision model, not by this window.
const RECENT_DRAFT_WINDOW_MS = 15 * 60 * 1000;

// --- Pricing scale ---
// Identical copy lives in docs/js/pricing.js (storefront legend + admin price helper).
// Keep the two in sync.
// Cut ~15% from the original 30k/45k/80k/150k on 2026-11-03 (Jordan: "at least 10-20% lower").
const RARITY_BASE_COP = { common: 25000, uncommon: 38000, scarce: 68000, collectible: 125000 };
const FORMAT_FACTOR = { paperback: 1, hardcover: 1.5, mass_market: 0.75 };
const CONDITION_FACTOR = { like_new: 1, very_good: 0.85, good: 0.7, fair: 0.5, poor: 0.3 };
const GENRES = ["business", "self_help", "psychology", "health", "spirituality", "biography", "history", "philosophy", "science", "fiction", "kids", "language", "other"];
const STATUSES = ["draft", "available", "reserved", "sold"];

// Round numbers only (Jordan, 2026-11-04): nearest 10,000 COP, minimum 10,000.
function roundPrice(n) {
  return Math.max(10000, Math.round(n / 10000) * 10000);
}

function scalePrice(rarity, format, condition) {
  const base = RARITY_BASE_COP[rarity] || RARITY_BASE_COP.common;
  const f = FORMAT_FACTOR[format] || 1;
  const c = CONDITION_FACTOR[condition] || CONDITION_FACTOR.good;
  return roundPrice(base * f * c);
}

// Collectible copies are priced individually: the scale gives a floor, the AI's comps
// estimate (discounted by the same ~15% as the scale) can raise it.
function suggestedPrice(b) {
  const scale = scalePrice(b.rarity, b.format, b.condition);
  const estimate = roundPrice((b.collectible_estimate_cop || 0) * 0.85);
  if (b.rarity === "collectible" && estimate > scale) return estimate;
  return scale;
}

// ALLOWED_ORIGIN is a comma-separated list (the Pages site + the local preview server);
// echo back whichever one this request came from.
let requestOrigin = "";

function corsHeaders(env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(requestOrigin) ? requestOrigin : allowed[0],
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function isAdminAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

// Chunked base64 encoding — a plain spread/apply over a multi-MB Uint8Array
// blows the call-stack argument limit, so encode in slices and concatenate.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sendWhatsApp(to, body, env) {
  if (!to) return null;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: env.TWILIO_FROM, To: to, Body: body }),
  });
  const data = await resp.json();
  return { status: resp.status, sid: data.sid, error_code: data.error_code, error_message: data.message };
}

async function getListing(id, env) {
  const raw = await env.KV.get(`listing:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveListing(listing, env) {
  await env.KV.put(`listing:${listing.id}`, JSON.stringify(listing));
}

async function listListings(env) {
  const { keys } = await env.KV.list({ prefix: "listing:" });
  const listings = await Promise.all(keys.map(async (k) => {
    const raw = await env.KV.get(k.name);
    return raw ? JSON.parse(raw) : null;
  }));
  return listings.filter(Boolean);
}

async function getConfig(env) {
  const [fx, auto] = await Promise.all([env.KV.get("config:fx_rate"), env.KV.get("config:auto_publish")]);
  return { fx_rate: fx ? parseFloat(fx) : DEFAULT_FX_RATE, auto_publish: auto === "true" };
}

function toUsd(cop, fxRate) {
  return Math.round((cop / fxRate) * 100) / 100;
}

// --- Photo intake -> AI draft listing ---

const BOOK_TOOL = {
  name: "create_book_listing",
  description: "Create a used-book listing draft from a photo of a book.",
  input_schema: {
    type: "object",
    properties: {
      is_same_item_as_reference: { type: "boolean", description: "Only meaningful when a REFERENCE PHOTO is included: true if the NEW PHOTO shows the SAME physical copy of the same book (another angle, the back cover, the spine, the copyright page), false if it is a different book. Two copies of the same title are different items. If no reference photo was provided, set false." },
      title: { type: "string", description: "Book title as printed on the book, in its original language. Include a subtitle only if it is short." },
      author: { type: "string", description: "Author name(s) as printed. Empty string if not visible and you can't identify the book." },
      genre: { type: "string", enum: GENRES },
      language: { type: "string", enum: ["english", "spanish", "other"], description: "Language the book is written in" },
      format: { type: "string", enum: ["paperback", "hardcover", "mass_market"], description: "mass_market = small pocket-size paperback" },
      condition: { type: "string", enum: Object.keys(CONDITION_FACTOR) },
      rarity: { type: "string", enum: Object.keys(RARITY_BASE_COP) },
      rarity_reason: { type: "string", description: "One short clause naming the concrete reason for the rarity tier, e.g. 'Bestseller, still in print' or 'Signed on the title page'" },
      edition_notes: { type: "string", description: "Anything notable about this specific copy a buyer should know: signed, first edition, special/illustrated edition, box set. Empty string if nothing notable." },
      description_en: { type: "string", description: "Never empty. Two short sentences in English: what the book is about, then the condition of this copy" },
      description_es: { type: "string", description: "Never empty. The same two sentences in natural Colombian Spanish" },
      collectible_estimate_cop: { type: "integer", description: "Only for rarity=collectible: what comparable copies sell for, in Colombian pesos. 0 otherwise." },
    },
    required: ["title", "author", "genre", "language", "format", "condition", "rarity", "rarity_reason", "edition_notes", "description_en", "description_es"],
  },
};

const BOOK_PROMPT = `You're drafting a listing for a used book Jordan is selling from his personal library in Medellín, Colombia. Identify the book from the photo (cover, spine, back cover or copyright page) and call create_book_listing.

Condition, using standard used-book grades:
- like_new: no visible wear, looks unread
- very_good: light shelf wear, clean pages, no markings
- good: a read copy; creased spine or soft corners, pages intact
- fair: heavy wear, highlighting or notes, stains, but complete
- poor: damaged; a reading copy only
Judge only what the photo shows. If you can't see enough to tell, use good.

Rarity, meaning how hard this copy is to replace:
- common: in print and easy to buy new. Bestsellers and most popular nonfiction. This is the default.
- uncommon: still obtainable but niche or imported, or out of print with cheap used copies widely available
- scarce: out of print and genuinely hard to find; older or limited editions
- collectible: signed, a true first edition/first printing of a notable title, or a special/limited edition
Only go above common when you can name a concrete reason in rarity_reason. Never claim signed or first edition unless the photo or the seller's caption shows it.

Descriptions are read by buyers: one plain sentence on what the book is about (no hype words, no spoilers), one short sentence on the condition of this copy. Never mention the photo, the caption, or how you decided the grade. Spanish should read like a Colombian wrote it, not a word-for-word translation.`;

// One vision call. When `reference` is supplied (the sender's most recent draft), the model
// also decides whether the new photo is the SAME copy via is_same_item_as_reference.
async function analyzePhoto({ base64Image, contentType, caption, reference, correction }, env) {
  let promptText = BOOK_PROMPT;
  if (caption && caption.trim()) {
    promptText += `\n\nCaption from Jordan (he's holding the book — trust it over the photo): "${caption.trim()}"`;
  }
  if (correction && correction.trim()) {
    promptText += `\n\nIMPORTANT — Jordan reviewed a previous AI draft of THIS EXACT book and says it was wrong. His correction: "${correction.trim()}". Produce a corrected listing that fully addresses it. Where the correction conflicts with the photo, trust Jordan.`;
  }

  const content = [];
  if (reference) {
    promptText += `\n\nA REFERENCE PHOTO of a book already being drafted ("${reference.title}") is included first, then the NEW PHOTO. First decide whether the NEW PHOTO is the same physical copy (another side of it) or a different book. Then fill in the remaining fields for the NEW PHOTO's book — if it's the same copy, use both photos to get title, edition and condition right.`;
    content.push({ type: "text", text: "REFERENCE PHOTO (book already being drafted):" });
    content.push({ type: "image", source: { type: "base64", media_type: reference.contentType, data: reference.base64 } });
    content.push({ type: "text", text: "NEW PHOTO:" });
  }
  content.push({ type: "image", source: { type: "base64", media_type: contentType, data: base64Image } });
  content.push({ type: "text", text: `${promptText}\n\nRespond only by calling create_book_listing.` });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      // The model thinks before calling the tool (~1k output tokens observed); a tight
      // cap truncates the tool input and silently drops the descriptions.
      max_tokens: 4000,
      tools: [BOOK_TOOL],
      // This model rejects forced tool_choice ("tool"/"any"); the prompt's last line asks
      // for the call instead, and a missing call falls back to a "Needs review" draft.
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    }),
  });

  const data = await resp.json();
  const toolUse = data?.content?.find((b) => b.type === "tool_use");
  return { parsed: toolUse?.input || null, rawText: toolUse ? "" : JSON.stringify(data?.content || data) };
}

// The AI-authored fields of a listing, from a parsed draft. Used for new drafts and re-drafts.
function aiFields(parsed, fxRate) {
  const book = {
    title: parsed.title,
    author: parsed.author || "",
    genre: GENRES.includes(parsed.genre) ? parsed.genre : "other",
    language: parsed.language || "english",
    format: FORMAT_FACTOR[parsed.format] ? parsed.format : "paperback",
    condition: CONDITION_FACTOR[parsed.condition] ? parsed.condition : "good",
    rarity: RARITY_BASE_COP[parsed.rarity] ? parsed.rarity : "common",
    rarity_reason: parsed.rarity_reason || "",
    edition_notes: parsed.edition_notes || "",
    description_en: parsed.description_en || "",
    description_es: parsed.description_es || parsed.description_en || "",
    collectible_estimate_cop: parsed.collectible_estimate_cop || 0,
  };
  book.price_suggested_cop = suggestedPrice(book);
  book.price_cop = book.price_suggested_cop;
  book.price_usd = toUsd(book.price_cop, fxRate);
  return book;
}

// Assembles a listing record. Falls back to a blank "Needs review" draft when the AI output
// didn't parse, so a photo is never lost.
function buildListing({ id, imageKeys, parsed, rawText, from, fxRate }) {
  const base = { id, inventory: 1, image_keys: imageKeys, status: "draft", created_at: new Date().toISOString(), source_phone: from || "" };
  if (parsed && parsed.title) return { ...base, ...aiFields(parsed, fxRate) };
  return {
    ...base,
    title: "Needs review",
    author: "",
    genre: "other",
    language: "english",
    format: "paperback",
    condition: "good",
    rarity: "common",
    rarity_reason: "",
    edition_notes: "",
    description_en: rawText ? `AI output could not be parsed: ${rawText.slice(0, 300)}` : "AI did not return a description.",
    description_es: "",
    price_suggested_cop: scalePrice("common", "paperback", "good"),
    price_cop: scalePrice("common", "paperback", "good"),
    price_usd: toUsd(scalePrice("common", "paperback", "good"), fxRate),
  };
}

function imagesOfListing(l) {
  return l.image_keys && l.image_keys.length ? l.image_keys : [];
}

function tokens(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9áéíóúñü\s]/gi, "").split(/\s+/).filter((t) => t.length > 1);
}

// Same author + strongly overlapping title among unsold listings = probably the same book
// sent twice, or a second copy (in which case Jordan bumps inventory instead).
async function findPossibleDuplicates(listing, env, allListings) {
  let all = allListings;
  if (!all) {
    // A nice-to-have check must never lose a photo if the KV list quota is exhausted.
    try { all = await listListings(env); } catch { return []; }
  }
  const mine = new Set(tokens(listing.title));
  if (!mine.size) return [];
  const author = tokens(listing.author).join(" ");
  return all.filter((o) => {
    if (o.id === listing.id || o.status === "sold") return false;
    if (author && tokens(o.author).join(" ") !== author) return false;
    const theirs = tokens(o.title);
    if (!theirs.length) return false;
    const overlap = theirs.filter((t) => mine.has(t)).length;
    return overlap / Math.max(mine.size, theirs.length) >= 0.6;
  }).map((o) => o.id);
}

function fmtCop(n) {
  return `${Number(n).toLocaleString("en-US")} COP`;
}

// Shared by WhatsApp intake and admin upload. `notify` gets the confirmation text
// (a WhatsApp reply for intake, nothing for admin uploads, which show the result inline).
async function draftFromImage({ imageBuffer, contentType, from, caption, notify }, env) {
  const id = crypto.randomUUID();
  await env.KV.put(`image:${id}`, imageBuffer, { metadata: { contentType } });
  const base64Image = arrayBufferToBase64(imageBuffer);

  // Content-based grouping: compare against this sender's most recent book and let the
  // model decide whether the new photo is another side of the same copy.
  let referenceListing = null;
  let reference = null;
  if (from) {
    const ptrRaw = await env.KV.get(`recent_draft:${from}`);
    if (ptrRaw) {
      const cand = await getListing(JSON.parse(ptrRaw).listingId, env);
      if (cand && cand.status !== "sold") {
        const refKey = imagesOfListing(cand)[0];
        const refImg = refKey ? await env.KV.getWithMetadata(`image:${refKey}`, { type: "arrayBuffer" }) : null;
        if (refImg && refImg.value) {
          referenceListing = cand;
          reference = { base64: arrayBufferToBase64(refImg.value), contentType: refImg.metadata?.contentType || "image/jpeg", title: cand.title };
        }
      }
    }
  }

  const { parsed, rawText } = await analyzePhoto({ base64Image, contentType, caption, reference }, env);
  const config = await getConfig(env);

  if (referenceListing && parsed && parsed.is_same_item_as_reference === true) {
    referenceListing.image_keys = [...imagesOfListing(referenceListing), id];
    // A second side (copyright page, signature) can reveal edition details the cover didn't.
    if (parsed.edition_notes && !referenceListing.edition_notes) referenceListing.edition_notes = parsed.edition_notes;
    await saveListing(referenceListing, env);
    await env.KV.put(`recent_draft:${from}`, JSON.stringify({ listingId: referenceListing.id }), { expirationTtl: Math.ceil(RECENT_DRAFT_WINDOW_MS / 1000) });
    if (notify) await notify(`📸 Extra photo added to "${referenceListing.title}"`);
    return referenceListing;
  }

  const listing = buildListing({ id, imageKeys: [id], parsed, rawText, from, fxRate: config.fx_rate });
  listing.possible_duplicate_of = await findPossibleDuplicates(listing, env);
  // Auto-publish skips review, but never for a failed parse or a likely duplicate.
  if (config.auto_publish && parsed && !listing.possible_duplicate_of.length) listing.status = "available";
  await saveListing(listing, env);

  if (from) {
    await env.KV.put(`recent_draft:${from}`, JSON.stringify({ listingId: listing.id }), { expirationTtl: Math.ceil(RECENT_DRAFT_WINDOW_MS / 1000) });
  }

  // One line per photo; flushReplies() bundles a burst into a single WhatsApp message.
  if (notify) {
    if (!parsed && /credit balance/i.test(rawText)) {
      await notify(`⚠️ Out of AI credits, photo saved. Top up at https://console.anthropic.com/settings/billing, then "Retry AI" in admin`);
    } else if (!parsed) {
      await notify(`⚠️ Couldn't read one book, blank draft saved`);
    } else {
      const by = listing.author ? `, ${listing.author}` : "";
      const edition = listing.edition_notes ? " ✨" : "";
      const dup = listing.possible_duplicate_of.length ? " (already listed?)" : "";
      const live = listing.status === "available" ? " ✅" : "";
      await notify(`📚 ${listing.title}${by} · ${listing.condition.replace("_", " ")} · ${fmtCop(listing.price_cop)}${edition}${dup}${live}`);
    }
  }

  return listing;
}

// Called by daily-assistant-webhook over a service binding (JSON body, internal secret).
// That worker has already checked the Twilio signature and that the sender is Jordan.
async function handleTwilioIntake(request, env, ctx) {
  if (request.headers.get("X-Internal-Secret") !== env.INTERNAL_FORWARD_SECRET) {
    return jsonResponse({ error: "unauthorized" }, 401, env);
  }
  const { from, body, media } = await request.json();
  if (!Array.isArray(media) || !media.length) return jsonResponse({ error: "no media" }, 400, env);

  // Sequential, so a multi-photo message groups against the draft the previous photo made.
  ctx.waitUntil((async () => {
    for (const m of media) await draftFromTwilioMedia({ url: m.url, contentType: m.contentType, from, caption: body }, env);
  })());

  return jsonResponse({ ok: true }, 200, env);
}

async function draftFromTwilioMedia({ url, contentType, from, caption }, env) {
  const notify = (text) => queueReply(from, text, env);
  const twilioAuth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const mediaResp = await fetch(url, { headers: { "Authorization": `Basic ${twilioAuth}` } });
  if (!mediaResp.ok) {
    await notify(`⚠️ Couldn't download one photo from WhatsApp (status ${mediaResp.status}), please resend it`);
    return null;
  }
  return draftFromImage({ imageBuffer: await mediaResp.arrayBuffer(), contentType: contentType || "image/jpeg", from, caption, notify }, env);
}

// --- Batched WhatsApp replies ---
// A reply per photo doubled the traffic between Jordan and the line, and a fast burst
// tripped Twilio's runaway-loop protection (error 14107), which then dropped his photos.
// Each reply line is queued as its own KV key (no read-modify-write races between
// concurrent photos); the cron flushes a sender's queue as ONE message once they've
// gone quiet for REPLY_QUIET_MS.
const REPLY_QUIET_MS = 45 * 1000;
const WHATSAPP_MAX_CHARS = 1500;

async function queueReply(to, text, env) {
  if (!to) return;
  await env.KV.put(`reply:${to}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`, text, { expirationTtl: 24 * 3600 });
  await env.KV.put("reply_due", String(Date.now()), { expirationTtl: 24 * 3600 });
}

// The cron fires 1,440 times a day, and KV's free tier allows only 1,000 list() calls a day
// across the whole Cloudflare account. So it checks one flag key (reads are cheap) and only
// lists when replies are actually waiting. Listing every minute took down this store and
// moving-sale on 2026-11-03.
async function flushReplies(env) {
  const due = await env.KV.get("reply_due");
  if (!due || Date.now() - parseInt(due, 10) < REPLY_QUIET_MS) return;

  const { keys } = await env.KV.list({ prefix: "reply:" });
  if (!keys.length) {
    await env.KV.delete("reply_due");
    return;
  }
  const bySender = new Map();
  for (const k of keys) {
    // reply:{to}:{ts}:{rand} — `to` contains a colon ("whatsapp:+1..."), so split from the right.
    const parts = k.name.split(":");
    const ts = parseInt(parts[parts.length - 2], 10);
    const to = parts.slice(1, -2).join(":");
    if (!bySender.has(to)) bySender.set(to, []);
    bySender.get(to).push({ name: k.name, ts });
  }

  for (const [to, items] of bySender) {
    if (Date.now() - Math.max(...items.map((i) => i.ts)) < REPLY_QUIET_MS) continue; // still sending
    items.sort((a, b) => a.ts - b.ts);
    const lines = (await Promise.all(items.map((i) => env.KV.get(i.name)))).filter(Boolean);

    const books = lines.filter((l) => l.startsWith("📚")).length;
    const header = books ? `Got ${books} book${books > 1 ? "s" : ""}:` : "Update:";
    const footer = `\nReview: ${env.STOREFRONT_URL}/admin.html`;
    let body = header;
    let shown = 0;
    for (const line of lines) {
      if ((body + "\n" + line + footer).length > WHATSAPP_MAX_CHARS - 30) break;
      body += "\n" + line;
      shown++;
    }
    if (shown < lines.length) body += `\n…and ${lines.length - shown} more`;

    const result = await sendWhatsApp(to, body + footer, env);
    // Keep the queue if Twilio refused, so the next run retries; drop it once sent.
    if (result && result.status < 300) await Promise.all(items.map((i) => env.KV.delete(i.name)));
  }

  // Clear the flag unless a new photo arrived while this ran.
  if ((await env.KV.get("reply_due")) === due) await env.KV.delete("reply_due");
}

// --- Public storefront API ---

// Every store page load used to cost one KV list() (free tier: 1,000/day, account-wide) plus
// one read per book. Serve a snapshot instead, rebuilt at most every 5 minutes, and keep
// serving the last good one if the rebuild fails, so a quota hit can't take the store down.
const STORE_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

async function handleGetListings(env) {
  const raw = await env.KV.get("cache:store_snapshot");
  const snapshot = raw ? JSON.parse(raw) : null;
  if (snapshot && Date.now() - snapshot.at < STORE_SNAPSHOT_MAX_AGE_MS) return jsonResponse(snapshot.books, 200, env);

  let listings;
  try {
    listings = await listListings(env);
  } catch (err) {
    if (snapshot) return jsonResponse(snapshot.books, 200, env);
    throw err;
  }
  // Only what a buyer needs; source_phone and AI reasoning stay admin-side.
  const visible = listings
    .filter((l) => l.status === "available" || l.status === "reserved")
    .map(({ source_phone, rarity_reason, collectible_estimate_cop, possible_duplicate_of, price_suggested_cop, ...pub }) => pub);
  await env.KV.put("cache:store_snapshot", JSON.stringify({ at: Date.now(), books: visible }));
  return jsonResponse(visible, 200, env);
}

async function handleGetImage(id, env) {
  const result = await env.KV.getWithMetadata(`image:${id}`, { type: "arrayBuffer" });
  if (!result || !result.value) return new Response("Not found", { status: 404, headers: corsHeaders(env) });
  return new Response(result.value, {
    status: 200,
    headers: { "Content-Type": result.metadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=86400", ...corsHeaders(env) },
  });
}

// --- Admin API ---

async function handleAdminListings(env) {
  return jsonResponse(await listListings(env), 200, env);
}

// Admin upload from the laptop: raw image body, same drafting path as WhatsApp.
async function handleAdminUpload(request, env) {
  const contentType = request.headers.get("Content-Type") || "image/jpeg";
  const imageBuffer = await request.arrayBuffer();
  if (!imageBuffer.byteLength) return jsonResponse({ error: "no image data" }, 400, env);
  const caption = new URL(request.url).searchParams.get("caption") || "";
  // `from` = "admin" so consecutive uploads still group back/front covers of the same copy.
  const listing = await draftFromImage({ imageBuffer, contentType, from: "admin", caption, notify: null }, env);
  return jsonResponse(listing, 200, env);
}

async function handlePatchListing(id, request, env) {
  const listing = await getListing(id, env);
  if (!listing) return jsonResponse({ error: "not found" }, 404, env);

  const updates = await request.json();
  if (updates.status && !STATUSES.includes(updates.status)) return jsonResponse({ error: "bad status" }, 400, env);
  const merged = { ...listing, ...updates };
  const { fx_rate } = await getConfig(env);

  if (updates.rarity !== undefined || updates.format !== undefined || updates.condition !== undefined) {
    merged.price_suggested_cop = suggestedPrice(merged);
  }
  if (updates.price_cop !== undefined) merged.price_usd = toUsd(merged.price_cop, fx_rate);
  if (updates.sold_price_cop !== undefined) merged.sold_price_usd = toUsd(updates.sold_price_cop, fx_rate);
  if (updates.status === "sold" && !listing.sold_at) merged.sold_at = new Date().toISOString();

  await saveListing(merged, env);
  return jsonResponse(merged, 200, env);
}

async function handleAddPhoto(id, request, env) {
  const listing = await getListing(id, env);
  if (!listing) return jsonResponse({ error: "not found" }, 404, env);
  const imageBuffer = await request.arrayBuffer();
  if (!imageBuffer.byteLength) return jsonResponse({ error: "no image data" }, 400, env);

  const imageId = crypto.randomUUID();
  await env.KV.put(`image:${imageId}`, imageBuffer, { metadata: { contentType: request.headers.get("Content-Type") || "image/jpeg" } });
  listing.image_keys = [...imagesOfListing(listing), imageId];
  await saveListing(listing, env);
  return jsonResponse(listing, 200, env);
}

// `?images=a,b` names exactly which photos to delete (empty = keep them all, used by Split).
// The admin client sends it because a KV read right after a write can be stale: looking the
// listing up here sometimes found nothing and left its photos behind as orphans.
async function handleDeleteListing(id, request, env) {
  const param = new URL(request.url).searchParams.get("images");
  let imageKeys;
  if (param !== null) imageKeys = param.split(",").filter(Boolean);
  else {
    const listing = await getListing(id, env);
    imageKeys = listing ? imagesOfListing(listing) : [];
  }
  await env.KV.delete(`listing:${id}`);
  await Promise.all(imageKeys.map((imgId) => env.KV.delete(`image:${imgId}`)));
  return jsonResponse({ ok: true }, 200, env);
}

// Pulls one photo out of an over-grouped listing into its own draft. The admin client calls
// this once per photo, then detaches the images from the original and deletes it.
async function handleSplitPhoto(request, env) {
  const { image_key } = await request.json();
  if (!image_key) return jsonResponse({ error: "image_key required" }, 400, env);
  const img = await env.KV.getWithMetadata(`image:${image_key}`, { type: "arrayBuffer" });
  if (!img || !img.value) return jsonResponse({ error: "image not found" }, 404, env);

  const { parsed, rawText } = await analyzePhoto({ base64Image: arrayBufferToBase64(img.value), contentType: img.metadata?.contentType || "image/jpeg", caption: "", reference: null }, env);
  const { fx_rate } = await getConfig(env);
  const listing = buildListing({ id: crypto.randomUUID(), imageKeys: [image_key], parsed, rawText, from: "", fxRate: fx_rate });
  listing.possible_duplicate_of = await findPossibleDuplicates(listing, env);
  await saveListing(listing, env);
  return jsonResponse(listing, 200, env);
}

// Re-draft from the listing's own photos plus Jordan's note on what the last attempt got
// wrong. Overwrites AI-authored fields and the price; keeps id, photos, status, inventory.
async function handleRedraftListing(id, request, env) {
  const listing = await getListing(id, env);
  if (!listing) return jsonResponse({ error: "not found" }, 404, env);
  // An empty note is a plain retry (e.g. a draft that failed because the AI call errored).
  const { note = "" } = await request.json();

  const imgKey = imagesOfListing(listing)[0];
  const img = imgKey ? await env.KV.getWithMetadata(`image:${imgKey}`, { type: "arrayBuffer" }) : null;
  if (!img || !img.value) return jsonResponse({ error: "listing has no photo to re-analyze" }, 400, env);

  const { parsed, rawText } = await analyzePhoto({ base64Image: arrayBufferToBase64(img.value), contentType: img.metadata?.contentType || "image/jpeg", caption: "", reference: null, correction: note.trim() }, env);
  if (!parsed || !parsed.title) {
    const error = /credit balance/i.test(rawText) ? "The AI account is out of credits. Top up at console.anthropic.com, then retry." : "AI could not re-draft this book";
    return jsonResponse({ error, detail: rawText.slice(0, 200) }, 502, env);
  }

  const { fx_rate } = await getConfig(env);
  const updated = { ...listing, ...aiFields(parsed, fx_rate) };
  updated.possible_duplicate_of = await findPossibleDuplicates(updated, env);
  await saveListing(updated, env);
  return jsonResponse(updated, 200, env);
}

async function handlePatchConfig(request, env) {
  const updates = await request.json();
  if (updates.fx_rate) await env.KV.put("config:fx_rate", String(updates.fx_rate));
  if (updates.auto_publish !== undefined) await env.KV.put("config:auto_publish", updates.auto_publish ? "true" : "false");
  return jsonResponse(await getConfig(env), 200, env);
}

export default {
  // Every minute (wrangler.toml [triggers]): send any batched WhatsApp replies.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(flushReplies(env));
  },

  async fetch(request, env, ctx) {
    requestOrigin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });

    const path = new URL(request.url).pathname;
    const admin = path.startsWith("/api/admin/");
    if (admin && !isAdminAuthorized(request, env)) return jsonResponse({ error: "unauthorized" }, 401, env);

    try {
      if (request.method === "POST" && path === "/twilio-intake") return await handleTwilioIntake(request, env, ctx);
      if (request.method === "GET" && path === "/api/listings") return await handleGetListings(env);
      if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/images/")) return await handleGetImage(path.replace("/images/", ""), env);

      if (request.method === "GET" && path === "/api/admin/listings") return await handleAdminListings(env);
      if (request.method === "POST" && path === "/api/admin/upload") return await handleAdminUpload(request, env);
      if (request.method === "POST" && path === "/api/admin/split-photo") return await handleSplitPhoto(request, env);
      // Re-ingest a WhatsApp photo Twilio still holds (e.g. one dropped by error 14107).
      // Synchronous, so no waitUntil time limit; replies are queued like normal intake.
      if (request.method === "POST" && path === "/api/admin/import-twilio-media") {
        const { url, contentType, from, caption } = await request.json();
        if (!url || !url.startsWith("https://api.twilio.com/")) return jsonResponse({ error: "twilio media url required" }, 400, env);
        const listing = await draftFromTwilioMedia({ url, contentType, from, caption: caption || "" }, env);
        return listing ? jsonResponse(listing, 200, env) : jsonResponse({ error: "download failed" }, 502, env);
      }
      if (request.method === "GET" && path === "/api/admin/config") return jsonResponse(await getConfig(env), 200, env);
      if (request.method === "PATCH" && path === "/api/admin/config") return await handlePatchConfig(request, env);

      if (path.startsWith("/api/admin/listings/")) {
        const rest = path.replace("/api/admin/listings/", "");
        if (request.method === "POST" && rest.endsWith("/photos")) return await handleAddPhoto(rest.replace("/photos", ""), request, env);
        if (request.method === "POST" && rest.endsWith("/redraft")) return await handleRedraftListing(rest.replace("/redraft", ""), request, env);
        if (request.method === "PATCH") return await handlePatchListing(rest, request, env);
        if (request.method === "DELETE") return await handleDeleteListing(rest, request, env);
      }

      return jsonResponse({ error: "not found" }, 404, env);
    } catch (err) {
      return jsonResponse({ error: "internal error", message: String(err) }, 500, env);
    }
  },
};
