"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, Refusal, apiBase, validKey, line, errorCode } = require("./auth.js").walletSupport;
const { Answer } = require("./answer.js");
const { out } = require("./output.js");
const { tools, InputRefusal, invalidMessage, parse, slug } = require("./tool-inputs.js");

const WORDS = Object.freeze({
  usage: 'no question given · run opsfy call tavily "<question>"',
  invalid_question: "opsfy.ai refused the question · check its limits with opsfy info tavily, change it, then run the call again",
  search_failed: "Tavily answered with an error; nothing was charged · run the same call again",
  stopped_call: "stopped before the answer came back, so it may have been charged · run opsfy logs --json and look for it before calling again",
  call_unavailable: "no confirmation came back, so it may have been charged · run opsfy logs --json and look for it before calling again",
  update_needed: "opsfy.ai could not read this CLI's request · run npm i -g @opsfy/cli@latest, then read https://opsfy.ai/SKILL.md again",
  rate_limited: "too many calls (10 a minute for each account, or Tavily's own limit) · wait 60 seconds, then run the call again",
  configuration_unavailable: "opsfy.ai cannot make calls right now · wait 60 seconds, then run the call again",
  storage_unavailable: "opsfy.ai could not read or update the balance · wait 60 seconds, then run opsfy logs --json before calling again",
  balance_unavailable: "opsfy.ai could not read the balance · wait 60 seconds, then run opsfy logs again",
  tool_not_open: 'this tool is listed but not open yet; open now: tavily · run opsfy find "<job>" for another',
});
const ERRORS = Object.freeze({
  method_not_allowed: [405, "update_needed"], invalid_request: [400, "update_needed"],
  unsupported_media_type: [415, "update_needed"], body_too_large: [413, "update_needed"],
  invalid_question: [400, "invalid_question"], tool_not_open: [400, "tool_not_open"],
  invalid_input: [400, "invalid_input"],
  invalid_key: [401, "key_not_working"], configuration_unavailable: [503, "configuration_unavailable"],
  storage_unavailable: [503, "storage_unavailable"], insufficient_balance: [402, "insufficient_balance"],
  rate_limited: [429, "rate_limited"], search_failed: [502, "search_failed"],
});
const AMOUNTS = new Set([1000, 2500, 5000, 10000, 25000, 50000].map(n => n * 10000));

function wordsFor(tool) {
  if (!tool) return WORDS;
  return { ...WORDS,
    invalid_question: `opsfy.ai refused the ${tool.main_input || "input"} · check its limits with opsfy info ${tool.slug}, change it, then run the call again`,
    search_failed: `${tool.name} answered with an error; nothing was charged · run the same call again`,
    rate_limited: `too many calls (10 a minute for each account, or ${tool.name}'s own limit) · wait 60 seconds, then run the call again`,
    invalid_input: invalidMessage(tool) };
}

class CallRefusal extends Error {
  constructor(code, status = 1, message = WORDS[code]) {
    super(code);
    this.code = code;
    this.status = status;
    this.message = message;
  }
}

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
}

