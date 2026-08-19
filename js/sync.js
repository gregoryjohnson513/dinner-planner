// sync.js — two-phone sync through a PRIVATE GitHub repo (Contents API).
// Approved destination for dinner data only (Greg, 2026-08-19). Never cache
// api.github.com responses in the service worker; the token lives in
// localStorage on each phone and is entered by its owner, never by the app.
//
// Flow: pull -> merge(local, remote) -> save locally -> push if changed,
// with sha-based optimistic concurrency and re-merge on conflict.

import { mergeStates } from "./merge.js";

const API = "https://api.github.com";
const MAX_PUSH_RETRIES = 3;

// cfg: { owner, repo, path, token }  fetchFn injected for tests.
export function makeClient(cfg, fetchFn = fetch) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function pull() {
    const res = await fetchFn(url, { headers, cache: "no-store" });
    if (res.status === 404) return { state: null, sha: null };
    if (res.status === 401 || res.status === 403) throw new SyncError("auth", res.status);
    if (!res.ok) throw new SyncError("pull", res.status);
    const body = await res.json();
    const raw = decodeB64(body.content);
    let state = null;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new SyncError("corrupt", 200); // never merge over a corrupt remote
    }
    return { state, sha: body.sha };
  }

  async function push(state, sha) {
    const content = encodeB64(JSON.stringify(state, null, 1));
    const body = { message: "sync", content, ...(sha ? { sha } : {}) };
    const res = await fetchFn(url, { method: "PUT", headers, body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) throw new SyncError("conflict", res.status);
    if (res.status === 401 || res.status === 403) throw new SyncError("auth", res.status);
    if (!res.ok) throw new SyncError("push", res.status);
    const out = await res.json();
    return out.content?.sha || null;
  }

  return { pull, push };
}

export class SyncError extends Error {
  constructor(kind, status) {
    super(`sync ${kind} (${status})`);
    this.kind = kind;
    this.status = status;
  }
}

// One full sync pass. Returns { state, pushed, status }.
// status: "synced" | "pulled" | "nochange"
export async function syncOnce(client, localState) {
  let { state: remote, sha } = await client.pull();
  let merged = mergeStates(localState, remote);

  for (let attempt = 0; ; attempt++) {
    const localJson = JSON.stringify(merged);
    if (remote && JSON.stringify(mergeStates(remote, merged)) === JSON.stringify(remote)) {
      // Remote already contains everything we have.
      const pulledSomething = localJson !== JSON.stringify(localState);
      return { state: merged, pushed: false, status: pulledSomething ? "pulled" : "nochange" };
    }
    try {
      await client.push(merged, sha);
      return { state: merged, pushed: true, status: "synced" };
    } catch (e) {
      if (e instanceof SyncError && e.kind === "conflict" && attempt < MAX_PUSH_RETRIES) {
        ({ state: remote, sha } = await client.pull());
        merged = mergeStates(merged, remote);
        continue;
      }
      throw e;
    }
  }
}

// UTF-8-safe base64 for browser and Node.
export function encodeB64(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeB64(b64) {
  const clean = String(b64).replace(/\s/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf8");
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
