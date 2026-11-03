const TOKEN_KEY = "book_sale_admin_token";

let allListings = [];
let currentFxRate = 4000;
// Drafts always render editable; ids in here are non-draft books being edited.
const editing = new Set();
const justSaved = new Set();

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function authHeaders() {
  return { "Authorization": `Bearer ${getToken()}`, "Content-Type": "application/json" };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function imagesOf(l) { return l.image_keys || []; }
function invOf(l) { return l.inventory ?? 1; }

async function unlock() {
  const input = document.getElementById("tokenInput").value.trim();
  if (!input) return;
  try { localStorage.setItem(TOKEN_KEY, input); } catch {}
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings`, { headers: authHeaders() });
  if (resp.status === 401) {
    alert("That token was rejected.");
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    return;
  }
  showAdmin();
}

function showAdmin() {
  document.getElementById("gate").style.display = "none";
  document.getElementById("adminBody").style.display = "block";
  loadAll();
}

function forceRelogin(msg) {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  document.getElementById("adminBody").style.display = "none";
  document.getElementById("gate").style.display = "block";
  if (msg) alert(msg);
}

function handleApiError(status, action) {
  if (status === 401) forceRelogin(`Your admin session is no longer valid. Log in again to ${action || "continue"}.`);
  else alert(`That ${action || "action"} didn't go through (server returned ${status}). Try again.`);
}

function selectOptions(map, selected, label) {
  return Object.keys(map).map((k) => `<option value="${k}" ${k === selected ? "selected" : ""}>${label(map[k], k)}</option>`).join("");
}

function fxValue() {
  const v = parseFloat(document.getElementById("fxRate").value);
  return v > 0 ? v : currentFxRate;
}

function usdPreview(cop) {
  return `≈ $${(Math.round((cop / fxValue()) * 100) / 100).toLocaleString("en-US")} USD`;
}

// --- Price helper: changing rarity/format/condition moves the price to the scale ---

function onGradeChange(el) {
  const card = el.closest(".admin-item");
  const rarity = card.querySelector(".f-rarity").value;
  const scale = scalePrice(rarity, card.querySelector(".f-format").value, card.querySelector(".f-condition").value);
  const priceInput = card.querySelector(".f-price");
  // Collectibles are priced individually; the scale is only a floor for them.
  const current = parseInt(priceInput.value) || 0;
  priceInput.value = rarity === "collectible" ? Math.max(scale, current) : scale;
  card.querySelector(".scale-hint").textContent = `Scale: ${scale.toLocaleString()} COP${rarity === "collectible" ? " (floor)" : ""}`;
  onPriceInput(priceInput);
}

function onPriceInput(input) {
  input.parentElement.querySelector(".price-usd-preview").textContent = usdPreview(parseInt(input.value) || 0);
}

function comparablesUrl(l) {
  const p = new URLSearchParams({ tn: l.title || "", an: l.author || "" });
  return `https://www.abebooks.com/servlet/SearchResults?${p}`;
}

// --- Cards ---

function badges(l) {
  const dups = l.possible_duplicate_of || [];
  return `
    <span class="mode-badge ${l.status}">${{ draft: "✏️ Draft", available: "🟢 Available", reserved: "🟡 Reserved", sold: "Sold" }[l.status] || l.status}</span>
    ${dups.length ? `<span class="dup-badge" onclick="focusListing('${dups[0]}')" title="Click to jump to the other listing">⚠️ Possibly already listed</span>` : ""}
    ${justSaved.has(l.id) ? `<span class="saved-flash">✓ Saved</span>` : ""}
  `;
}

function focusListing(id) {
  const el = document.querySelector(`.admin-item[data-id="${id}"]`);
  if (!el) { alert("The other listing isn't on this page any more."); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("dup-flash");
  setTimeout(() => el.classList.remove("dup-flash"), 2000);
}

function photoStrip(l) {
  const thumbs = imagesOf(l).map((imgId, i) => `
    <div class="photo-thumb">
      <img src="${WORKER_BASE_URL}/images/${imgId}" alt="" onclick="window.open(this.src)">
      ${imagesOf(l).length > 1 ? `<button onclick="removePhoto('${l.id}', ${i})" title="Remove this photo">✕</button>` : ""}
    </div>
  `).join("");
  return `
    <div class="photo-strip">
      ${thumbs}
      <label class="add-photo-btn" title="Add photo">+<input type="file" accept="image/*" onchange="addPhoto('${l.id}', this.files[0])"></label>
    </div>
  `;
}

function aiNote(l) {
  const bits = [];
  if (l.rarity_reason) bits.push(`Rarity: ${escapeHtml(l.rarity_reason)}`);
  if (l.collectible_estimate_cop) bits.push(`AI comps estimate ${l.collectible_estimate_cop.toLocaleString()} COP`);
  bits.push(`<a href="${comparablesUrl(l)}" target="_blank" rel="noopener">Check AbeBooks ↗</a>`);
  return `<div class="ai-price-note">${bits.join(" · ")}</div>`;
}

function editableFields(l) {
  const scale = scalePrice(l.rarity, l.format, l.condition);
  return `
    <div class="row">
      <div class="grow"><label>Title</label><input class="f-title" value="${escapeHtml(l.title)}"></div>
      <div class="grow"><label>Author</label><input class="f-author" value="${escapeHtml(l.author)}"></div>
    </div>
    <div class="row">
      <div><label>Condition</label><select class="f-condition" onchange="onGradeChange(this)">${selectOptions(CONDITION, l.condition, (c) => `${c.en} — ${c.note}`)}</select></div>
      <div><label>Rarity</label><select class="f-rarity" onchange="onGradeChange(this)">${selectOptions(RARITY, l.rarity, (r) => r.en)}</select></div>
      <div><label>Format</label><select class="f-format" onchange="onGradeChange(this)">${selectOptions(FORMAT, l.format, (f) => f.en)}</select></div>
    </div>
    <div class="row">
      <div><label>Genre</label><select class="f-genre">${selectOptions(GENRES, l.genre, (g) => `${g.icon} ${g.en}`)}</select></div>
      <div><label>Language</label><select class="f-language">${selectOptions(LANGUAGES, l.language, (x) => x)}</select></div>
      <div><label>Copies</label><input class="f-inventory" type="number" min="0" value="${invOf(l)}"></div>
    </div>
    <div><label>Edition notes (signed, first edition… leave blank if nothing special)</label><input class="f-edition" value="${escapeHtml(l.edition_notes)}"></div>
    <div><label>Description (English)</label><textarea class="f-desc-en">${escapeHtml(l.description_en)}</textarea></div>
    <div><label>Descripción (Español)</label><textarea class="f-desc-es">${escapeHtml(l.description_es)}</textarea></div>
    <div class="row">
      <div>
        <label>Price (COP)</label>
        <input class="f-price" type="number" step="1000" value="${l.price_cop}" oninput="onPriceInput(this)">
        <div class="price-usd-preview">${usdPreview(l.price_cop)}</div>
      </div>
      <div class="scale-hint muted-note">Scale: ${scale.toLocaleString()} COP${l.rarity === "collectible" ? " (floor)" : ""}</div>
    </div>
  `;
}

function readOnlyFields(l) {
  const c = CONDITION[l.condition] || {};
  const r = RARITY[l.rarity] || {};
  const f = FORMAT[l.format] || {};
  return `
    <div><strong>${escapeHtml(l.title)}</strong>${l.author ? ` — ${escapeHtml(l.author)}` : ""}</div>
    <div>${c.en || l.condition} · ${r.en || l.rarity} · ${f.en || l.format} · ${(GENRES[l.genre] || {}).en || l.genre} · ${LANGUAGES[l.language] || l.language} · ${invOf(l)} ${invOf(l) === 1 ? "copy" : "copies"}</div>
    ${l.edition_notes ? `<div>✨ ${escapeHtml(l.edition_notes)}</div>` : ""}
    <div class="muted-note">${escapeHtml(l.description_en)}</div>
    <div><strong>${Number(l.price_cop).toLocaleString()} COP</strong> <span class="muted-note">${usdPreview(l.price_cop)}</span></div>
    ${l.status === "sold" && l.sold_price_cop != null ? `<div><strong>Sold for ${l.sold_price_cop.toLocaleString()} COP</strong></div>` : ""}
  `;
}

function cardHtml(l) {
  const isEditing = l.status === "draft" || editing.has(l.id);
  const multi = imagesOf(l).length > 1;
  let actions;
  if (l.status === "draft") {
    actions = `
      <button onclick="saveEdits('${l.id}', 'available')">Publish</button>
      <button class="secondary" onclick="saveEdits('${l.id}')">Save</button>
      ${l.title === "Needs review" ? `<button class="secondary retry-btn" onclick="retryListing('${l.id}')">↻ Retry AI</button>` : ""}
      <button class="secondary redraft-btn" onclick="redraftListing('${l.id}')">✨ Fix with AI</button>
      ${multi ? `<button class="secondary split-btn" onclick="splitListing('${l.id}')">Split (${imagesOf(l).length} photos)</button>` : ""}
      <button class="danger" onclick="deleteListing('${l.id}')">Delete</button>`;
  } else if (isEditing) {
    actions = `
      <button onclick="saveEdits('${l.id}')">Save</button>
      <button class="secondary" onclick="setEditing('${l.id}', false)">Cancel</button>`;
  } else {
    actions = `
      <button class="secondary" onclick="setEditing('${l.id}', true)">Edit</button>
      ${l.status === "available" ? `<button class="secondary" onclick="setStatus('${l.id}', 'reserved')">Reserve</button>` : ""}
      ${l.status === "reserved" ? `<button class="secondary" onclick="setStatus('${l.id}', 'available')">Unreserve</button>` : ""}
      ${l.status !== "sold" ? `<button class="secondary" onclick="markSold('${l.id}')">Mark sold</button>` : `<button class="secondary" onclick="setStatus('${l.id}', 'available')">Back to available</button>`}
      <button class="secondary redraft-btn" onclick="redraftListing('${l.id}')">✨ Fix with AI</button>
      <button class="danger" onclick="deleteListing('${l.id}')">Delete</button>`;
  }

  return `
    <div class="admin-item ${isEditing && l.status !== "draft" ? "is-editing" : ""}" data-id="${l.id}">
      <img src="${imagesOf(l).length ? `${WORKER_BASE_URL}/images/${imagesOf(l)[0]}` : ""}" alt="" onclick="window.open(this.src)">
      <div class="admin-fields">
        <div class="badge-row">${badges(l)}</div>
        ${aiNote(l)}
        ${photoStrip(l)}
        ${isEditing ? editableFields(l) : readOnlyFields(l)}
        <div class="admin-actions">${actions}</div>
      </div>
    </div>
  `;
}

// --- Mutations ---

function readFields(id) {
  const card = document.querySelector(`.admin-item[data-id="${id}"]`);
  const v = (sel) => card.querySelector(sel).value;
  return {
    title: v(".f-title").trim(),
    author: v(".f-author").trim(),
    condition: v(".f-condition"),
    rarity: v(".f-rarity"),
    format: v(".f-format"),
    genre: v(".f-genre"),
    language: v(".f-language"),
    inventory: parseInt(v(".f-inventory")) || 0,
    edition_notes: v(".f-edition").trim(),
    description_en: v(".f-desc-en").trim(),
    description_es: v(".f-desc-es").trim(),
    price_cop: parseInt(v(".f-price")) || 0,
  };
}

async function patchListing(id, updates) {
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(updates) });
  if (!resp.ok) { handleApiError(resp.status, "save"); return null; }
  return resp.json();
}

