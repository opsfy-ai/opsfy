"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { Store, Refusal, apiBase, validKey, line } = require("./auth.js").walletSupport;
const { out, err } = require("./output.js");

const WORDS = Object.freeze({
  "amount": "choose $10, $25, $50, $100, $250 or $500 USD",
  "unavailable": "top-ups are unavailable right now · try again in a minute",
  "storage": "your balance could not be read or updated · try again in a minute",
  "badRequest": "the top-up request could not be read · update opsfy and try again",
  "page": "pay <amount> USD here: <url>",
  "balance": "balance: <amount> USD",
  "paid": "<time> · top-up +<amount> USD",
  "prompt": "Top up $10, $25, $50, $100, $250 or $500 USD:",
  "missingAmount": "choose an amount: opsfy topup 10, 25, 50, 100, 250 or 500",
  "cancelled": "top-up cancelled",
  "empty": "no paid top-ups yet",
  "dry": "dry-run · topup and logs do not run in a dry run",
  "topupUsage": "usage: opsfy topup [amount] [--json]",
  "logsUsage": "usage: opsfy logs [--json]",
  "waitUsage": "usage: opsfy topup wait <id> [--json]",
  "statusUsage": "usage: opsfy topup status <id> [--json]",
  "waiting": "waiting for your payment (Ctrl-C stops waiting; a payment still counts)",
  "opened": "opened in your browser · waiting for your payment (Ctrl-C stops waiting; a payment still counts)",
  "payment": "payment successful · top-up +<amount> USD · balance: <balance> USD",
  "closed": "top-up cancelled · nothing was charged",
  "expired": "the payment page expired · nothing was charged · run opsfy topup <dollars> to start again",
  "open": "no payment yet · the page works until <time> · run opsfy topup wait <id> to wait again",
  "stopped": "stopped waiting · a payment still counts · run opsfy topup status <id> to check",
  "unknown": "no top-up <id> on this account",
  "next": "then run: opsfy topup wait <id>",
  "nextPaid": "then run: opsfy logs",
  "nextStart": "then run: opsfy topup <dollars>",
  "noKey": "you are not logged in on this computer · run opsfy login to log in",
  "invalidKey": "your key no longer works · run opsfy login to log in again",
  "env": "OPSFY_API_KEY is set · unset it, then try again",
  "pending": "your key could not be confirmed · run opsfy login --email <email> to log in again",
  "badFile": "something went wrong with your key files in ~/.opsfy/ · try again, and if it keeps happening, email support@opsfy.ai",
  "busy": "another opsfy command is still running · try again when it finishes",
  "stale": "an earlier opsfy command did not finish · if no opsfy command is running, delete ~/.opsfy/auth-lock, then try again",
  "base": "OPSFY_API_BASE must be https, or http on localhost, with no username, password, query or fragment"
});
const AMOUNTS = new Set([1000, 2500, 5000, 10000, 25000, 50000]);

class WalletRefusal extends Error {
  constructor(word, status = 1, values = {}) {
    super(word);
    this.word = word;
    this.status = status;
    this.values = values;
  }
}

function refuse(word, status = 1) {
  throw new WalletRefusal(word, status);
}

function render(word, values = {}) {
  return WORDS[word].replace(/<(amount|balance|dollars|id|url|time)>/g,
    (literal, name) => Object.hasOwn(values, name) ? values[name] : literal);
}

function parseAmount(value) {
  const match = /^\$?(10|25|50|100|250|500)(?:\.00)?(?:usd)?$/i.exec(value.trim());
  return match ? Number(match[1]) * 100 : null;
}

