// app.js — UI wiring. All planning logic lives in engine.js; all sync logic
// in sync.js/merge.js. This file renders state and routes taps to mutations.

import * as E from "./engine.js";
import { mergeStates, pruneState } from "./merge.js";
import { makeClient, syncOnce, SyncError } from "./sync.js";
import { parseIngredientList, ingredientDict, autocomplete } from "./parse.js";

const LS_STATE = "dinner:v1";
const LS_WHO = "dinner:whoami";
const LS_SYNC = "dinner:sync";

// ---------- state ----------

let state = loadState();
let whoami = localStorage.getItem(LS_WHO) || null;
let activeTab = "week";
let viewWeek = E.weekKeyFor(todayStr());
let filters = { maxQuick: false, cook: null };
let syncStatus = "off"; // off | ok | err | busy | offline
let lastSyncDetail = "";
let searchQ = "";

function todayStr() {
  return E.fmtDate(new Date());
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema >= 1) return mergeStates(parsed, null);
    }
  } catch (e) {
    console.warn("state load failed, starting empty", e);
  }
  return E.emptyState();
}

function saveState() {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  } catch (e) {
    toast("Could not save locally — storage full?");
  }
}

function commit(next) {
  state = next;
  saveState();
  render();
  scheduleSync();
}

// ---------- sync ----------

let syncTimer = null;
let syncing = false;
let syncQueued = false;

function getSyncCfg() {
  try {
    const cfg = JSON.parse(localStorage.getItem(LS_SYNC) || "null");
    if (cfg && cfg.owner && cfg.repo && cfg.token) {
      return { path: "state.json", ...cfg };
    }
  } catch { /* fall through */ }
  return null;
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(), 3000);
}

async function doSync(manual = false) {
  const cfg = getSyncCfg();
  if (!cfg) {
    syncStatus = "off";
    renderChip();
    if (manual) showTab("settings");
    return;
  }
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  syncStatus = "busy";
  renderChip();
  try {
    const client = makeClient(cfg);
    const res = await syncOnce(client, pruneState(state, E.weekKeyFor(todayStr())));
    // Local state may have moved while the network round-trip ran; merge, never replace.
    state = mergeStates(state, res.state);
    saveState();
    syncStatus = "ok";
    lastSyncDetail = new Date().toLocaleTimeString();
    render();
  } catch (e) {
    if (navigator.onLine === false) {
      syncStatus = "offline";
      lastSyncDetail = "offline — will retry";
    } else {
      syncStatus = "err";
      lastSyncDetail =
        e instanceof SyncError && e.kind === "auth"
          ? "token rejected — check Setup"
          : `sync failed (${e.message})`;
    }
    renderChip();
    if (manual) toast(lastSyncDetail);
  } finally {
    syncing = false;
    if (syncQueued) {
      syncQueued = false;
      scheduleSync();
    }
  }
}

