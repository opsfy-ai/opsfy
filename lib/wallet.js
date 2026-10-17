"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { Store, Refusal, apiBase, validKey, line, errorCode } = require("./auth.js").walletSupport;
const { out, err } = require("./output.js");
const { Answer } = require("./answer.js");
const { money: balanceMoney } = require("./call.js");

const WORDS = Object.freeze({
  "amount": "a top-up is $10, $25, $50, $100, $250 or $500; none was started · ask the person which amount, then run opsfy topup <amount> --json",
  "unavailable": "opsfy.ai cannot start a top-up right now; nothing was charged · wait 60 seconds, then run the same command again",
  "unavailableChecking": "opsfy.ai cannot read top-up <id> right now; a payment still counts · wait 60 seconds, then run opsfy topup status <id> --json",
  "storage": "opsfy.ai could not start the top-up; nothing was charged · wait 60 seconds, then run the same command again",
  "storageChecking": "opsfy.ai could not read top-up <id>; a payment still counts · wait 60 seconds, then run opsfy topup status <id> --json",
  "badRequest": "opsfy.ai could not read this CLI's request · run npm i -g @opsfy/cli@latest, then read https://opsfy.ai/SKILL.md again",
  "page": "top-up <id> · open · <money> · pay at <url> until <until>",
  "pageAgent": "top-up <id> · open · <money> · pay at <url> until <until> · ask the person to pay there, then run opsfy topup wait <id> --json",
  "prompt": "Top up $10, $25, $50, $100, $250 or $500 USD:",
  "reask": "choose $10, $25, $50, $100, $250 or $500 USD",
  "missingAmount": "no amount given; a top-up is $10, $25, $50, $100, $250 or $500 · ask the person which amount, then run opsfy topup <amount> --json",
  "cancelled": "stopped before an amount was chosen; no top-up was started and nothing was charged · run opsfy topup <amount> --json",
  "dry": "OPSFY_DRY_RUN=1 is set, so topup does not run · unset OPSFY_DRY_RUN to run it",
  "topupUsage": "more than one amount given · run opsfy topup <amount> --json with one amount",
  "waitUsage": "the top-up id is missing or malformed · run opsfy topup wait <id> --json with the id opsfy topup gave",
  "statusUsage": "the top-up id is missing or malformed · run opsfy topup status <id> --json with the id opsfy topup gave",
  "waiting": "waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts",
  "opened": "opened the payment page in the browser · waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts",
  "payment": "top-up <id> · paid · +<money> · balance <balance> USD",
  "closed": "top-up <id> · cancelled · <money> · nothing was charged · ask the person whether to try again, then run opsfy topup <dollars> --json",
  "expired": "top-up <id> · expired · <money> · nothing was charged · ask the person whether to try again, then run opsfy topup <dollars> --json",
  "open": "top-up <id> · open · <money> · not paid yet; pay at <url> until <until> · run opsfy topup wait <id> --json to wait again",
  "stopped": "stopped waiting for top-up <id>; a payment still counts · run opsfy topup status <id> --json",
  "unknown": "this account has no top-up <id> · run opsfy topup status <id> --json with an id opsfy topup gave on this account"
});
const AMOUNTS = new Set([1000, 2500, 5000, 10000, 25000, 50000]);
const ERROR_CODES = Object.freeze({
  amount: "invalid_amount", unavailable: "topup_unavailable", storage: "balance_unavailable",
  unavailableChecking: "topup_unavailable", storageChecking: "balance_unavailable",
  badRequest: "update_needed", missingAmount: "amount_needed", cancelled: "cancelled", dry: "dry_run",
  topupUsage: "usage", waitUsage: "usage", statusUsage: "usage",
  unknown: "unknown_topup", stopped: "stopped_waiting",
});

class WalletRefusal extends Error {
  constructor(word, status = 1, values = {}) {
    if (values.id !== undefined && ["unavailable", "storage"].includes(word)) word += "Checking";
    super(word);
    this.word = word;
    this.status = status;
    this.values = values;
  }
}

function refuse(word, status = 1, values = {}) {
  throw new WalletRefusal(word, status, values);
}

function render(word, values = {}) {
  // The unknown-top-up command intentionally keeps its second <id> as a placeholder.
  if (word === "unknown") return WORDS[word].replace("<id>", values.id);
  return WORDS[word].replace(/<(balance|dollars|id|money|url|until)>/g,
    (literal, name) => Object.hasOwn(values, name) ? values[name] : literal);
}

function parseAmount(value) {
  const match = /^\$?(10|25|50|100|250|500)(?:\.00)?(?:usd)?$/i.exec(value.trim());
  return match ? Number(match[1]) * 100 : null;
}