function argumentsFor(command, args) {
  if (command !== "topup") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) refuse("logsUsage", 2);
    return { json: args.length === 1 };
  }
  const action = ["wait", "status"].includes(args[0]) ? args[0] : "start";
  const rest = action === "start" ? args : args.slice(1);
  const usage = action === "start" ? "topupUsage" : action + "Usage";
  const json = rest.includes("--json");
  const values = rest.filter(value => value !== "--json");
  if (rest.length - values.length > 1 || values.length > 1) refuse(usage, 2);
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
    err(WORDS.amount);
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
  method_not_allowed: [405, ["topup", "wallet", "topup/status"], "badRequest"],
  invalid_request: [400, ["topup", "wallet", "topup/status"], "badRequest"],
  unsupported_media_type: [415, ["topup"], "badRequest"],
  body_too_large: [413, ["topup"], "badRequest"],
  invalid_amount: [400, ["topup"], "amount"],
  invalid_key: [401, ["topup", "wallet", "topup/status"], "invalidKey"],
  configuration_unavailable: [503, ["topup", "wallet", "topup/status"], "unavailable"],
  storage_unavailable: [503, ["topup", "wallet", "topup/status"], "storage"],
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

async function request(base, route, key, keys, amount, before, wait = {}) {
  const query = route === "topup/status" ? "?id=" + wait.id : before === undefined ? "" : "?before=" + before;
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
    if (timedOut) throw new WalletDeadline(unknown);
    refuse(unknown);
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
  if (creating) fields.push("session_id");
  else if (body?.status === "paid") fields.push("balance_cents");
  if (!exactObject(body, fields) || body.ok !== true ||
      !["open", "paid", "cancelled", "expired"].includes(body.status) ||
      (creating && (body.status !== "open" || !validSession(body.session_id, keys))) ||
      typeof body.id !== "string" || body.id.length !== 32 || /[^0-9a-f]/.test(body.id) ||
      (!creating && body.id !== id) || !AMOUNTS.has(body.amount_cents) ||
      (creating && body.amount_cents !== amount) || body.currency !== "usd" ||
      !Number.isSafeInteger(body.expires_at) || body.expires_at < 0 || body.expires_at > 8640000000000 ||
      (creating && body.expires_at <= Date.now() / 1000) || !validPaymentURL(body.url, keys) ||
      (body.status === "paid" && (!Number.isSafeInteger(body.balance_cents) || body.balance_cents < 0))) {
    refuse(creating ? "unavailable" : "storage");
  }
  return { status: body.status, id: body.id, amount_cents: body.amount_cents,
    currency: body.currency, url: body.url, expires_at: body.expires_at,
    ...(body.status === "paid" ? { balance_cents: body.balance_cents } : {}) };
}

async function topup(base, key, keys, amount) {
  return checkedTopup(await request(base, "topup", key, keys, amount), keys, undefined, amount);
}

async function topupStatus(base, key, keys, id, until, signal) {
  return checkedTopup(await request(base, "topup/status", key, keys, undefined, undefined,
    { id, until, signal }), keys, id);
}

function waitingSignals(store, id) {
  const controller = new AbortController();
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.removeListener(signal, store.signalHandlers.get(signal));
    const handler = () => {
      controller.abort();
      try { store.release(true); } catch { /* Keep the signal exit even if cleanup fails. */ }
      if (signal === "SIGINT") err(render("stopped", { id }));
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
      refuse("storage");
    }
    if (result.status !== "open") return result;
    identity = last = result;
    const remaining = cutoff() - Date.now();
    if (remaining <= 0) return atCutoff();
    await sleepFor(Math.min(3000, remaining), signal);
  }
}

function topupOutput(result, json, terminal) {
  if (json) return JSON.stringify(result);
  const values = { amount: money(result.amount_cents), dollars: result.amount_cents / 100,
    id: result.id, time: new Date(result.expires_at * 1000).toISOString() };
  if (result.status === "paid") return render("payment", { ...values, balance: money(result.balance_cents) }) +
    (terminal ? "" : "\n" + WORDS.nextPaid);
  if (result.status === "cancelled") return WORDS.closed + (terminal ? "" : "\n" + render("nextStart", values));
  return render(result.status, values);
}

function validPaidTime(value) {
  if (typeof value !== "string" || !value.endsWith(".000Z")) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() >= 0 && date.toISOString() === value;
}

function paidTime(value) {
  // ISO serialization derives UTC fields, including the sign/digits of expanded years.
  const [date, time] = new Date(value).toISOString().split("T");
  return date + " " + time.slice(0, 5) + " UTC";
}

