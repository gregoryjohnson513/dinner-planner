// engine.js — pure planning logic. No DOM, no storage, no network.
// Every function takes state/dates as arguments so tests control time.

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const EFFORTS = ["nocook", "quick", "standard", "project"];
export const EFFORT_LABELS = {
  nocook: "No-cook",
  quick: "Quick",
  standard: "Standard",
  project: "Project",
};

// Store-aisle order, per spec. Within each store section, group by these.
export const CATEGORIES = [
  "Produce",
  "Meat & seafood",
  "Dairy & eggs",
  "Pantry",
  "Frozen",
  "Bakery",
  "Other",
];

export const STORES = ["costco", "meijer"]; // null = Anywhere
export const STORE_LABELS = { costco: "Costco", meijer: "Meijer", anywhere: "Anywhere" };

const MS_DAY = 24 * 60 * 60 * 1000;
const WEIGHT_CAP = 400;

// ---------- dates ----------
// All date strings are local "YYYY-MM-DD". Noon anchoring dodges DST edges.

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sunday that starts the week containing dateStr. Week starts Sunday (settled 8/5).
export function weekKeyFor(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - d.getDay());
  return fmtDate(d);
}

export function dateForDay(weekKey, dayName) {
  const d = parseDate(weekKey);
  d.setDate(d.getDate() + DAYS.indexOf(dayName));
  return fmtDate(d);
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / MS_DAY);
}

// ---------- state shape ----------

export function emptyState() {
  return {
    schema: 1,
    meals: {}, // id -> meal
    weeks: {}, // weekKey -> { Sun: {mealId, by, resolved, updatedAt}|undefined, ... }
    checked: {}, // "weekKey::normName" -> { v: bool, updatedAt }
    settings: {
      noRepeatWeeks: 3,
      minStandardPlus: null, // mix floor. Ships null (off) until the joint interview.
      lookbackWeeks: 1, // reconciliation window: current week + N prior
      updatedAt: 0,
    },
    tombstones: {}, // mealId -> deletedAt
  };
}

export function normName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function checkedKey(weekKey, ingredientName) {
  // Deliberately excludes store/category: retagging an ingredient mid-week
  // must not orphan its checkmark. Grouping is computed at render time.
  return `${weekKey}::${normName(ingredientName)}`;
}

// ---------- meal queries ----------

export function activeMeals(state) {
  return Object.values(state.meals).filter((m) => m.status === "active");
}

export function plannedMealIds(state, weekKey) {
  const week = state.weeks[weekKey] || {};
  const ids = new Set();
  for (const day of DAYS) {
    const slot = week[day];
    if (slot && slot.mealId) ids.add(slot.mealId);
  }
  return ids;
}

function eatenTooRecently(meal, todayStr, noRepeatWeeks) {
  if (!meal.lastEaten || !noRepeatWeeks) return false;
  return daysBetween(meal.lastEaten, todayStr) < noRepeatWeeks * 7;
}

// filters: { maxQuick: bool ("<=30 min" -> nocook|quick only), cook: "greg"|"angie"|"together"|null,
//            efforts: [tier,...]|null (restrict to these tiers) }
// Meals on still-open (unresolved) day slots — the plans that are "spoken for".
export function unresolvedPlannedIds(state, weekKey) {
  const week = state.weeks[weekKey] || {};
  const ids = new Set();
  for (const day of DAYS) {
    const slot = week[day];
    if (slot && slot.mealId && !slot.resolved) ids.add(slot.mealId);
  }
  return ids;
}

// Dedupe horizon: never twice in the same week; when no-repeat is on, meals
// still SPOKEN FOR in an adjacent week are excluded too, so a two-week plan
// doesn't repeat across its boundary. Resolved slots don't block: a skipped
// night releases its meal, and a cooked night is already handled by the
// eaten-recency rule.
export function candidateMeals(state, weekKey, todayStr, filters = {}) {
  const noRepeat = state.settings.noRepeatWeeks;
  const excluded = new Set(plannedMealIds(state, weekKey));
  if (noRepeat >= 1) {
    for (const adjacent of [addDays(weekKey, -7), addDays(weekKey, 7)]) {
      for (const id of unresolvedPlannedIds(state, adjacent)) excluded.add(id);
    }
  }
  return activeMeals(state).filter((m) => {
    if (excluded.has(m.id)) return false;
    if (eatenTooRecently(m, todayStr, noRepeat)) return false;
    if (filters.maxQuick && m.effort !== "nocook" && m.effort !== "quick") return false;
    if (filters.cook && m.cook !== filters.cook && m.cook !== "either") return false;
    if (filters.efforts && !filters.efforts.includes(m.effort)) return false;
    return true;
  });
}