// Keeps the UI in sync without a refetch — KV list reads can lag ~60s after a write.
function replaceLocal(updated) {
  const i = allListings.findIndex((l) => l.id === updated.id);
  if (i >= 0) allListings[i] = updated;
  else allListings.push(updated);
}

function flashSaved(id) {
  justSaved.add(id);
  renderLists();
  setTimeout(() => { justSaved.delete(id); renderLists(); }, 1500);
}

async function saveEdits(id, status) {
  const updates = readFields(id);
  if (status) updates.status = status;
  const updated = await patchListing(id, updates);
  if (!updated) return;
  editing.delete(id);
  replaceLocal(updated);
  flashSaved(id);
}

function setEditing(id, on) {
  if (on) editing.add(id);
  else editing.delete(id);
  renderLists();
}

async function setStatus(id, status) {
  const updated = await patchListing(id, { status });
  if (!updated) return;
  replaceLocal(updated);
  renderLists();
}

async function markSold(id) {
  const l = allListings.find((x) => x.id === id);
  const input = prompt("What did it actually sell for (COP)?", l ? l.price_cop : 0);
  if (input === null) return;
  const updated = await patchListing(id, { status: "sold", sold_price_cop: parseInt(input.replace(/[^\d]/g, "")) || 0 });
  if (!updated) return;
  replaceLocal(updated);
  renderLists();
}

