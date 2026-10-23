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

function metering(value, maximum) {
  if (["dynamic", "input_usd"].includes(value?.model)) return exact(value, ["model", "rates", "max_hold_microusd"]) && maximum === null &&
    value.max_hold_microusd === null && Array.isArray(value.rates) && value.rates.length === 0;
  const choices = value && Object.hasOwn(value, "choice_holds_microusd");
  if (choices) {
    const map = value.choice_holds_microusd;
    if (!map || typeof map !== "object" || Array.isArray(map) || !Object.keys(map).length || Object.keys(map).length > 16 ||
        !Object.entries(map).every(([name, holds]) => /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) &&
          !["constructor", "prototype"].includes(name) && holds && typeof holds === "object" && !Array.isArray(holds) &&
          Object.keys(holds).length >= 1 && Object.keys(holds).length <= 32 &&
          Object.entries(holds).every(([choice, hold]) => choice.trim().length > 0 && [...choice].length <= 131072 &&
            !/[\p{Cc}\p{Cf}]/u.test(choice) && Number.isSafeInteger(hold) && hold > 0) &&
          Math.max(...Object.values(holds)) === maximum)) return false;
  }
  return exact(value, ["model", "rates", "max_hold_microusd", ...(choices ? ["choice_holds_microusd"] : [])]) &&
    ["per_call", "per_unit", "reported_cost", "input_rates"].includes(value.model) &&
    Number.isSafeInteger(value.max_hold_microusd) && value.max_hold_microusd > 0 && value.max_hold_microusd === maximum &&
    Array.isArray(value.rates) && value.rates.length >= 1 && value.rates.length <= 4 &&
    value.rates.every(rate => exact(rate, ["unit", "microusd", "units"]) &&
      typeof rate.unit === "string" && rate.unit.trim().length > 0 && [...rate.unit].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(rate.unit) &&
      Number.isSafeInteger(rate.microusd) && rate.microusd > 0 && Number.isSafeInteger(rate.units) && rate.units > 0) &&
    (value.model !== "per_call" || (value.rates.length === 1 && value.rates[0].unit === "call" &&
      value.rates[0].microusd === maximum && value.rates[0].units === 1));
}

function quote(value, rental = false, serverless = false) {
  if (serverless) return require("./serverless.js").PRICE;
  if (rental) return require("./rentals.js").PRICE;
  if (value.model === "input_usd") return "the run holds the maximum from max_usd, then charges actual use up to that hold; reading results has a separate hold and charge shown with the result";
  if (value.model === "dynamic") return "price depends on the model and inputs; the call reads the current price and holds its maximum, then charges actual use; a refusal or failure at the start costs nothing unless the company reports a usable charge; an unanswered start pays the hold; a complete Jev answer with no usable figure pays the hold, while OpenRouter chat recovers from its generation record";
  const { money } = require("./call.js");
  const choices = value.choice_holds_microusd ? ": " + Object.entries(value.choice_holds_microusd).flatMap(([name, holds]) =>
    Object.entries(holds).map(([choice, hold]) => `${name}=${choice} ${money(hold).replace(/(\.\d{2,}?)0+$/, "$1")}`)).join(", ") : "";
  return value.rates.map(rate => `${money(rate.microusd)} per ${String(rate.units).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${rate.unit}`).join("; ") +
    ` · holds up to ${money(value.max_hold_microusd)} per call${choices}; charges actual use, or the full hold when use is not reported`;
}

async function request(url, key) {
  const controller = new AbortController();
  const options = { method: "GET", redirect: "error", signal: controller.signal,
    headers: { accept: "application/json", authorization: "Bearer " + key, "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1", "Opsfy-Chat": "chat-v1", "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1", "Opsfy-Rentals": "rentals-v1", "Opsfy-Text": "text-v1", "Opsfy-USD": "usd-v1", "Opsfy-Serverless": "serverless-v1" } };
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
      const metered = body !== null && typeof body === "object" && Object.hasOwn(body, "metering");
      if (response.status !== 200 || !exact(body, ["ok", "prices", ...(metered ? ["metering"] : [])]) || body.ok !== true ||
          body.prices === null || typeof body.prices !== "object" || Array.isArray(body.prices) ||
          !Object.entries(body.prices).every(([slug, value]) => ["openrouter", "jev", "runpod", "apify", "runpod-serverless"].includes(slug) && value === null ? metered && metering(body.metering?.[slug], value) : Number.isSafeInteger(value) && value > 0)) throw new Error();
      if (metered && (!exact(body.metering, Object.keys(body.prices)) ||
          !Object.entries(body.metering).every(([slug, value]) => metering(value, body.prices[slug])) ||
          hasCredential(JSON.stringify(body.metering), [key]))) throw new Error();
      return { state: "shown", prices: body.prices, ...(metered ? { metering: body.metering } : {}) };
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

module.exports = { load, savedKey, hasCredential, envelope, quote };