export function suggestionWeight(meal, todayStr) {
  if (!meal.lastEaten) return WEIGHT_CAP;
  const days = daysBetween(meal.lastEaten, todayStr);
  return Math.max(1, Math.min(days, WEIGHT_CAP));
}

// rng: () => [0,1). Injected for testability.
export function pickWeighted(meals, todayStr, rng) {
  if (!meals.length) return null;
  const weights = meals.map((m) => suggestionWeight(m, todayStr));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < meals.length; i++) {
    r -= weights[i];
    if (r < 0) return meals[i];
  }
  return meals[meals.length - 1];
}

export function suggestFor(state, weekKey, todayStr, filters, rng) {
  return pickWeighted(candidateMeals(state, weekKey, todayStr, filters), todayStr, rng);
}

// ---------- planning mutations (pure: return changed state, caller persists) ----------

export function planDay(state, weekKey, dayName, mealId, by, now) {
  const week = { ...(state.weeks[weekKey] || {}) };
  week[dayName] = { mealId, by: by || null, resolved: false, updatedAt: now };
  return { ...state, weeks: { ...state.weeks, [weekKey]: week } };
}

export function clearDay(state, weekKey, dayName, now) {
  const week = { ...(state.weeks[weekKey] || {}) };
  // Keep a stamped empty slot (not undefined) so the clear wins a sync merge.
  week[dayName] = { mealId: null, by: null, resolved: false, updatedAt: now };
  return { ...state, weeks: { ...state.weeks, [weekKey]: week } };
}