function moneyNumber(value) { return Number.isSafeInteger(value) && value >= 0; }
function money(value) {
  const n = BigInt(value), decimals = n % 10000n === 0n ? 2 : n % 100n === 0n ? 4 : 6;
  return "$" + n / 1000000n + "." + String(n % 1000000n).padStart(6, "0").slice(0, decimals);
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

async function argumentsFor(command, args, tool) {
  if (command === "logs") {
    if (args.length) throw new CallRefusal("usage", 2, "usage: opsfy logs [--json]");
    return;
  }
  return parse(tool, args);
}

function envelope(response, url, method) {
  if (response.url !== url || response.redirected !== false ||
      response.headers.get("content-type") !== "application/json; charset=utf-8" ||
      response.headers.get("cache-control") !== "no-store") return false;
  for (const name of response.headers.keys()) {
    if (["cookie", "set-cookie", "set-cookie2", "location", "retry-after"].includes(name) ||
        name.startsWith("access-control-allow-")) return false;
  }
  const allow = response.headers.get("allow");
  return allow === null || (response.status === 405 && allow === method);
}

function waitingSignals(store, command, answer, tool) {
  const controller = new AbortController();
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.removeListener(signal, store.signalHandlers.get(signal));
    const handler = () => {
      controller.abort();
      try { store.release(true); } catch { /* Keep the signal exit if cleanup fails. */ }
      if (signal === "SIGINT" && command === "call") answer.failure("stopped_call", wordsFor(tool).stopped_call);
      process.exit(status);
    };
    store.signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  return controller.signal;
}

async function request(base, command, key, keys, inputBody, before, signal, tool) {
  const unknown = command === "call" ? "call_unavailable" : "balance_unavailable";
  const words = wordsFor(tool);
  const url = base + (command === "call" ? "/api/call" : "/api/history") +
    (before === undefined ? "" : "?before=" + encodeURIComponent(before));
  if (hasCredential(url, keys)) throw new Refusal("base", 2);
  const controller = new AbortController();
  const options = { method: command === "call" ? "POST" : "GET", redirect: "error", signal: controller.signal,
    headers: { accept: "application/json", authorization: "Bearer " + key } };
  if (command === "call") {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(inputBody);
  }
  let timer, response, consumed = false, result;
  const abort = () => {
    controller.abort();
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { abort(); reject(new Error()); }, 15000);
  });
  try {
    result = await Promise.race([deadline, (async () => {
      response = await fetch(url, options);
      if (controller.signal.aborted || !envelope(response, url, options.method)) throw new Error();
      const body = JSON.parse(await response.text());
      consumed = true;
      if (controller.signal.aborted) throw new Error();
      if (body?.ok === false) {
        if (typeof body.error !== "string" || !Object.hasOwn(ERRORS, body.error)) throw new Error();
        const [status, code] = ERRORS[body.error];
        if (response.status !== status) throw new Error();
        if (code === "insufficient_balance") {
          if (command !== "call" || !exact(body, ["ok", "error", "price_microusd", "balance_microusd"]) ||
              !moneyNumber(body.price_microusd) || body.price_microusd === 0 || !moneyNumber(body.balance_microusd)) throw new Error();
          return { failure: new CallRefusal(code, 1,
            `a ${tool.slug} ${tool.unit} costs ${money(body.price_microusd)} and the balance is ${money(body.balance_microusd)}; nothing was charged · ask the person to add money, then run opsfy topup 10 --json`) };
        }
        if (code === "invalid_input") {
          if (command !== "call" || !exact(body, ["ok", "error", "allowed_inputs"]) ||
              JSON.stringify(body.allowed_inputs) !== JSON.stringify(tool.inputs.map(input => input.name))) throw new Error();
          return { failure: new CallRefusal(code, 1, words[code]) };
        }
        if (!exact(body, ["ok", "error"])) throw new Error();
        return { failure: code === "key_not_working" ? new Refusal("invalidKey") : new CallRefusal(code, 1, words[code]) };
      }
      if (response.status !== 200 || body?.ok !== true) throw new Error();
      return { body };
    })()]);
  } catch {
    throw new CallRefusal(unknown, 1, words[unknown]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (!consumed) {
      controller.abort();
      try { await response?.body?.cancel(); } catch {}
    }
  }
  if (result.failure) throw result.failure;
  return result.body;
}

function checkedCall(body, tool) {
  if (!exact(body, ["ok", "tool", "call_id", "results", "price_microusd", "balance_microusd"]) ||
      body.tool !== tool.slug || typeof body.call_id !== "string" || !/^[0-9a-f]{32}$/.test(body.call_id) ||
      !moneyNumber(body.price_microusd) || body.price_microusd === 0 || !moneyNumber(body.balance_microusd) ||
      !Array.isArray(body.results) || body.results.length > tool.results.max_results || !body.results.every(row =>
        exact(row, tool.results.fields) && tool.results.fields.every(name => typeof row[name] === "string"))) {
    throw new CallRefusal("call_unavailable", 1, wordsFor(tool).call_unavailable);
  }
  return { ok: true, tool: body.tool, call_id: body.call_id, results: body.results,
    price_microusd: body.price_microusd, balance_microusd: body.balance_microusd };
}

function plainCall(body, tool) {
  const clean = value => value.replace(/[\p{Cc}\p{Cf}]+/gu, " ");
  const rows = body.results.map((row, index) => tool.results.fields.map((name, field) => {
    const value = clean(row[name]);
    return field === 0 ? `${index + 1}. ${value}` : "   " + (field >= 2 ? [...value].slice(0, 300).join("") : value);
  }).join("\n"));
  rows.push(`${tool.slug} ${tool.unit} · call ${body.call_id} · charged ${money(body.price_microusd)} · balance ${money(body.balance_microusd)} USD`);
  return rows.join("\n");
}

function validTime(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() >= 0 && date.toISOString() === value;
}
function validTopupID(value, keys) {
  return typeof value === "string" && value.length > 0 && [...value].length <= 255 &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value) && !hasCredential(value, keys);
}
function cursorFor(row) {
  return String(new Date(row.at).getTime()).padStart(16, "0") + (row.kind === "topup" ? ":t:" : ":c:") +
    Buffer.from(row.id, "utf8").toString("hex");
}
function validCursor(value, keys) {
  if (typeof value !== "string") return false;
  const match = /^(\d{16}):([tc]):((?:[0-9a-f]{2}){1,1020})$/.exec(value);
  if (!match || Number(match[1]) > 8640000000000000) return false;
  try {
    const id = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[3], "hex"));
    return Buffer.from(id, "utf8").toString("hex") === match[3] &&
      (match[2] === "t" ? validTopupID(id, keys) : /^[0-9a-f]{32}$/.test(id));
  } catch { return false; }
}

