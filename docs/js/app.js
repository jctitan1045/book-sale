const CART_KEY = "book_sale_cart";

let listings = [];
const expandedIds = new Set();
const carouselIndex = new Map();

function imagesOf(l) { return l.image_keys || []; }
function invOf(l) { return l.inventory || 1; }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function fmtCop(n) {
  return `$${Number(n).toLocaleString("en-US")} COP`;
}

function fmtUsd(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USD`;
}

// --- Cart (localStorage) ---

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCart(cart) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch {}
  renderCart();
  renderListings();
}

function addToCart(id) {
  const listing = listings.find((l) => l.id === id);
  if (!listing || listing.status !== "available") return;
  const cart = getCart();
  const next = (cart[id] || 0) + 1;
  if (next > invOf(listing)) return;
  cart[id] = next;
  saveCart(cart);
}

function setQty(id, qty) {
  const listing = listings.find((l) => l.id === id);
  const cart = getCart();
  if (qty <= 0) delete cart[id];
  else cart[id] = Math.min(qty, listing ? invOf(listing) : qty);
  saveCart(cart);
}

// Drops anything that sold or got reserved since it was added, so checkout never
// asks for a book that's gone.
function pruneCart() {
  const cart = getCart();
  let changed = false;
  for (const id of Object.keys(cart)) {
    const l = listings.find((x) => x.id === id);
    if (!l || l.status !== "available") { delete cart[id]; changed = true; }
  }
  if (changed) try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch {}
}

function cartLines() {
  const cart = getCart();
  return Object.entries(cart)
    .map(([id, qty]) => ({ listing: listings.find((l) => l.id === id), qty }))
    .filter((x) => x.listing);
}

// --- Cards ---

function toggleDescription(id) {
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  renderListings();
}

function carouselNav(id, delta, total) {
  carouselIndex.set(id, ((carouselIndex.get(id) || 0) + delta + total) % total);
  renderListings();
}

function cardHtml(l, cart) {
  const imgs = imagesOf(l);
  const idx = Math.min(carouselIndex.get(l.id) || 0, Math.max(imgs.length - 1, 0));
  const inCart = cart[l.id] || 0;
  const reserved = l.status === "reserved";
  const maxed = inCart >= invOf(l);
  const expanded = expandedIds.has(l.id);
  const cond = CONDITION[l.condition] || CONDITION.good;
  const rarity = RARITY[l.rarity] || RARITY.common;
  const format = FORMAT[l.format] || FORMAT.paperback;

  let button;
  if (reserved) button = `<button disabled>Reserved / Apartado</button>`;
  else if (maxed) button = `<button disabled>In your cart / En tu carrito</button>`;
  else button = `<button onclick="addToCart('${l.id}')">Add to cart / Agregar</button>`;

  return `
    <div class="card ${reserved ? "is-reserved" : ""}">
      <div class="card-image-wrap">
        ${imgs.length ? `<img src="${WORKER_BASE_URL}/images/${imgs[idx]}" alt="${escapeHtml(l.title)}" loading="lazy" onclick="openLightbox('${l.id}', ${idx})">` : `<div class="no-photo">📚</div>`}
        ${reserved ? `<span class="ribbon">Reserved / Apartado</span>` : ""}
        ${imgs.length > 1 ? `
          <button class="carousel-nav prev" onclick="carouselNav('${l.id}', -1, ${imgs.length})" aria-label="Previous photo">‹</button>
          <button class="carousel-nav next" onclick="carouselNav('${l.id}', 1, ${imgs.length})" aria-label="Next photo">›</button>
          <div class="carousel-dots">${imgs.map((_, i) => `<span class="dot ${i === idx ? "active" : ""}"></span>`).join("")}</div>
        ` : ""}
      </div>
      <div class="card-body">
        <h3>${escapeHtml(l.title)}</h3>
        ${l.author ? `<div class="author">${escapeHtml(l.author)}</div>` : ""}
        <div class="badges">
          <span class="badge cond-${l.condition}" title="${escapeHtml(cond.note)}">${cond.en} · ${cond.es}</span>
          ${l.rarity !== "common" ? `<span class="badge rarity rarity-${l.rarity}" title="${escapeHtml(rarity.note)}">${rarity.en}</span>` : ""}
          <span class="badge">${format.en}</span>
          <span class="badge">${LANGUAGES[l.language] || l.language}</span>
          ${invOf(l) > 1 ? `<span class="badge">${invOf(l)} copies</span>` : ""}
        </div>
        ${l.edition_notes ? `<div class="edition">✨ ${escapeHtml(l.edition_notes)}</div>` : ""}
        <p class="desc ${expanded ? "open" : ""}">${escapeHtml(l.description_en)}</p>
        ${expanded && l.description_es ? `<p class="desc open desc-es">${escapeHtml(l.description_es)}</p>` : ""}
        <button class="link-btn" onclick="toggleDescription('${l.id}')">${expanded ? "Less / Menos" : "More · En español"}</button>
        <div class="price">
          <span class="price-amount">${fmtCop(l.price_cop)}</span>
          <span class="usd">${fmtUsd(l.price_usd)}</span>
        </div>
        ${button}
      </div>
    </div>
  `;
}

// --- Filters ---

function populateGenreFilter() {
  const select = document.getElementById("genreFilter");
  const prev = select.value;
  const counts = {};
  listings.forEach((l) => { counts[l.genre] = (counts[l.genre] || 0) + 1; });
  const options = [`<option value="">All genres / Todos (${listings.length})</option>`];
  Object.keys(GENRES).forEach((g) => {
    if (counts[g]) options.push(`<option value="${g}">${GENRES[g].icon} ${GENRES[g].en} / ${GENRES[g].es} (${counts[g]})</option>`);
  });
  select.innerHTML = options.join("");
  select.value = prev && counts[prev] ? prev : "";
}

function filteredSorted() {
  const genre = document.getElementById("genreFilter").value;
  const q = document.getElementById("search").value.trim().toLowerCase();
  const sort = document.getElementById("sort").value;

  const items = listings.filter((l) => {
    if (genre && l.genre !== genre) return false;
    if (q && !`${l.title} ${l.author}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const sorters = {
    title: byTitle,
    author: (a, b) => (a.author || "").localeCompare(b.author || "") || byTitle(a, b),
    price_asc: (a, b) => a.price_cop - b.price_cop || byTitle(a, b),
    price_desc: (a, b) => b.price_cop - a.price_cop || byTitle(a, b),
    newest: (a, b) => (b.created_at || "").localeCompare(a.created_at || ""),
  };
  // Reserved books sink to the bottom whatever the sort.
  return items.sort((a, b) => (a.status === "reserved") - (b.status === "reserved") || (sorters[sort] || byTitle)(a, b));
}

