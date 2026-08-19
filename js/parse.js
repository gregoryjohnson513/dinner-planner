// parse.js — meal-entry helpers. The adoption-risk killers:
// paste-a-list parsing and an ingredient dictionary that carries each
// ingredient's category + store tag forward so they're set once, ever.

import { normName, CATEGORIES } from "./engine.js";

// Matches a leading quantity: "1", "1.5", "1/2", "1 1/2", optionally a unit word
// or common abbreviations, e.g. "2 lb", "1 can", "3", "1/2 cup".
const QTY = String.raw`\d+(?:[./]\d+)?(?:\s+\d/\d)?`;
const UNIT = String.raw`(?:lbs?|oz|g|kg|cups?|tbsp|tsp|cans?|jars?|bags?|boxe?s?|bunche?s?|cloves?|heads?|pkgs?|packs?|dozen|qt|pt|gal|ml|l|sticks?|slices?|pieces?|ears?|stalks?)\.?`;
const AMOUNT_RE = new RegExp(`^(${QTY}(?:\\s*${UNIT})?)\\s+(.+)$`, "i");

export function parseIngredientLine(line, dict = {}) {
  const cleaned = line.replace(/^[-*•]\s*/, "").trim();
  if (!cleaned) return null;
  const m = cleaned.match(AMOUNT_RE);
  const amount = m ? m[1].trim() : "";
  const name = (m ? m[2] : cleaned).trim();
  const known = dict[normName(name)];
  return {
    amount,
    name,
    cat: known?.cat && CATEGORIES.includes(known.cat) ? known.cat : "Other",
    store: known?.store ?? null,
  };
}

export function parseIngredientList(text, dict = {}) {
  return text
    .split(/\r?\n|,(?![^(]*\))/) // newlines, or commas outside parentheses
    .map((l) => parseIngredientLine(l, dict))
    .filter(Boolean);
}

// Dictionary of every ingredient ever entered, most recently updated meal wins.
// Carries { cat, store } per normalized name.
export function ingredientDict(state) {
  const dict = {};
  const meals = Object.values(state.meals).sort(
    (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)
  );
  for (const meal of meals) {
    for (const ing of meal.ingredients || []) {
      const key = normName(ing.name);
      if (!key) continue;
      dict[key] = { cat: ing.cat || "Other", store: ing.store ?? null, name: ing.name.trim() };
    }
  }
  return dict;
}

// Prefix-then-substring autocomplete over the dictionary.
export function autocomplete(dict, fragment, limit = 6) {
  const q = normName(fragment);
  if (!q) return [];
  const names = Object.keys(dict);
  const starts = names.filter((n) => n.startsWith(q));
  const contains = names.filter((n) => !n.startsWith(q) && n.includes(q));
  return [...starts, ...contains].slice(0, limit).map((n) => ({ key: n, ...dict[n] }));
}