function argumentsFor(args, json) {
  const action = ["wait", "status"].includes(args[0]) ? args[0] : "start";
  const values = action === "start" ? args : args.slice(1);
  const usage = action === "start" ? "topupUsage" : action + "Usage";
  if (values.length > 1) refuse(usage, 2);
  if (action !== "start") {
    const id = values[0];
    if (typeof id !== "string" || id.length < 1 || id.length > 128 || /[^A-Za-z0-9_-]/.test(id) || hasCredential(id)) refuse(usage, 2);
    return { action, id, json };
  }
  const amount = values.length ? parseAmount(values[0]) : null;
  if (values.length && amount === null) refuse("amount", 2);
  return { action, amount, json };
}

function prompt(store) {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    const wasRaw = !!input.isRaw;
    const decoder = new StringDecoder("utf8");
    let value = "", done = false;
    const finish = cancelled => {
      if (done) return;
      done = true;
      store.cancelPrompt = null;
      input.pause();
      input.removeListener("data", data);
      input.removeListener("end", cancel);
      input.removeListener("error", cancel);
      try { input.setRawMode(wasRaw); }
      catch { cancelled = true; }
      if (cancelled) reject(new WalletRefusal("cancelled"));
      else resolve(value);
    };
    const cancel = () => finish(true);
    const data = chunk => {
      for (const character of decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (character === "\x03" || character === "\x04") { cancel(); return; }
        if (character === "\r" || character === "\n") { finish(false); return; }
        if (character === "\x7f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else value += character;
      }
    };
    try {
      input.setRawMode(true);
      input.on("data", data);
      input.once("end", cancel);
      input.once("error", cancel);
      store.cancelPrompt = cancel;
      out(WORDS.prompt);
      input.resume();
    } catch { cancel(); }
  });
}

async function chooseAmount(store) {
  while (true) {
    const amount = parseAmount(await prompt(store));
    if (amount !== null) return amount;
    err(WORDS.reask);
  }
}

// Decode ASCII percent escapes independently of UTF-8, including partial encodings.
// Repeated decoding also prevents a nested escape from hiding a credential.
function hasCredential(value, keys = []) {
  let text = value;
  while (true) {
    if (/opsfy_sk_[0-9a-f]{64}/.test(text) || keys.some(key => key && text.includes(key))) return true;
    const decoded = text.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) return false;
    text = decoded;
  }
}

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

const ERRORS = Object.freeze({
  method_not_allowed: [405, ["topup", "topup/status"], "badRequest"],
  invalid_request: [400, ["topup", "topup/status"], "badRequest"],
  unsupported_media_type: [415, ["topup"], "badRequest"],
  body_too_large: [413, ["topup"], "badRequest"],
  invalid_amount: [400, ["topup"], "amount"],
  invalid_key: [401, ["topup", "topup/status"], "invalidKey"],
  configuration_unavailable: [503, ["topup", "topup/status"], "unavailable"],
  storage_unavailable: [503, ["topup", "topup/status"], "storage"],
  stripe_unavailable: [503, ["topup"], "unavailable"],
  unknown_topup: [404, ["topup/status"], "unknown"],
});

function validEnvelope(response, url, method) {
  if (response.url !== url || response.redirected !== false ||
      response.headers.get("content-type") !== "application/json; charset=utf-8" ||
      response.headers.get("cache-control") !== "no-store") return false;
  for (const name of response.headers.keys()) {
    if (["cookie", "set-cookie", "set-cookie2", "location", "retry-after"].includes(name) ||
        name.startsWith("access-control-allow-")) return false;
  }
  return response.headers.get("allow") === (response.status === 405 ? method : null);
}