function renderListings() {
  const grid = document.getElementById("grid");
  const items = filteredSorted();
  document.getElementById("resultCount").textContent = listings.length
    ? `${items.length} of ${listings.length} books / libros`
    : "";

  if (!listings.length) {
    grid.innerHTML = `<div class="empty-state">No books listed yet. Check back soon. / Todavía no hay libros. Vuelve pronto.</div>`;
    return;
  }
  if (!items.length) {
    grid.innerHTML = `<div class="empty-state">Nothing matches that search. / Nada coincide con esa búsqueda.</div>`;
    return;
  }
  const cart = getCart();
  grid.innerHTML = `<div class="grid">${items.map((l) => cardHtml(l, cart)).join("")}</div>`;
}

// --- Lightbox ---

let lightboxImages = [];
let lightboxIdx = 0;

function openLightbox(id, startIdx) {
  const listing = listings.find((l) => l.id === id);
  if (!listing || !imagesOf(listing).length) return;
  lightboxImages = imagesOf(listing);
  lightboxIdx = Math.min(startIdx || 0, lightboxImages.length - 1);
  renderLightbox();
  document.getElementById("lightbox").classList.add("open");
  document.body.classList.add("lightbox-open");
}

function renderLightbox() {
  document.getElementById("lightboxImg").src = `${WORKER_BASE_URL}/images/${lightboxImages[lightboxIdx]}`;
  const multi = lightboxImages.length > 1;
  document.querySelectorAll("#lightbox .lightbox-nav").forEach((b) => { b.style.display = multi ? "" : "none"; });
  document.getElementById("lightboxDots").innerHTML = multi ? lightboxImages.map((_, i) => `<span class="dot ${i === lightboxIdx ? "active" : ""}"></span>`).join("") : "";
}

function lightboxNav(event, delta) {
  if (event) event.stopPropagation();
  lightboxIdx = (lightboxIdx + delta + lightboxImages.length) % lightboxImages.length;
  renderLightbox();
}

// Closes on the close button (force) or a backdrop click, not clicks on the image itself.
function closeLightbox(event, force) {
  if (!force && event && event.target.id !== "lightbox") return;
  document.getElementById("lightbox").classList.remove("open");
  document.body.classList.remove("lightbox-open");
}