window.addEventListener("online", () => doSync());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) doSync();
});

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function fmtShort(dateStr) {
  const d = E.parseDate(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function byLabel(by) {
  return by === "greg" ? "G" : by === "angie" ? "A" : "";
}

// ---------- tabs ----------

function showTab(name) {
  activeTab = name;
  document.querySelectorAll("nav.tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  document.querySelectorAll("section.tab").forEach((s) =>
    s.classList.toggle("active", s.id === `tab-${name}`)
  );
  render();
}

document.querySelector("nav.tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) showTab(btn.dataset.tab);
});

$("#syncChip").addEventListener("click", () => doSync(true));

// ---------- render root ----------

function render() {
  renderChip();
  if (activeTab === "week") renderWeek();
  if (activeTab === "meals") renderMeals();
  if (activeTab === "shop") renderShop();
  if (activeTab === "settings") renderSettings();
}

function renderChip() {
  const chip = $("#syncChip");
  chip.className = "sync-chip " + ({ ok: "ok", err: "err", busy: "busy", offline: "err" }[syncStatus] || "");
  chip.textContent = {
    off: "local only",
    ok: "synced",
    busy: "syncing…",
    err: "sync error",
    offline: "offline",
  }[syncStatus];
}

// ---------- week tab ----------

function weekBlockHtml(wk, today, thisWeek, anyMeals) {
  const week = state.weeks[wk] || {};
  const mix = E.weekMix(state, wk);
  const floor = state.settings.minStandardPlus;
  const stdPlus = mix.standard + mix.project;
  const mixParts = E.EFFORTS.filter((t) => mix[t] > 0)
    .map((t) => `${mix[t]} ${E.EFFORT_LABELS[t].toLowerCase()}`)
    .join(" · ");
  const floorNote = floor
    ? `<span class="${stdPlus >= floor ? "floor-ok" : "floor-warn"}">floor ${stdPlus}/${floor} standard+</span>`
    : "";
  const label =
    wk === thisWeek ? "This week"
    : wk === E.addDays(thisWeek, 7) ? "Next week"
    : "Week of";
  const clearable = E.DAYS.some((d) => week[d]?.mealId && !week[d].resolved);

  let html = `
    <div class="week-block">
      <div class="block-head">
        <h3>${label}</h3>
        <span class="range">${fmtShort(wk)} &ndash; ${fmtShort(E.addDays(wk, 6))}</span>
        ${clearable ? `<button class="chip" data-act="clear-week" data-wk="${wk}">clear</button>` : ""}
        ${anyMeals ? `<button class="fill-btn" data-act="fill" data-wk="${wk}">Fill empty days</button>` : ""}
      </div>
      <div class="mix-line">${mixParts || "nothing planned yet"}${floorNote ? " &nbsp;" + floorNote : ""}</div>
      <div class="rail">`;

  for (const day of E.DAYS) {
    const date = E.dateForDay(wk, day);
    const slot = week[day];
    const isToday = date === today;
    const meal = slot?.mealId ? state.meals[slot.mealId] : null;
    if (meal) {
      const cooked = slot.resolved && meal.lastEaten && meal.lastEaten >= date;
      const canCook = date <= today && !slot.resolved;
      html += `
        <div class="ticket ${isToday ? "today" : ""} ${cooked ? "cooked" : ""}">
          <div class="day-line"><span class="dow">${day}</span><span>${fmtShort(date)}</span>
            ${slot.by ? `<span class="by">${byLabel(slot.by)}</span>` : ""}</div>
          <div class="meal-name">${esc(meal.name)}</div>
          <div class="meal-sub"><span class="tier">${E.EFFORT_LABELS[meal.effort]}</span>
            &nbsp;${esc(meal.protein)}${meal.cook !== "either" ? ` · ${esc(meal.cook)}` : ""}</div>
          <div class="t-actions">
            <button data-act="suggest" data-day="${day}" data-wk="${wk}">shuffle</button>
            ${canCook ? `<button class="cook" data-act="cooked" data-day="${day}" data-wk="${wk}">cooked</button>` : ""}
            <button data-act="clear" data-day="${day}" data-wk="${wk}">&times;</button>
          </div>
        </div>`;
    } else {
      html += `
        <div class="ticket empty ${isToday ? "today" : ""}">
          <div class="day-line"><span class="dow">${day}</span><span>${fmtShort(date)}</span></div>
          <div class="t-actions">
            ${anyMeals
              ? `<button class="primary" data-act="suggest" data-day="${day}" data-wk="${wk}">suggest</button>
                 <button data-act="pick" data-day="${day}" data-wk="${wk}">pick</button>`
              : `<span style="font-family:var(--mono);font-size:.68rem;">no meals yet</span>`}
          </div>
        </div>`;
    }
  }
  html += "</div></div>";
  return html;
}

function renderWeek() {
  const today = todayStr();
  const thisWeek = E.weekKeyFor(today);
  const weeksShown = [viewWeek, E.addDays(viewWeek, 7)];
  const anyMeals = Object.keys(state.meals).length > 0;
  const cookLabel = { null: "anyone", greg: "Greg", angie: "Angie", together: "together" }[filters.cook];

  let html = `
    <div class="week-head">
      <h2>${fmtShort(weeksShown[0])} &ndash; ${fmtShort(E.addDays(weeksShown[1], 6))}</h2>
      <div class="week-nav">
        <button data-act="wk-prev">&lsaquo;</button>
        ${viewWeek !== thisWeek ? '<button data-act="wk-today">today</button>' : ""}
        <button data-act="wk-next">&rsaquo;</button>
      </div>
    </div>
    <div class="filter-row">
      <button class="chip ${filters.maxQuick ? "on" : ""}" data-act="f-quick">&le;30 min</button>
      <button class="chip ${filters.cook ? "on" : ""}" data-act="f-cook">cook: ${cookLabel}</button>
    </div>`;

  for (const wk of weeksShown) html += weekBlockHtml(wk, today, thisWeek, anyMeals);

  if (!anyMeals) {
    html += `
      <div class="empty-state" style="margin-top:14px">
        <div class="big">The rail is ready.</div>
        <p>Add meals under the Meals tab &mdash; or better, wait for the sit-down
        with Angie and enter what you two actually agree on. A rotation only one
        of you built is one the other has no reason to trust on a Thursday.</p>
      </div>`;
  }

  $("#tab-week").innerHTML = html;
}

$("#tab-week").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const day = btn.dataset.day;
  const wk = btn.dataset.wk || viewWeek;
  const today = todayStr();

  if (act === "wk-prev") { viewWeek = E.addDays(viewWeek, -7); render(); }
  if (act === "wk-next") { viewWeek = E.addDays(viewWeek, 7); render(); }
  if (act === "wk-today") { viewWeek = E.weekKeyFor(today); render(); }
  if (act === "f-quick") { filters.maxQuick = !filters.maxQuick; render(); }
  if (act === "f-cook") {
    const order = [null, "greg", "angie", "together"];
    filters.cook = order[(order.indexOf(filters.cook) + 1) % order.length];
    render();
  }
  if (act === "fill") {
    const before = E.plannedMealIds(state, wk).size;
    const next = E.fillWeek(state, wk, today, filters, Math.random, whoami, Date.now());
    const after = E.plannedMealIds(next, wk).size;
    if (after === before) toast("Nothing fit — check filters or the no-repeat window");
    commit(next);
    const floor = next.settings.minStandardPlus;
    if (floor && E.standardPlusCount(next, wk) < floor) {
      toast(`Mix floor not met — not enough standard+ meals available`);
    }
  }
  if (act === "clear-week") {
    if (confirm("Clear this week's plan? Days already marked cooked or skipped stay.")) {
      commit(E.clearWeek(state, wk, Date.now()));
    }
  }
  if (act === "suggest") {
    const meal = E.suggestFor(state, wk, today, filters, Math.random);
    if (!meal) { toast("No candidates — check filters or the no-repeat window"); return; }
    commit(E.planDay(state, wk, day, meal.id, whoami, Date.now()));
  }
  if (act === "pick") openPicker(wk, day);
  if (act === "clear") commit(E.clearDay(state, wk, day, Date.now()));
  if (act === "cooked") commit(E.stampCooked(state, wk, day, today, Date.now()));
});

