// Book pricing scale: price = rarity base × format factor × condition factor, rounded to 1k COP.
// worker/worker.js carries an identical copy for AI drafts — keep the two in sync.
const RARITY = {
  common:      { base: 25000,  en: "Common",      es: "Común",        note: "In print and easy to buy new — bestsellers, popular nonfiction" },
  uncommon:    { base: 38000,  en: "Uncommon",    es: "Poco común",   note: "Niche or imported, or out of print but easy to find used" },
  scarce:      { base: 68000,  en: "Scarce",      es: "Escaso",       note: "Out of print and genuinely hard to find; older or limited editions" },
  collectible: { base: 125000, en: "Collectible", es: "De colección", note: "Signed, true first edition, or special edition — scale is a floor, priced individually" },
};
const FORMAT = {
  paperback:   { factor: 1,    en: "Paperback",   es: "Tapa blanda" },
  hardcover:   { factor: 1.5,  en: "Hardcover",   es: "Tapa dura" },
  mass_market: { factor: 0.75, en: "Pocket",      es: "Bolsillo" },
};
const CONDITION = {
  like_new:  { factor: 1,    en: "Like new",  es: "Como nuevo",  note: "No visible wear, looks unread" },
  very_good: { factor: 0.85, en: "Very good", es: "Muy bueno",   note: "Light shelf wear, clean pages" },
  good:      { factor: 0.7,  en: "Good",      es: "Bueno",       note: "Read copy — creased spine or soft corners" },
  fair:      { factor: 0.5,  en: "Fair",      es: "Aceptable",   note: "Heavy wear, highlighting or notes" },
  poor:      { factor: 0.3,  en: "Poor",      es: "Gastado",     note: "Damaged — reading copy only" },
};
const GENRES = {
  business:     { en: "Business",         es: "Negocios",            icon: "💼" },
  self_help:    { en: "Self-help",        es: "Desarrollo personal", icon: "🌱" },
  psychology:   { en: "Psychology",       es: "Psicología",          icon: "🧠" },
  health:       { en: "Health & fitness", es: "Salud",               icon: "💪" },
  spirituality: { en: "Spirituality",     es: "Espiritualidad",      icon: "🕊️" },
  biography:    { en: "Biography",        es: "Biografía",           icon: "👤" },
  history:      { en: "History",          es: "Historia",            icon: "🏛️" },
  philosophy:   { en: "Philosophy",       es: "Filosofía",           icon: "🤔" },
  science:      { en: "Science",          es: "Ciencia",             icon: "🔬" },
  fiction:      { en: "Fiction",          es: "Ficción",             icon: "📖" },
  kids:         { en: "Kids & YA",        es: "Infantil y juvenil",  icon: "🧸" },
  language:     { en: "Language learning", es: "Idiomas",            icon: "🗣️" },
  other:        { en: "Other",            es: "Otros",               icon: "📚" },
};
const LANGUAGES = { english: "English", spanish: "Español", other: "Other" };

function scalePrice(rarity, format, condition) {
  const base = (RARITY[rarity] || RARITY.common).base;
  const f = (FORMAT[format] || FORMAT.paperback).factor;
  const c = (CONDITION[condition] || CONDITION.good).factor;
  return Math.max(10000, Math.round((base * f * c) / 1000) * 1000);
}

// Bulk discounts by number of books in the cart (highest tier first). Applies to every
// book, collectibles included.
const BULK_TIERS = [
  { min: 20, pct: 25 },
  { min: 10, pct: 15 },
  { min: 5, pct: 10 },
];

function bulkTier(count) {
  return BULK_TIERS.find((t) => count >= t.min) || null;
}

function nextBulkTier(count) {
  return BULK_TIERS.slice().reverse().find((t) => count < t.min) || null;
}

// lines: [{ listing, qty }]. Discount rounds to the nearest 1,000 COP.
function bulkTotals(lines) {
  let count = 0, subtotal = 0, usd = 0;
  for (const { listing: l, qty } of lines) {
    count += qty;
    subtotal += l.price_cop * qty;
    usd += l.price_usd * qty;
  }
  const tier = bulkTier(count);
  const discount = tier ? Math.round((subtotal * tier.pct) / 100 / 1000) * 1000 : 0;
  const total = subtotal - discount;
  const totalUsd = subtotal ? Math.round(usd * (total / subtotal) * 100) / 100 : 0;
  return { count, subtotal, discount, total, totalUsd, tier, next: nextBulkTier(count) };
}

function bulkTiersHtml() {
  return BULK_TIERS.slice().reverse().map((t, i, arr) => {
    const upper = arr[i + 1] ? `–${arr[i + 1].min - 1}` : "+";
    return `<span class="tier-chip"><strong>${t.min}${upper} books</strong> ${t.pct}% off</span>`;
  }).join("");
}

function fmtK(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

// Rarity × condition grid for paperbacks, plus the format note. Used on the storefront
// ("How prices work") and in admin as a reference.
function priceScaleHtml() {
  const conds = Object.keys(CONDITION);
  const head = conds.map((c) => `<th>${CONDITION[c].en}<span class="es">${CONDITION[c].es}</span></th>`).join("");
  const rows = Object.keys(RARITY).map((r) => `
    <tr>
      <th class="row-head">${RARITY[r].en}<span class="es">${RARITY[r].es}</span><span class="note">${RARITY[r].note}</span></th>
      ${conds.map((c) => `<td>${fmtK(scalePrice(r, "paperback", c))}${r === "collectible" ? "+" : ""}</td>`).join("")}
    </tr>`).join("");
  return `
    <div class="scale-wrap">
      <table class="scale">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="scale-foot">Paperback prices in COP. Hardcover ×1.5, pocket size ×0.75. / Precios en COP para tapa blanda. Tapa dura ×1.5, bolsillo ×0.75.</p>
    <div class="scale-bulk">
      <div class="scale-bulk-title">Bulk discounts / Descuentos por cantidad</div>
      <div class="scale-bulk-chips">${bulkTiersHtml()}</div>
      <p class="scale-foot">Taken off the whole cart, every book included. / Se aplica a todo el carrito, todos los libros incluidos.</p>
    </div>
  `;
}