async function history(base, key, keys, signal) {
  const entries = [], seen = new Set();
  let before, balance, previous;
  const bad = () => { throw new CallRefusal("balance_unavailable"); };
  while (true) {
    const body = await request(base, "logs", key, keys, undefined, before, signal);
    if (!exact(body, ["ok", "currency", "balance_microusd", "entries", "next_before"]) ||
        body.currency !== "usd" || !moneyNumber(body.balance_microusd) ||
        !Array.isArray(body.entries) || body.entries.length > 50) bad();
    if (balance === undefined) balance = body.balance_microusd;
    for (const row of body.entries) {
      if (!row || !validTime(row.at)) bad();
      if (row.kind === "topup") {
        if (!exact(row, ["kind", "id", "at", "amount_microusd"]) || !validTopupID(row.id, keys) ||
            !AMOUNTS.has(row.amount_microusd)) bad();
      } else if (row.kind === "call") {
        if (!exact(row, ["kind", "id", "at", "tool", "status", "price_microusd"]) ||
            typeof row.id !== "string" || !/^[0-9a-f]{32}$/.test(row.id) || !slug(row.tool) ||
            !["charged", "failed"].includes(row.status) || !moneyNumber(row.price_microusd) ||
            (row.status === "charged" ? row.price_microusd === 0 : row.price_microusd !== 0)) bad();
      } else bad();
      const id = row.kind + ":" + row.id, cursor = cursorFor(row);
      if (seen.has(id) || (previous !== undefined && cursor >= previous)) bad();
      seen.add(id);
      previous = cursor;
      entries.push(row);
    }
    if (body.next_before === null) break;
    if (!validCursor(body.next_before, keys) || body.entries.length !== 50 ||
        body.next_before !== previous || (before !== undefined && body.next_before >= before)) bad();
    before = body.next_before;
  }
  return { ok: true, currency: "usd", balance_microusd: balance, entries };
}

function plainHistory(body) {
  return [`balance ${money(body.balance_microusd)} USD`, ...body.entries.map(row => {
    const stamp = row.at.replace(/\.\d{3}Z$/, "Z");
    return row.kind === "topup" ? `${stamp} · top-up ${row.id} · +${money(row.amount_microusd)}` :
      `${stamp} · call ${row.id} · ${row.tool} ${Object.hasOwn(tools, row.tool) ? tools[row.tool].unit : "call"} · ${row.status === "failed" ? "failed · $0 charged" : "charged " + money(row.price_microusd)}`;
  })].join("\n");
}

async function run(command, args, answer = new Answer(), tool = tools[(args[0] || "").toLowerCase().split(".")[0]]) {
  let store, output, failure;
  try {
    const inputBody = await argumentsFor(command, args, tool);
    const base = apiBase();
    if (process.env.OPSFY_DRY_RUN === "1") throw new CallRefusal("dry_run", 2,
      `OPSFY_DRY_RUN=1 is set, so ${command} does not run · unset OPSFY_DRY_RUN to run it`);
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
    if (command === "call" && Object.values(inputBody.inputs || { question: inputBody.question }).some(value => typeof value === "string" && hasCredential(value, keys))) {
      throw new CallRefusal(inputBody.inputs ? "invalid_input" : "invalid_question", 2,
        inputBody.inputs ? invalidMessage(tool) : `the ${tool.main_input} contains an opsfy key, which is never sent · remove the key, then run the call again`);
    }
    const signal = waitingSignals(store, command, answer, tool);
    const body = command === "call" ? checkedCall(await request(base, command, key, keys, inputBody, undefined, signal, tool), tool) :
      await history(base, key, keys, signal);
    output = answer.json ? body : command === "call" ? plainCall(body, tool) : plainHistory(body);
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); } catch { failure = new Refusal("badFile"); }
  }
  if (failure) {
    if (failure instanceof CallRefusal || failure instanceof InputRefusal) {
      answer.failure(failure.code, failure.message);
      return failure.status;
    }
    let message = line("badFile"), code = "key_files", status = 1;
    if (failure instanceof Refusal) {
      message = line(failure.word, failure.values);
      code = errorCode(failure.word);
      status = failure.status;
      if (hasCredential(message)) { message = line("badFile"); code = "key_files"; status = 1; }
    }
    answer.failure(code, message);
    return status;
  }
  if (answer.json) answer.success(output);
  else out(output);
  return 0;
}

module.exports = { run, money };
