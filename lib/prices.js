"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, apiBase, validKey } = require("./auth.js").walletSupport;

// Keep these credential and response checks aligned with call.js.
function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
}

function hasCredential(value, keys = []) {
  let text = value;
  while (true) {
    if (/opsfy_sk_[0-9a-f]{64}/.test(text) || keys.some(key => key && text.includes(key))) return true;
    const decoded = text.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) return false;
    text = decoded;
  }
}

function envelope(response, url) {
  if (response.url !== url || response.redirected !== false ||
      response.headers.get("content-type") !== "application/json; charset=utf-8" ||
      response.headers.get("cache-control") !== "no-store") return false;
  for (const name of response.headers.keys()) {
    if (["cookie", "set-cookie", "set-cookie2", "location", "retry-after"].includes(name) ||
        name.startsWith("access-control-allow-")) return false;
  }
  return response.headers.get("allow") === null;
}

function savedKey() {
  const store = new Store();
  try {
    fs.lstatSync(store.file("key"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parent = fs.lstatSync(path.dirname(store.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    store.prepare();
    store.acquire();
    const state = store.load();
    return state.pending ? null : state.key;
  } finally {
    store.release();
  }
}

async function request(url, key) {
  const controller = new AbortController();
  const options = { method: "GET", redirect: "error", signal: controller.signal,
    headers: { accept: "application/json", authorization: "Bearer " + key } };
  let timer, response, consumed = false;
  const abort = () => {
    controller.abort();
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { abort(); reject(new Error()); }, 5000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetch(url, options);
      if (controller.signal.aborted || !envelope(response, url)) {
        abort();
        throw new Error();
      }
      const body = JSON.parse(await response.text());
      consumed = true;
      if (controller.signal.aborted) throw new Error();
      if (response.status === 401 && exact(body, ["ok", "error"]) &&
          body.ok === false && body.error === "invalid_key") return { state: "login_required" };
      if (response.status !== 200 || !exact(body, ["ok", "prices"]) || body.ok !== true ||
          body.prices === null || typeof body.prices !== "object" || Array.isArray(body.prices) ||
          !Object.values(body.prices).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error();
      return { state: "shown", prices: body.prices };
    })()]);
  } finally {
    clearTimeout(timer);
    if (!consumed) abort();
  }
}

async function load() {
  if (process.env.OPSFY_DRY_RUN === "1") return { state: "unavailable" };
  try {
    const environmentKey = process.env.OPSFY_API_KEY || "";
    if (environmentKey && !validKey(environmentKey)) return { state: "login_required" };
    const key = environmentKey || savedKey();
    if (!key) return { state: "login_required" };
    const url = apiBase() + "/api/prices";
    if (hasCredential(url, [key])) return { state: "unavailable" };
    return await request(url, key);
  } catch {
    return { state: "unavailable" };
  }
}

module.exports = { load };