async function publishAll() {
  const drafts = allListings.filter((l) => l.status === "draft" && l.title !== "Needs review");
  if (!drafts.length) { alert("No drafts ready to publish."); return; }
  if (!confirm(`Publish ${drafts.length} draft${drafts.length > 1 ? "s" : ""} as they are? ("Needs review" drafts are skipped.)`)) return;
  for (const d of drafts) {
    const updated = await patchListing(d.id, { status: "available" });
    if (!updated) return;
    replaceLocal(updated);
  }
  renderLists();
}

async function deleteListing(id) {
  if (!confirm("Delete this book and its photos permanently?")) return;
  const l = allListings.find((x) => x.id === id);
  const images = encodeURIComponent((l ? imagesOf(l) : []).join(","));
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}?images=${images}`, { method: "DELETE", headers: authHeaders() });
  if (!resp.ok) { handleApiError(resp.status, "delete"); return; }
  allListings = allListings.filter((l) => l.id !== id);
  renderLists();
}

async function addPhoto(id, file) {
  if (!file) return;
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}/photos`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${getToken()}`, "Content-Type": file.type || "image/jpeg" },
    body: file,
  });
  if (!resp.ok) { handleApiError(resp.status, "photo upload"); return; }
  replaceLocal(await resp.json());
  renderLists();
}

async function removePhoto(id, index) {
  if (!confirm("Remove this photo?")) return;
  const l = allListings.find((x) => x.id === id);
  if (!l) return;
  const imgs = imagesOf(l).slice();
  imgs.splice(index, 1);
  const updated = await patchListing(id, { image_keys: imgs });
  if (!updated) return;
  replaceLocal(updated);
  renderLists();
}

// New books from the laptop: each file goes through the same AI drafting as WhatsApp.
async function uploadPhotos(files) {
  const status = document.getElementById("uploadStatus");
  const list = Array.from(files || []);
  for (let i = 0; i < list.length; i++) {
    status.textContent = `Reading photo ${i + 1} of ${list.length}…`;
    const resp = await fetch(`${WORKER_BASE_URL}/api/admin/upload`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${getToken()}`, "Content-Type": list[i].type || "image/jpeg" },
      body: list[i],
    });
    if (!resp.ok) { status.textContent = ""; handleApiError(resp.status, "upload"); return; }
    replaceLocal(await resp.json());
    renderLists();
  }
  status.textContent = list.length ? `Done: ${list.length} photo${list.length > 1 ? "s" : ""} drafted.` : "";
  document.getElementById("uploadInput").value = "";
}