// --- Cart drawer + WhatsApp checkout ---

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((sum, x) => sum + x.qty, 0);
  document.getElementById("cartCount").textContent = count;
  document.getElementById("whatsappBtn").disabled = !lines.length;

  const list = document.getElementById("cartItems");
  if (!lines.length) {
    list.innerHTML = `<div class="empty-state">Your cart is empty. / Tu carrito está vacío.</div>`;
    document.getElementById("cartTotal").innerHTML = "";
    return;
  }

  list.innerHTML = lines.map(({ listing: l, qty }) => {
    return `
      <div class="cart-line">
        <span class="name">${escapeHtml(l.title)}<small>${fmtCop(l.price_cop)}</small></span>
        ${invOf(l) > 1 ? `<input type="number" min="0" max="${invOf(l)}" value="${qty}" onchange="setQty('${l.id}', parseInt(this.value) || 0)">` : ""}
        <button class="secondary" onclick="setQty('${l.id}', 0)" aria-label="Remove">✕</button>
      </div>
    `;
  }).join("");

  const t = bulkTotals(lines);
  const toNext = t.next ? t.next.min - t.count : 0;
  document.getElementById("cartTotal").innerHTML = `
    ${t.tier ? `
      <div class="cart-row"><span>Subtotal</span><span>${fmtCop(t.subtotal)}</span></div>
      <div class="cart-row discount"><span>${t.tier.pct}% off ${t.count} books / descuento</span><span>−${fmtCop(t.discount)}</span></div>
    ` : ""}
    <div class="cart-row total"><span>Total</span><span>${fmtCop(t.total)} · ${fmtUsd(t.totalUsd)}</span></div>
    ${t.next ? `<div class="cart-nudge">Add ${toNext} more book${toNext > 1 ? "s" : ""} for ${t.next.pct}% off / Agrega ${toNext} más y te llevas ${t.next.pct}% de descuento</div>` : ""}
    ${t.tier && t.discount < Math.round((t.subtotal * t.tier.pct) / 100 / 1000) * 1000 ? `<div class="cart-nudge muted">Collectible books aren't discounted. / Los libros de colección no tienen descuento.</div>` : ""}
  `;
}

function toggleCart(open) {
  document.getElementById("cartDrawer").classList.toggle("open", open);
  document.getElementById("overlay").classList.toggle("open", open);
}

function whatsAppCheckoutMessage() {
  const cart = cartLines();
  const lines = cart.map(({ listing: l, qty }) => {
    const by = l.author ? ` (${l.author})` : "";
    const n = qty > 1 ? ` x${qty}` : "";
    return `- ${l.title}${by}${n}: ${Number(l.price_cop).toLocaleString("en-US")} COP`;
  });
  const t = bulkTotals(cart);
  const totals = t.tier
    ? `Subtotal: ${fmtCop(t.subtotal)}\n${t.tier.pct}% off for ${t.count} books: -${fmtCop(t.discount)}\nTotal: ${fmtCop(t.total)}`
    : `Total: ${fmtCop(t.total)}`;
  return `Hi Jordan! I'd like these books from your book sale:\n${lines.join("\n")}\n\n${totals}\n\nAre they still available?`;
}

function openWhatsAppCheckout() {
  if (!cartLines().length) return;
  const url = `https://wa.me/${JORDAN_WHATSAPP}?text=${encodeURIComponent(whatsAppCheckoutMessage())}`;
  window.open(url, "_blank");
  try { localStorage.removeItem(CART_KEY); } catch {}
  toggleCart(false);
  renderCart();
  renderListings();
}

async function loadListings() {
  const grid = document.getElementById("grid");
  grid.innerHTML = `<div class="empty-state">Loading books…</div>`;
  try {
    const resp = await fetch(`${WORKER_BASE_URL}/api/listings`);
    listings = await resp.json();
    pruneCart();
    populateGenreFilter();
    renderListings();
    renderCart();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Couldn't load the books right now. Try refreshing. / No pudimos cargar los libros. Recarga la página.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("priceScale").innerHTML = priceScaleHtml();
  document.getElementById("bulkTiers").innerHTML = bulkTiersHtml();
  document.getElementById("genreFilter").addEventListener("change", renderListings);
  document.getElementById("sort").addEventListener("change", renderListings);
  document.getElementById("search").addEventListener("input", renderListings);
  document.getElementById("cartToggle").addEventListener("click", () => toggleCart(true));
  document.getElementById("cartClose").addEventListener("click", () => toggleCart(false));
  document.getElementById("overlay").addEventListener("click", () => toggleCart(false));
  document.getElementById("whatsappBtn").addEventListener("click", openWhatsAppCheckout);

  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("lightbox").classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox(null, true);
    else if (e.key === "ArrowLeft" && lightboxImages.length > 1) lightboxNav(null, -1);
    else if (e.key === "ArrowRight" && lightboxImages.length > 1) lightboxNav(null, 1);
  });

  loadListings();
});