// meal picker sheet
function openPicker(wk, day) {
  const meals = E.activeMeals(state).sort((a, b) => a.name.localeCompare(b.name));
  const rows = meals.map((m) => `
    <div class="recon-row">
      <div class="what"><div class="name">${esc(m.name)}</div>
        <div class="when">${E.EFFORT_LABELS[m.effort]} · ${esc(m.protein)}${m.lastEaten ? ` · eaten ${fmtShort(m.lastEaten)}` : ""}</div></div>
      <button class="made" data-pick="${m.id}">plan</button>
    </div>`).join("");
  overlay(`
    <div class="sheet-veil" data-close="1">
      <div class="sheet">
        <h3>${day} &mdash; pick a meal</h3>
        <div class="sheet-sub">tap to put it on the ticket</div>
        ${rows || '<p class="sheet-sub">No active meals.</p>'}
      </div>
    </div>`);
  $("#overlay .sheet").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pick]");
    if (!b) return;
    commit(E.planDay(state, wk, day, b.dataset.pick, whoami, Date.now()));
    closeOverlay();
  });
}

// ---------- reconciliation ----------

function maybeReconcile() {
  const q = E.reconciliationQueue(state, todayStr());
  if (!q.length) return;
  const rows = q.map((item) => `
    <div class="recon-row" data-wk="${item.weekKey}" data-day="${item.day}">
      <div class="what"><div class="name">${esc(item.name)}</div>
        <div class="when">planned ${item.day} ${fmtShort(item.date)}</div></div>
      <button class="made" data-r="made">Made it</button>
      <button class="skipped" data-r="skip">Skipped</button>
    </div>`).join("");
  overlay(`
    <div class="sheet-veil">
      <div class="sheet">
        <h3>Quick catch-up</h3>
        <div class="sheet-sub">${q.length} planned night${q.length > 1 ? "s" : ""} to settle &mdash; keeps suggestions honest</div>
        ${rows}
      </div>
    </div>`);
  $("#overlay .sheet").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]");
    if (!b) return;
    const row = b.closest(".recon-row");
    const { wk, day } = row.dataset;
    state = b.dataset.r === "made"
      ? E.resolveMade(state, wk, day, Date.now())
      : E.resolveSkipped(state, wk, day, Date.now());
    saveState();
    scheduleSync();
    row.remove();
    if (!$("#overlay .recon-row")) { closeOverlay(); render(); }
  });
}

