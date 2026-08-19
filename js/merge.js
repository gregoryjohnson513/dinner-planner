// merge.js — two-phone state merge. Pure, deterministic, no I/O.
//
// Model: last-write-wins per entity, using per-entity updatedAt (ms epoch).
// Entities: each meal, each day slot, each checked key, settings (whole),
// tombstones (a tombstone beats any older meal write; a newer meal write
// resurrects nothing — deletes are final unless re-created with a new id).

import { emptyState, DAYS } from "./engine.js";

function newer(a, b) {
  return (a?.updatedAt || 0) >= (b?.updatedAt || 0) ? a : b;
}

export function mergeStates(local, remote) {
  const a = local || emptyState();
  const b = remote || emptyState();
  const out = emptyState();

  // tombstones: union, latest deletedAt wins
  for (const src of [a.tombstones || {}, b.tombstones || {}]) {
    for (const [id, t] of Object.entries(src)) {
      if (!out.tombstones[id] || t > out.tombstones[id]) out.tombstones[id] = t;
    }
  }

  // meals: LWW per id; a tombstone newer than the winning write removes it
  const mealIds = new Set([...Object.keys(a.meals || {}), ...Object.keys(b.meals || {})]);
  for (const id of mealIds) {
    const winner = newer(a.meals?.[id], b.meals?.[id]);
    if (!winner) continue;
    const dead = out.tombstones[id];
    if (dead && dead >= (winner.updatedAt || 0)) continue;
    out.meals[id] = winner;
  }

  // weeks: LWW per day slot
  const weekKeys = new Set([...Object.keys(a.weeks || {}), ...Object.keys(b.weeks || {})]);
  for (const wk of weekKeys) {
    const wa = a.weeks?.[wk] || {};
    const wb = b.weeks?.[wk] || {};
    const merged = {};
    for (const day of DAYS) {
      const winner = newer(wa[day], wb[day]);
      if (winner) merged[day] = winner;
    }
    if (Object.keys(merged).length) out.weeks[wk] = merged;
  }

  // checked: LWW per key
  const checkKeys = new Set([...Object.keys(a.checked || {}), ...Object.keys(b.checked || {})]);
  for (const k of checkKeys) {
    const winner = newer(a.checked?.[k], b.checked?.[k]);
    if (winner) out.checked[k] = winner;
  }

  // settings: LWW whole-object (fields change rarely; per-field adds risk, not value)
  out.settings = newer(a.settings, b.settings) || out.settings;

  out.schema = Math.max(a.schema || 1, b.schema || 1);
  return out;
}

// Drop weeks/checked older than the retention horizon so the sync file
// stays small. Meals and their lastEaten are never pruned — recency is the point.
export function pruneState(state, todayWeekKey, keepWeeks = 26) {
  const out = { ...state, weeks: {}, checked: {} };
  const horizon = shiftWeek(todayWeekKey, -keepWeeks);
  for (const [wk, week] of Object.entries(state.weeks || {})) {
    if (wk >= horizon) out.weeks[wk] = week;
  }
  for (const [key, val] of Object.entries(state.checked || {})) {
    const wk = key.split("::")[0];
    if (wk >= horizon) out.checked[key] = val;
  }
  return out;
}

function shiftWeek(weekKey, weeks) {
  const [y, m, d] = weekKey.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  date.setDate(date.getDate() + weeks * 7);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