async function redraftListing(id) {
  const note = prompt(
    "What did the AI get wrong? It'll re-read the photo with your note.\n\n" +
    "e.g. \"it's signed on the title page\" · \"hardcover, not paperback\" · \"pages are highlighted, fair\" · \"wrong book, it's volume 2\""
  );
  if (!note || !note.trim()) return;
  const btn = document.querySelector(`.admin-item[data-id="${id}"] .redraft-btn`);
  if (btn) { btn.disabled = true; btn.textContent = "✨ Re-reading…"; }
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}/redraft`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ note: note.trim() }) });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error || ""; } catch {}
    alert(`Re-draft failed. ${detail}`.trim());
    if (btn) { btn.disabled = false; btn.textContent = "✨ Fix with AI"; }
    return;
  }
  replaceLocal(await resp.json());
  flashSaved(id);
}

// Re-reads a draft whose AI call failed (e.g. out of credits). Returns true on success.
async function retryListing(id, quiet) {
  const btn = document.querySelector(`.admin-item[data-id="${id}"] .retry-btn`);
  if (btn) { btn.disabled = true; btn.textContent = "↻ Reading…"; }
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}/redraft`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ note: "" }) });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error || ""; } catch {}
    if (!quiet) alert(`Retry failed. ${detail}`.trim());
    if (btn) { btn.disabled = false; btn.textContent = "↻ Retry AI"; }
    return detail || "failed";
  }
  replaceLocal(await resp.json());
  flashSaved(id);
  return true;
}

async function retryAllFailed() {
  const failed = allListings.filter((l) => l.title === "Needs review");
  const btn = document.getElementById("retryAllBtn");
  for (let i = 0; i < failed.length; i++) {
    btn.textContent = `Retrying ${i + 1}/${failed.length}…`;
    const ok = await retryListing(failed[i].id, true);
    if (ok !== true) {
      alert(`Stopped at ${i + 1} of ${failed.length}. ${ok}`);
      break;
    }
  }
  renderLists();
}

async function splitListing(id) {
  const l = allListings.find((x) => x.id === id);
  const imgs = l ? imagesOf(l) : [];
  if (imgs.length < 2) return;
  if (!confirm(`Split these ${imgs.length} photos into ${imgs.length} separate drafts?`)) return;
  const btn = document.querySelector(`.admin-item[data-id="${id}"] .split-btn`);
  if (btn) btn.disabled = true;

  // One request per photo; the original stays untouched until every photo is extracted.
  for (let i = 0; i < imgs.length; i++) {
    if (btn) btn.textContent = `Splitting ${i + 1}/${imgs.length}…`;
    const resp = await fetch(`${WORKER_BASE_URL}/api/admin/split-photo`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ image_key: imgs[i] }) });
    if (!resp.ok) {
      alert(`Split failed on photo ${i + 1}. The original is untouched; ${i} new draft(s) were already created.`);
      loadAll();
      return;
    }
    replaceLocal(await resp.json());
  }
  // The new drafts now own these photos, so delete only the original record (images= empty).
  await fetch(`${WORKER_BASE_URL}/api/admin/listings/${id}?images=`, { method: "DELETE", headers: authHeaders() });
  allListings = allListings.filter((x) => x.id !== id);
  renderLists();
}