// Clears every planned-but-unresolved day in one shot ("start over").
// Resolved days (cooked/skipped) stay — they're the week's record, and their
// recency stamps already live on the meals. Cleared slots carry a fresh
// updatedAt so the clear wins the sync merge on the other phone.
export function clearWeek(state, weekKey, now) {
  const week = state.weeks[weekKey] || {};
  const cleared = { ...week };
  let changed = false;
  for (const day of DAYS) {
    const slot = week[day];
    if (slot && slot.mealId && !slot.resolved) {
      cleared[day] = { mealId: null, by: null, resolved: false, updatedAt: now };
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, weeks: { ...state.weeks, [weekKey]: cleared } };
}

// ---------- fill empty days + mix floor ----------

export function weekMix(state, weekKey) {
  const counts = { nocook: 0, quick: 0, standard: 0, project: 0 };
  for (const id of plannedMealIds(state, weekKey)) {
    const m = state.meals[id];
    if (m && counts[m.effort] !== undefined) counts[m.effort] += 1;
  }
  return counts;
}

export function standardPlusCount(state, weekKey) {
  const mix = weekMix(state, weekKey);
  return mix.standard + mix.project;
}

// Fills empty day slots respecting filters, then enforces settings.minStandardPlus
// by swapping ITS OWN lowest-effort picks for standard+ candidates. Pre-existing
// (human-planned) days are never touched. Single-day Suggest is unaffected.
export function fillWeek(state, weekKey, todayStr, filters, rng, by, now) {
  let s = state;
  const myPicks = []; // { day, mealId }
  for (const day of DAYS) {
    const slot = (s.weeks[weekKey] || {})[day];
    if (slot && slot.mealId) continue;
    const meal = suggestFor(s, weekKey, todayStr, filters, rng);
    if (!meal) break; // library exhausted under current filters
    s = planDay(s, weekKey, day, meal.id, by, now);
    myPicks.push({ day, mealId: meal.id });
  }

  const floor = s.settings.minStandardPlus;
  if (floor) {
    // Lowest-effort own picks first, so a rotisserie night is the first swap out.
    const rank = { nocook: 0, quick: 1, standard: 2, project: 3 };
    const swappable = myPicks
      .filter((p) => rank[s.meals[p.mealId]?.effort] < 2)
      .sort((a, b) => rank[s.meals[a.mealId].effort] - rank[s.meals[b.mealId].effort]);
    for (const pick of swappable) {
      if (standardPlusCount(s, weekKey) >= floor) break;
      // Floor overrides the <=30-min filter for the swap: it cannot be satisfied
      // inside nocook/quick by definition. Other filters still apply.
      const swapFilters = { ...filters, maxQuick: false, efforts: ["standard", "project"] };
      const candidates = candidateMeals(s, weekKey, todayStr, swapFilters);
      const replacement = pickWeighted(candidates, todayStr, rng);
      if (!replacement) break; // no standard+ candidates left; floor unmet, report via mix UI
      s = planDay(s, weekKey, pick.day, replacement.id, by, now);
    }
  }
  return s;
}

// ---------- reconciliation (primary feed for the recency engine) ----------

// Planned days earlier than today, within the lookback window, not yet resolved,
// and whose meal wasn't stamped cooked on-or-after the planned date.
export function reconciliationQueue(state, todayStr) {
  const lookback = state.settings.lookbackWeeks ?? 1;
  const thisWeek = weekKeyFor(todayStr);
  const earliest = addDays(thisWeek, -7 * lookback);
  const out = [];
  for (const [weekKey, week] of Object.entries(state.weeks)) {
    if (weekKey < earliest || weekKey > thisWeek) continue;
    for (const day of DAYS) {
      const slot = week[day];
      if (!slot || !slot.mealId || slot.resolved) continue;
      const date = dateForDay(weekKey, day);
      if (date >= todayStr) continue;
      const meal = state.meals[slot.mealId];
      if (!meal) continue;
      if (meal.lastEaten && meal.lastEaten >= date) continue; // already stamped in the moment
      out.push({ weekKey, day, date, mealId: slot.mealId, name: meal.name });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// "Made it" — cooked stamp backdated to the planned day.
export function resolveMade(state, weekKey, dayName, now) {
  const week = { ...(state.weeks[weekKey] || {}) };
  const slot = week[dayName];
  if (!slot || !slot.mealId) return state;
  const date = dateForDay(weekKey, dayName);
  const meal = state.meals[slot.mealId];
  const meals = { ...state.meals };
  if (meal) {
    meals[meal.id] = {
      ...meal,
      lastEaten: meal.lastEaten && meal.lastEaten > date ? meal.lastEaten : date,
      timesEaten: (meal.timesEaten || 0) + 1,
      updatedAt: now,
    };
  }
  week[dayName] = { ...slot, resolved: true, updatedAt: now };
  return { ...state, meals, weeks: { ...state.weeks, [weekKey]: week } };
}

// "Skipped" — clears the prompt, touches nothing else.
export function resolveSkipped(state, weekKey, dayName, now) {
  const week = { ...(state.weeks[weekKey] || {}) };
  const slot = week[dayName];
  if (!slot) return state;
  week[dayName] = { ...slot, resolved: true, updatedAt: now };
  return { ...state, weeks: { ...state.weeks, [weekKey]: week } };
}

// In-the-moment Cooked stamp (kept, but no longer load-bearing).
export function stampCooked(state, weekKey, dayName, todayStr, now) {
  const week = { ...(state.weeks[weekKey] || {}) };
  const slot = week[dayName];
  if (!slot || !slot.mealId) return state;
  const meal = state.meals[slot.mealId];
  if (!meal) return state;
  const meals = { ...state.meals };
  meals[meal.id] = {
    ...meal,
    lastEaten: meal.lastEaten && meal.lastEaten > todayStr ? meal.lastEaten : todayStr,
    timesEaten: (meal.timesEaten || 0) + 1,
    updatedAt: now,
  };
  week[dayName] = { ...slot, resolved: true, updatedAt: now };
  return { ...state, meals, weeks: { ...state.weeks, [weekKey]: week } };
}

// ---------- grocery list ----------

// Grouped store -> category -> deduped items. store null renders under "anywhere".
export function groceryList(state, weekKey) {
  const items = new Map(); // normName -> { name, amounts: [], store, cat }
  for (const id of plannedMealIds(state, weekKey)) {
    const meal = state.meals[id];
    if (!meal) continue;
    for (const ing of meal.ingredients || []) {
      const key = normName(ing.name);
      if (!key) continue;
      let item = items.get(key);
      if (!item) {
        item = {
          name: ing.name.trim(),
          amounts: [],
          store: ing.store || null,
          cat: CATEGORIES.includes(ing.cat) ? ing.cat : "Other",
        };
        items.set(key, item);
      }
      if (ing.amount && ing.amount.trim()) item.amounts.push(ing.amount.trim());
    }
  }

  const sections = []; // { store, cats: [{ cat, items: [...] }] }
  for (const store of [...STORES, "anywhere"]) {
    const inStore = [...items.values()].filter((i) => (i.store || "anywhere") === store);
    if (!inStore.length) continue;
    const cats = [];
    for (const cat of CATEGORIES) {
      const inCat = inStore
        .filter((i) => i.cat === cat)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (inCat.length) cats.push({ cat, items: inCat });
    }
    sections.push({ store, cats });
  }
  return sections;
}

// "1 lb + 2 lb", by design. Unit math waits until the rotation is proven.
export function amountLabel(amounts) {
  return amounts.join(" + ");
}