async function history(base, key, keys, json) {
  const sessions = new Set();
  const topups = [];
  let balance, before, bound = Number.MAX_SAFE_INTEGER;
  while (true) {
    const body = await request(base, "wallet", key, keys, undefined, before);
    if (!exactObject(body, ["ok", "currency", "balance_cents", "topups", "next_before"]) ||
        body.currency !== "usd" || !Number.isSafeInteger(body.balance_cents) || body.balance_cents < 0 ||
        !Array.isArray(body.topups) || body.topups.length > 50) refuse("storage");
    for (const row of body.topups) {
      if (!exactObject(row, ["session_id", "amount_cents", "paid_at"]) ||
          !validSession(row.session_id, keys) || sessions.has(row.session_id) ||
          !AMOUNTS.has(row.amount_cents) || !validPaidTime(row.paid_at)) refuse("storage");
      sessions.add(row.session_id);
      topups.push({ amount_cents: row.amount_cents, paid_at: row.paid_at });
    }
    if (balance === undefined) balance = body.balance_cents;
    const cursor = body.next_before;
    if (cursor === null) break;
    if (typeof cursor !== "string" || !/^[1-9][0-9]*$/.test(cursor) ||
        !Number.isSafeInteger(Number(cursor)) || String(Number(cursor)) !== cursor ||
        Number(cursor) >= bound || body.topups.length !== 50) refuse("storage");
    bound = Number(cursor);
    before = cursor;
  }
  if (json) return JSON.stringify({ currency: "usd", balance_cents: balance, topups }, null, 2);
  const rows = topups.length ? topups.map(row => render("paid", {
    time: paidTime(row.paid_at), amount: money(row.amount_cents),
  })) : [WORDS.empty];
  return [render("balance", { amount: money(balance) }), ...rows].join("\n");
}

async function run(command, args) {
  let store, output, failure, exitCode = 0;
  try {
    const options = argumentsFor(command, args);
    const base = apiBase();
    if (process.env.OPSFY_DRY_RUN === "1") refuse("dry", 2);
    if (command === "topup" && options.action === "start" && options.amount === null &&
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
    if (environmentKey && !validKey(environmentKey)) throw new Refusal("env", 2);
    const key = environmentKey || state.key;
    if (!key) throw new Refusal("noKey", 2);
    const keys = [key, state.key];
    if (command === "topup") {
      const terminal = !!process.stdout.isTTY;
      let result;
      if (options.action === "start") {
        const amount = options.amount === null ? await chooseAmount(store) : options.amount;
        const created = await topup(base, key, keys, amount);
        const page = render("page", { amount: money(amount), url: created.url });
        if (options.json) output = JSON.stringify(created);
        else if (!terminal) output = page + "\n" + render("next", { id: created.id });
        else {
          const signal = waitingSignals(store, created.id);
          out(page);
          let opened = false;
          try { opened = await require("./topup-browser.js").open(created.url); } catch {}
          out(opened ? WORDS.opened : WORDS.waiting);
          result = await topupWait(base, key, keys, created.id, signal, created);
        }
      } else if (options.action === "status") {
        result = await topupStatus(base, key, keys, options.id);
      } else {
        const signal = waitingSignals(store, options.id);
        if (terminal && !options.json) out(WORDS.waiting);
        result = await topupWait(base, key, keys, options.id, signal);
      }
      if (result) {
        output = topupOutput(result, options.json, terminal);
        exitCode = { paid: 0, cancelled: 3, expired: 4, open: 5 }[result.status];
      }
    } else {
      output = await history(base, key, keys, options.json);
    }
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); }
    catch { failure = new Refusal("badFile"); }
  }
  if (failure) {
    if (failure instanceof WalletRefusal) {
      err(render(failure.word, failure.values));
      return failure.status;
    }
    let message = line("badFile"), status = 1;
    if (failure instanceof Refusal) {
      message = line(failure.word, failure.values);
      status = failure.status;
      if (hasCredential(message)) { message = line("badFile"); status = 1; }
    }
    err(message);
    return status;
  }
  out(output);
  return exitCode;
}

module.exports = { run, validPaymentURL };