// ---------- meals tab ----------

function renderMeals() {
  const q = searchQ.trim().toLowerCase();
  const meals = Object.values(state.meals)
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));

  let html = `
    <div class="list-head">
      <input type="search" id="mealSearch" placeholder="Search meals&hellip;" value="${esc(searchQ)}" />
      <button class="btn-amber" data-act="add">+ Meal</button>
    </div><div id="mealList">`;

  if (!meals.length && !q) {
    html += `
      <div class="empty-state">
        <div class="big">No meals yet &mdash; on purpose.</div>
        <p>The library gets filled from the joint sit-down, not from one person's
        guesses. When you're ready: + Meal, or paste a whole ingredient list at
        once &mdash; it parses.</p>
      </div>`;
  } else if (!meals.length) {
    html += `<div class="empty-state"><p>No meals match &ldquo;${esc(searchQ)}&rdquo;.</p></div>`;
  }

  const today = todayStr();
  for (const m of meals) {
    const eaten = m.lastEaten
      ? `eaten ${E.daysBetween(m.lastEaten, today)}d ago · ${m.timesEaten || 0}×`
      : "never eaten";
    html += `
      <div class="meal-card ${m.status === "benched" ? "benched" : ""}" data-id="${m.id}">
        <div class="m-name">${esc(m.name)}
          <span class="m-meta">${E.EFFORT_LABELS[m.effort]} · ${esc(m.protein)} · cook: ${esc(m.cook)}
            ${m.ingredients?.length ? ` · ${m.ingredients.length} ingredients` : " · no ingredients yet"}</span>
          <span class="m-eaten">${eaten}</span>
        </div>
        <button data-act="bench">${m.status === "benched" ? "unbench" : "bench"}</button>
        <button data-act="edit">edit</button>
      </div>`;
  }
  html += "</div>";
  $("#tab-meals").innerHTML = html;

  $("#mealSearch").addEventListener("input", (e) => {
    searchQ = e.target.value;
    renderMeals();
    const inp = $("#mealSearch");
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
}

$("#tab-meals").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "add") return openMealForm(null);
  const id = btn.closest(".meal-card")?.dataset.id;
  if (!id) return;
  if (btn.dataset.act === "edit") return openMealForm(id);
  if (btn.dataset.act === "bench") {
    const m = state.meals[id];
    commit({
      ...state,
      meals: {
        ...state.meals,
        [id]: { ...m, status: m.status === "benched" ? "active" : "benched", updatedAt: Date.now() },
      },
    });
  }
});

// ---------- meal form ----------