// --- Config ---

async function loadConfig() {
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/config`, { headers: authHeaders() });
  if (!resp.ok) return;
  const data = await resp.json();
  currentFxRate = data.fx_rate;
  document.getElementById("fxRate").value = data.fx_rate;
  document.getElementById("autoPublish").checked = !!data.auto_publish;
}

async function patchConfig(updates) {
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/config`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(updates) });
  if (!resp.ok) { handleApiError(resp.status, "settings change"); return null; }
  return resp.json();
}

// --- Render ---

function byTitle(a, b) { return (a.title || "").localeCompare(b.title || ""); }

function renderSection(elId, countId, items, empty) {
  document.getElementById(countId).textContent = items.length ? items.length : "";
  document.getElementById(elId).innerHTML = items.length ? items.map(cardHtml).join("") : `<div class="empty-state">${empty}</div>`;
}

function renderLists() {
  const by = (s) => allListings.filter((l) => l.status === s);
  const drafts = by("draft").sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const available = by("available").sort(byTitle);
  const reserved = by("reserved").sort(byTitle);
  const sold = by("sold").sort((a, b) => (b.sold_at || "").localeCompare(a.sold_at || ""));

  renderSection("drafts", "draftsCount", drafts, "No drafts. Text a book photo to the WhatsApp line or upload one above.");
  renderSection("available", "availableCount", available, "Nothing live yet.");
  renderSection("reserved", "reservedCount", reserved, "Nothing on hold.");
  renderSection("sold", "soldCount", sold, "Nothing sold yet.");
  document.getElementById("publishAllBtn").style.display = drafts.length ? "" : "none";
  const failedCount = drafts.filter((l) => l.title === "Needs review").length;
  const retryBtn = document.getElementById("retryAllBtn");
  retryBtn.style.display = failedCount ? "" : "none";
  retryBtn.textContent = `↻ Retry ${failedCount} failed`;

  const sum = (arr, f) => arr.reduce((s, l) => s + (f(l) || 0), 0);
  const liveCop = sum(available.concat(reserved), (l) => l.price_cop * invOf(l));
  const soldCop = sum(sold, (l) => l.sold_price_cop ?? l.price_cop);
  document.getElementById("totals").innerHTML = `
    <div><strong>${available.length + reserved.length}</strong> on the store (${reserved.length} reserved), ${liveCop.toLocaleString()} COP listed · ≈ $${Math.round(liveCop / fxValue()).toLocaleString()} USD</div>
    <div><strong>${sold.length}</strong> sold, ${soldCop.toLocaleString()} COP · ≈ $${Math.round(soldCop / fxValue()).toLocaleString()} USD</div>
  `;
}

async function loadAll() {
  await loadConfig();
  const resp = await fetch(`${WORKER_BASE_URL}/api/admin/listings`, { headers: authHeaders() });
  if (resp.status === 401) { forceRelogin("Your admin session is no longer valid. Log in again."); return; }
  allListings = await resp.json();
  renderLists();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("priceScale").innerHTML = priceScaleHtml();
  document.getElementById("unlockBtn").addEventListener("click", unlock);
  document.getElementById("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
  document.getElementById("refreshBtn").addEventListener("click", loadAll);
  document.getElementById("logoutBtn").addEventListener("click", () => forceRelogin("Logged out."));
  document.getElementById("publishAllBtn").addEventListener("click", publishAll);
  document.getElementById("retryAllBtn").addEventListener("click", retryAllFailed);
  document.getElementById("uploadInput").addEventListener("change", (e) => uploadPhotos(e.target.files));
  document.getElementById("fxRate").addEventListener("input", renderLists);
  document.getElementById("saveFxRateBtn").addEventListener("click", async () => {
    const rate = parseFloat(document.getElementById("fxRate").value);
    if (!rate) return;
    const cfg = await patchConfig({ fx_rate: rate });
    if (cfg) { currentFxRate = cfg.fx_rate; alert("Saved. Applies to books saved from now on."); }
  });
  document.getElementById("autoPublish").addEventListener("change", async (e) => {
    const cfg = await patchConfig({ auto_publish: e.target.checked });
    if (!cfg) e.target.checked = !e.target.checked;
  });

  if (getToken()) showAdmin();
});