async function request(base, route, key, keys, amount, wait = {}) {
  const query = route === "topup/status" ? "?id=" + wait.id : "";
  const url = base + "/api/" + route + query;
  if (hasCredential(url, keys)) throw new Refusal("base", 2);
  const unknown = route === "topup" ? "unavailable" : "storage";
  const controller = new AbortController();
  const options = {
    method: route === "topup" ? "POST" : "GET",
    headers: { accept: "application/json", authorization: "Bearer " + key },
    redirect: "error",
    signal: controller.signal,
  };
  if (route === "topup") {
    options.headers["content-type"] = "application/x-www-form-urlencoded";
    options.body = "amount_cents=" + amount;
  }
  if (route === "topup/status") options.headers["Opsfy-Balance"] = "microusd";
  let timer, response, consumed = false, result, timedOut = false;
  const abort = () => {
    clearTimeout(timer);
    controller.abort();
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  if (wait.signal) {
    wait.signal.addEventListener("abort", abort, { once: true });
    if (wait.signal.aborted) abort();
  }
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; abort(); reject(new Error()); },
      Math.min(10000, wait.until === undefined ? 10000 : Math.max(0, wait.until - Date.now())));
  });
  try {
    result = await Promise.race([deadline, (async () => {
      response = await fetch(url, options);
      if (controller.signal.aborted || !validEnvelope(response, url, options.method)) throw new Error();
      const text = await response.text();
      consumed = true;
      const body = JSON.parse(text);
      if (controller.signal.aborted) throw new Error();
      if (body?.ok === false) {
        if (!exactObject(body, ["ok", "error"]) || typeof body.error !== "string" ||
            !Object.hasOwn(ERRORS, body.error)) throw new Error();
        const [status, routes, word] = ERRORS[body.error];
        if (response.status !== status || !routes.includes(route)) throw new Error();
        return { word };
      }
      if (body?.ok !== true || response.status !== (route === "topup" ? 201 : 200)) throw new Error();
      return { body };
    })()]);
  } catch {
    // A wait cutoff can return its last checked open state; other failures never retry.
    if (timedOut) throw new WalletDeadline(unknown, 1, { id: wait.id });
    refuse(unknown, 1, { id: wait.id });
  } finally {
    if (!consumed) {
      controller.abort();
      try { await response?.body?.cancel(); }
      catch { /* Aborting also disposes a body that is locked by a pending read. */ }
    }
    clearTimeout(timer);
    wait.signal?.removeEventListener("abort", abort);
  }
  if (result.word === "invalidKey") throw new Refusal("invalidKey");
  if (result.word) throw new WalletRefusal(result.word, 1, { id: wait.id });
  return result.body;
}

function validSession(value, keys) {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 255 &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value) && !hasCredential(value, keys);
}

function validPaymentURL(value, keys) {
  if (typeof value !== "string" || !value || /[\\\s\p{Cc}\p{Cf}'"]/u.test(value) ||
      /%(?![0-9a-f]{2})/i.test(value) || hasCredential(value, keys)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" &&
      !url.username && !url.password && !url.port && !/[\p{Cc}\p{Cf}]/u.test(decodeURIComponent(value));
  } catch { return false; }
}

function money(cents) {
  const value = BigInt(cents);
  return "$" + value / 100n + "." + String(value % 100n).padStart(2, "0");
}

class WalletDeadline extends WalletRefusal {}

function checkedTopup(body, keys, id, amount) {
  const creating = amount !== undefined;
  const fields = ["ok", "status", "id", "amount_cents", "currency", "url", "expires_at"];
  const balanceField = Object.hasOwn(body ?? {}, "balance_microusd") ? "balance_microusd" : "balance_cents";
  if (creating) fields.push("session_id");
  else if (body?.status === "paid") fields.push(balanceField);
  if (!exactObject(body, fields) || body.ok !== true ||
      !["open", "paid", "cancelled", "expired"].includes(body.status) ||
      (creating && (body.status !== "open" || !validSession(body.session_id, keys))) ||
      typeof body.id !== "string" || body.id.length !== 32 || /[^0-9a-f]/.test(body.id) ||
      (!creating && body.id !== id) || !AMOUNTS.has(body.amount_cents) ||
      (creating && body.amount_cents !== amount) || body.currency !== "usd" ||
      !Number.isSafeInteger(body.expires_at) || body.expires_at < 0 || body.expires_at > 8640000000000 ||
      (creating && body.expires_at <= Date.now() / 1000) || !validPaymentURL(body.url, keys) ||
      (body.status === "paid" && (!Number.isSafeInteger(body[balanceField]) || body[balanceField] < 0))) {
    refuse(creating ? "unavailable" : "storage", 1, { id });
  }
  let balance;
  if (body.status === "paid") {
    balance = balanceField === "balance_microusd" ? body.balance_microusd : body.balance_cents * 10000;
    if (!Number.isSafeInteger(balance)) refuse("storage", 1, { id });
  }
  return { status: body.status, id: body.id, amount_cents: body.amount_cents,
    currency: body.currency, url: body.url, expires_at: body.expires_at,
    ...(body.status === "paid" ? { balance_microusd: balance } : {}) };
}

async function topup(base, key, keys, amount) {
  return checkedTopup(await request(base, "topup", key, keys, amount), keys, undefined, amount);
}

async function topupStatus(base, key, keys, id, until, signal) {
  return checkedTopup(await request(base, "topup/status", key, keys, undefined,
    { id, until, signal }), keys, id);
}

function waitingSignals(store, id, answer) {
  const controller = new AbortController();
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.removeListener(signal, store.signalHandlers.get(signal));
    const handler = () => {
      controller.abort();
      try { store.release(true); } catch { /* Keep the signal exit even if cleanup fails. */ }
      if (signal === "SIGINT") answer.failure("stopped_waiting", render("stopped", { id }), { id });
      process.exit(status);
    };
    store.signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  return controller.signal;
}

function sleepFor(ms, signal) {
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
  });
}