function openMealForm(id) {
  const existing = id ? state.meals[id] : null;
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
        name: "", effort: null, protein: "chicken", equipment: [], cook: "either",
        ingredients: [], notes: "", lastEaten: null, timesEaten: 0, status: "active",
      };

  const seg = (opts, sel, key, cls = "") =>
    `<div class="seg ${cls}" data-seg="${key}">` +
    opts.map((o) => `<button data-val="${o}" class="${(Array.isArray(sel) ? sel.includes(o) : sel === o) ? "on" : ""}">${o}</button>`).join("") +
    "</div>";

  overlay(`
    <div class="form-veil">
      <div class="meal-form">
        <h3>${existing ? "Edit meal" : "New meal"}</h3>
        <label class="f">Name</label>
        <input type="text" id="mfName" value="${esc(draft.name)}" placeholder="Sheet-pan fajitas" autocomplete="off" />
        <label class="f">Effort &mdash; no-cook counts as the plan working</label>
        ${seg(E.EFFORTS, draft.effort, "effort")}
        <label class="f">Protein</label>
        ${seg(["chicken", "beef", "pork", "seafood", "vegetarian", "mixed", "none"], draft.protein, "protein")}
        <label class="f">Who cooks</label>
        ${seg(["either", "greg", "angie", "together"], draft.cook, "cook", "sage")}
        <label class="f">Equipment (optional)</label>
        ${seg(["Stovetop", "Oven", "Air fryer", "Instant Pot", "Slow cooker", "Grill", "Microwave"], draft.equipment, "equipment")}
        <label class="f">Ingredients &mdash; optional now, needed for the shopping list</label>
        <div id="ingRows"></div>
        <div class="row" style="display:flex;gap:8px;margin:4px 0 10px">
          <button class="btn-ghost" id="mfAddRow">+ row</button>
        </div>
        <textarea class="paste-zone" id="mfPaste" placeholder="Or paste a list — one per line or comma-separated:&#10;1 lb ground beef&#10;1 onion, 2 cans black beans"></textarea>
        <div class="row" style="display:flex;gap:8px;margin-top:6px">
          <button class="btn-ghost" id="mfParse">Parse list</button>
        </div>
        <label class="f">Notes</label>
        <textarea id="mfNotes" rows="2">${esc(draft.notes || "")}</textarea>
        ${existing ? '<div class="row" style="margin-top:18px"><button class="btn-danger" id="mfDelete">Delete meal</button></div>' : ""}
        <div class="form-actions">
          <button class="btn-ghost" id="mfCancel">Cancel</button>
          <button class="btn-amber" id="mfSave">Save</button>
        </div>
      </div>
    </div>`);

  const dict = ingredientDict(state);

  // segmented controls
  document.querySelectorAll("#overlay .seg").forEach((segEl) => {
    segEl.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-val]");
      if (!b) return;
      const key = segEl.dataset.seg;
      const val = b.dataset.val;
      if (key === "equipment") {
        const i = draft.equipment.indexOf(val);
        i >= 0 ? draft.equipment.splice(i, 1) : draft.equipment.push(val);
        b.classList.toggle("on");
      } else {
        draft[key] = val;
        segEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      }
    });
  });

  // ingredient rows
  const rowsEl = $("#ingRows");
  function addRow(ing = { amount: "", name: "", cat: "Other", store: null }) {
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="ing-row">
        <input type="text" class="i-amt" placeholder="1 lb" value="${esc(ing.amount)}" />
        <input type="text" class="i-name" placeholder="ingredient" value="${esc(ing.name)}" autocomplete="off" />
        <button class="ing-x">&times;</button>
        <div class="ac-holder"></div>
      </div>
      <div class="ing-row-tags">
        <select class="i-cat">${E.CATEGORIES.map((c) => `<option ${c === ing.cat ? "selected" : ""}>${c}</option>`).join("")}</select>
        <select class="i-store">
          <option value="" ${!ing.store ? "selected" : ""}>either store</option>
          <option value="costco" ${ing.store === "costco" ? "selected" : ""}>Costco</option>
          <option value="meijer" ${ing.store === "meijer" ? "selected" : ""}>Meijer</option>
        </select>
      </div>`;
    row.querySelector(".ing-x").addEventListener("click", () => row.remove());
    const nameInput = row.querySelector(".i-name");
    const holder = row.querySelector(".ac-holder");
    nameInput.addEventListener("input", () => {
      const hits = autocomplete(dict, nameInput.value);
      holder.innerHTML = hits.length
        ? `<div class="autocomplete">${hits.map((h) =>
            `<button data-n="${esc(h.name)}" data-c="${esc(h.cat)}" data-s="${h.store || ""}">${esc(h.name)}<span class="ac-meta">${h.store ? E.STORE_LABELS[h.store] : ""} ${esc(h.cat)}</span></button>`
          ).join("")}</div>`
        : "";
    });
    holder.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-n]");
      if (!b) return;
      nameInput.value = b.dataset.n;
      row.querySelector(".i-cat").value = b.dataset.c;
      row.querySelector(".i-store").value = b.dataset.s;
      holder.innerHTML = "";
    });
    nameInput.addEventListener("blur", () => setTimeout(() => (holder.innerHTML = ""), 250));
    rowsEl.appendChild(row);
  }
  draft.ingredients.forEach(addRow);
  $("#mfAddRow").addEventListener("click", addRow.bind(null, undefined));
  $("#mfParse").addEventListener("click", () => {
    const parsed = parseIngredientList($("#mfPaste").value, dict);
    parsed.forEach(addRow);
    $("#mfPaste").value = "";
    if (!parsed.length) toast("Nothing to parse");
  });

  function collectIngredients() {
    return [...rowsEl.children]
      .map((row) => ({
        amount: row.querySelector(".i-amt").value.trim(),
        name: row.querySelector(".i-name").value.trim(),
        cat: row.querySelector(".i-cat").value,
        store: row.querySelector(".i-store").value || null,
      }))
      .filter((i) => i.name);
  }

  $("#mfCancel").addEventListener("click", closeOverlay);
  $("#mfSave").addEventListener("click", () => {
    draft.name = $("#mfName").value.trim();
    draft.notes = $("#mfNotes").value.trim();
    draft.ingredients = collectIngredients();
    if (!draft.name) return toast("Give it a name");
    if (!draft.effort) return toast("Pick an effort tier");
    draft.updatedAt = Date.now();
    commit({ ...state, meals: { ...state.meals, [draft.id]: draft } });
    closeOverlay();
    toast(existing ? "Saved" : `Added ${draft.name}`);
  });
  if (existing) {
    $("#mfDelete").addEventListener("click", () => {
      if (!confirm(`Delete "${existing.name}"? This removes it on both phones.`)) return;
      const meals = { ...state.meals };
      delete meals[existing.id];
      commit({
        ...state,
        meals,
        tombstones: { ...state.tombstones, [existing.id]: Date.now() },
      });
      closeOverlay();
    });
  }
}

// ---------- shopping tab ----------

function renderShop() {
  const wk = viewWeek;
  const sections = E.groceryList(state, wk);
  let html = `
    <div class="week-head">
      <h2>Shopping &mdash; ${fmtShort(wk)} week</h2>
      <div class="week-nav">
        <button data-act="wk-prev">&lsaquo;</button>
        <button data-act="wk-next">&rsaquo;</button>
        <button class="btn-ghost" data-act="copy" style="padding:6px 12px">copy</button>
      </div>
    </div>`;

  if (!sections.length) {
    html += `
      <div class="empty-state" style="margin-top:14px">
        <div class="big">Nothing to buy yet.</div>
        <p>Plan the week first &mdash; every planned meal's ingredients land here,
        grouped by store, in aisle order.</p>
      </div>`;
  }

  for (const sec of sections) {
    const all = sec.cats.flatMap((c) => c.items);
    const done = all.filter((i) => state.checked[E.checkedKey(wk, i.name)]?.v).length;
    html += `
      <div class="store-block">
        <div class="store-head">
          <h3>${E.STORE_LABELS[sec.store]}</h3>
          ${done === all.length && all.length ? '<span class="done-tag">done here</span>' : ""}
          <span class="count">${done}/${all.length}</span>
        </div>`;
    for (const cat of sec.cats) {
      html += `<div class="cat-label">${cat.cat}</div>`;
      for (const item of cat.items) {
        const key = E.checkedKey(wk, item.name);
        const isDone = !!state.checked[key]?.v;
        html += `
          <button class="shop-item ${isDone ? "done" : ""}" data-key="${esc(key)}">
            <span class="box">${isDone ? "&#10003;" : ""}</span>
            <span class="i-name">${esc(item.name)}</span>
            <span class="i-amt">${esc(E.amountLabel(item.amounts))}</span>
          </button>`;
      }
    }
    html += "</div>";
  }
  $("#tab-shop").innerHTML = html;
}

$("#tab-shop").addEventListener("click", (e) => {
  const nav = e.target.closest("button[data-act]");
  if (nav) {
    if (nav.dataset.act === "wk-prev") { viewWeek = E.addDays(viewWeek, -7); render(); }
    if (nav.dataset.act === "wk-next") { viewWeek = E.addDays(viewWeek, 7); render(); }
    if (nav.dataset.act === "copy") copyList();
    return;
  }
  const item = e.target.closest(".shop-item");
  if (!item) return;
  const key = item.dataset.key;
  const cur = state.checked[key]?.v || false;
  commit({
    ...state,
    checked: { ...state.checked, [key]: { v: !cur, updatedAt: Date.now() } },
  });
});

function copyList() {
  const sections = E.groceryList(state, viewWeek);
  const lines = [];
  for (const sec of sections) {
    lines.push(`== ${E.STORE_LABELS[sec.store]} ==`);
    for (const cat of sec.cats) {
      lines.push(`-- ${cat.cat}`);
      for (const item of cat.items) {
        const amt = E.amountLabel(item.amounts);
        lines.push(`[ ] ${item.name}${amt ? ` (${amt})` : ""}`);
      }
    }
    lines.push("");
  }
  const text = lines.join("\n").trim();
  if (!text) return toast("List is empty");
  navigator.clipboard?.writeText(text).then(
    () => toast("List copied"),
    () => toast("Copy failed — long-press to select instead")
  );
}

// ---------- settings tab ----------

function renderSettings() {
  const cfg = JSON.parse(localStorage.getItem(LS_SYNC) || "{}");
  const s = state.settings;
  $("#tab-settings").innerHTML = `
    <div class="set-block">
      <h3>Who's this phone?</h3>
      <div class="hint">Stamps a small initial on tickets you plan. Asked once, never again.</div>
      <div class="seg" id="whoSeg">
        <button data-who="greg" class="${whoami === "greg" ? "on" : ""}">Greg</button>
        <button data-who="angie" class="${whoami === "angie" ? "on" : ""}">Angie</button>
      </div>
    </div>

    <div class="set-block">
      <h3>Planning</h3>
      <label class="f">Don't repeat a meal within (weeks)</label>
      <input type="number" id="setRepeat" min="0" max="12" value="${s.noRepeatWeeks}" />
      <label class="f">Weekly mix floor &mdash; minimum standard-or-project nights (blank = off)</label>
      <input type="number" id="setFloor" min="0" max="7" value="${s.minStandardPlus ?? ""}" placeholder="off — set together with Angie" />
      <div class="hint">The floor is a joint number. Leave it off until you two pick it in the sit-down.</div>
      <div class="row"><button class="btn-amber" id="setSave">Save planning</button></div>
    </div>

    <div class="set-block">
      <h3>Two-phone sync</h3>
      <div class="hint">Syncs through a <b>private</b> GitHub repo. Each phone pastes its own
      token once. Setup steps are in the README next to this app.</div>
      <label class="f">GitHub owner</label>
      <input type="text" id="syOwner" value="${esc(cfg.owner || "")}" placeholder="gregoryjohnson513" autocapitalize="none" />
      <label class="f">Private repo name</label>
      <input type="text" id="syRepo" value="${esc(cfg.repo || "")}" placeholder="dinner-data" autocapitalize="none" />
      <label class="f">Fine-grained token (contents: read/write on that repo only)</label>
      <input type="password" id="syToken" value="${esc(cfg.token || "")}" placeholder="github_pat_&hellip;" />
      <div class="row">
        <button class="btn-amber" id="sySave">Save &amp; sync now</button>
        ${cfg.token ? '<button class="btn-danger" id="syClear">Forget token</button>' : ""}
      </div>
      <div class="mono-note ${syncStatus === "ok" ? "ok" : syncStatus === "err" ? "err" : ""}">
        ${syncStatus === "ok" ? `last synced ${lastSyncDetail}` : esc(lastSyncDetail || "not configured")}</div>
    </div>

    <div class="set-block">
      <h3>Data</h3>
      <div class="hint">Export before anything drastic. Import replaces everything on this phone
      (and, after the next sync, everywhere).</div>
      <div class="row">
        <button class="btn-ghost" id="dataExport">Copy export</button>
        <button class="btn-ghost" id="dataDownload">Download export</button>
      </div>
      <label class="f">Import &mdash; paste an export here</label>
      <textarea id="dataImport" rows="3" placeholder='{"schema":1,&hellip;}'></textarea>
      <div class="row"><button class="btn-danger" id="dataImportBtn">Import (replace)</button></div>
    </div>

    <div class="mono-note">dinner planner v1.2 &mdash; two-week rail</div>`;

  $("#whoSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-who]");
    if (!b) return;
    whoami = b.dataset.who;
    localStorage.setItem(LS_WHO, whoami);
    renderSettings();
  });

  $("#setSave").addEventListener("click", () => {
    const repeat = parseInt($("#setRepeat").value, 10);
    const floorRaw = $("#setFloor").value.trim();
    const floor = floorRaw === "" ? null : Math.max(0, parseInt(floorRaw, 10) || 0) || null;
    commit({
      ...state,
      settings: {
        ...state.settings,
        noRepeatWeeks: Number.isFinite(repeat) && repeat >= 0 ? repeat : 3,
        minStandardPlus: floor,
        updatedAt: Date.now(),
      },
    });
    toast("Planning saved");
  });

  $("#sySave").addEventListener("click", () => {
    const cfg2 = {
      owner: $("#syOwner").value.trim(),
      repo: $("#syRepo").value.trim(),
      token: $("#syToken").value.trim(),
    };
    if (!cfg2.owner || !cfg2.repo || !cfg2.token) return toast("All three fields needed");
    localStorage.setItem(LS_SYNC, JSON.stringify(cfg2));
    doSync(true);
  });
  $("#syClear")?.addEventListener("click", () => {
    localStorage.removeItem(LS_SYNC);
    syncStatus = "off";
    lastSyncDetail = "";
    renderSettings();
    renderChip();
  });

  $("#dataExport").addEventListener("click", () => {
    navigator.clipboard?.writeText(JSON.stringify(state)).then(
      () => toast("Export copied"),
      () => toast("Copy failed")
    );
  });
  $("#dataDownload").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dinner-export-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#dataImportBtn").addEventListener("click", () => {
    let parsed;
    try {
      parsed = JSON.parse($("#dataImport").value);
    } catch {
      return toast("That's not valid JSON");
    }
    if (!parsed || parsed.schema !== 1 || typeof parsed.meals !== "object") {
      return toast("Doesn't look like a dinner export");
    }
    if (!confirm("Replace everything on this phone with the pasted export?")) return;
    commit(mergeStates(parsed, null));
    toast("Imported");
  });
}

// ---------- overlay plumbing ----------

function overlay(html) {
  $("#overlay").innerHTML = html;
  $("#overlay").firstElementChild?.addEventListener("click", (e) => {
    if (e.target.dataset.close) closeOverlay();
  });
}
function closeOverlay() {
  $("#overlay").innerHTML = "";
}

// ---------- identity first-run ----------

function maybeAskWho() {
  if (whoami) return false;
  overlay(`
    <div class="sheet-veil" style="align-items:center">
      <div class="who-card">
        <h3>Who's this?</h3>
        <p>One tap, once. It signs your picks with a small initial &mdash; that's all it does.</p>
        <div class="row">
          <button data-who="greg">Greg</button>
          <button data-who="angie">Angie</button>
        </div>
      </div>
    </div>`);
  $("#overlay .who-card").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-who]");
    if (!b) return;
    whoami = b.dataset.who;
    localStorage.setItem(LS_WHO, whoami);
    closeOverlay();
    maybeReconcile();
  });
  return true;
}

// ---------- boot ----------

render();
if (!maybeAskWho()) maybeReconcile();
doSync();