async function topupWait(base, key, keys, id, signal, initial) {
  const end = Date.now() + 600000;
  let last, identity = initial;
  if (initial && initial.expires_at * 1000 <= Date.now()) return { ...initial, status: "expired" };
  const cutoff = () => Math.min(end, identity ? identity.expires_at * 1000 : end);
  const atCutoff = () => last.expires_at * 1000 <= Date.now() ? { ...last, status: "expired" } : last;
  while (true) {
    if (last && Date.now() >= cutoff()) return atCutoff();
    let result;
    try { result = await topupStatus(base, key, keys, id, cutoff(), signal); }
    catch (error) {
      if (error instanceof WalletDeadline && last && Date.now() >= cutoff()) return atCutoff();
      throw error;
    }
    if (identity && ["id", "amount_cents", "currency", "url", "expires_at"].some(field => result[field] !== identity[field])) {
      refuse("storage", 1, { id });
    }
    if (result.status !== "open") return result;
    identity = last = result;
    const remaining = cutoff() - Date.now();
    if (remaining <= 0) return atCutoff();
    await sleepFor(Math.min(3000, remaining), signal);
  }
}

function topupValues(result) {
  return { money: money(result.amount_cents), dollars: result.amount_cents / 100,
    id: result.id, url: result.url, until: new Date(result.expires_at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
}

function topupOutput(result, json) {
  if (json) return result;
  const values = topupValues(result);
  if (result.status === "paid") return render("payment", { ...values, balance: balanceMoney(result.balance_microusd) });
  if (result.status === "cancelled") return render("closed", values);
  return render(result.status, values);
}

async function run(command, args, answer = new Answer()) {
  let store, output, failure, exitCode = 0;
  try {
    const options = argumentsFor(args, answer.json);
    const base = apiBase();
    if (process.env.OPSFY_DRY_RUN === "1") refuse("dry", 2);
    if (options.action === "start" && options.amount === null &&
        (options.json || !process.stdin.isTTY)) refuse("missingAmount", 2);
    store = new Store();
    const parent = fs.lstatSync(path.dirname(store.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Refusal("badFile");
    store.prepare();
    store.acquire();
    const state = store.load();
    if (state.pending) {
      if (hasCredential(state.pending.email)) throw new Refusal("badFile");
      throw new Refusal("pending", 2, { email: state.pending.email });
    }
    const environmentKey = process.env.OPSFY_API_KEY || "";
    if (environmentKey && !validKey(environmentKey)) throw new Refusal("envInvalid", 2);
    const key = environmentKey || state.key;
    if (!key) throw new Refusal("noKey", 2);
    const keys = [key, state.key];
    const terminal = !!process.stdout.isTTY;
    let result;
    if (options.action === "start") {
      const amount = options.amount === null ? await chooseAmount(store) : options.amount;
      const created = await topup(base, key, keys, amount);
      if (options.json) output = created;
      else if (!terminal) output = render("pageAgent", topupValues(created));
      else {
        const signal = waitingSignals(store, created.id, answer);
        out(render("page", topupValues(created)));
        let opened = false;
        try { opened = await require("./topup-browser.js").open(created.url); } catch {}
        out(opened ? WORDS.opened : WORDS.waiting);
        result = await topupWait(base, key, keys, created.id, signal, created);
      }
    } else if (options.action === "status") {
      result = await topupStatus(base, key, keys, options.id);
    } else {
      const signal = waitingSignals(store, options.id, answer);
      if (terminal && !options.json) out(WORDS.waiting);
      result = await topupWait(base, key, keys, options.id, signal);
    }
    if (result) {
      output = topupOutput(result, options.json);
      exitCode = { paid: 0, cancelled: 3, expired: 4, open: 5 }[result.status];
    }
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); }
    catch { failure = new Refusal("badFile"); }
  }
  if (failure) {
    if (failure instanceof WalletRefusal) {
      answer.failure(ERROR_CODES[failure.word], render(failure.word, failure.values));
      return failure.status;
    }
    let message = line("badFile"), status = 1, code = "key_files";
    if (failure instanceof Refusal) {
      message = line(failure.word, failure.values);
      status = failure.status;
      code = errorCode(failure.word);
      if (hasCredential(message)) { message = line("badFile"); status = 1; code = "key_files"; }
    }
    answer.failure(code, message);
    return status;
  }
  if (answer.json) answer.success(output);
  else out(output);
  return exitCode;
}

module.exports = { run, validPaymentURL };
