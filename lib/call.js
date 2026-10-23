"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { Store, Refusal, apiBase, validKey, line, errorCode } = require("./auth.js").walletSupport;
const { Answer } = require("./answer.js");
const { out } = require("./output.js");
const { tools, InputRefusal, invalidMessage, parse, slug } = require("./tool-inputs.js");
const jsonValues = require("./json-values.js");
const privateTools = require("./private-tools.js");
const binaryOutput = require("./binary-output.js");

const WORDS = Object.freeze({
  call_not_sent: "Opsfy did not send this call; nothing was charged · try again later",
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
const CHAT_WORDS = Object.freeze({
  openrouter_model: 'model id not found; nothing was charged · choose an id from https://openrouter.ai/models, then run opsfy call openrouter --input model=<model> --input prompt="<text>" --json',
  openrouter_price: 'the model price or limits could not be read; nothing was charged · wait 60 seconds, then run opsfy call openrouter --input model=<model> --input prompt="<text>" --json',
  openrouter_policy: 'this model is not enabled; nothing was charged · choose an enabled id from https://openrouter.ai/models, then run opsfy call openrouter --input model=<model> --input prompt="<text>" --json',
  openrouter_input: 'OpenRouter takes model, prompt, system and max_tokens only · run opsfy info openrouter --json for limits',
  openrouter_unavailable: 'OpenRouter is not available right now; nothing was charged · ask the person to check OpenRouter availability before running opsfy call openrouter --input model=<model> --input prompt="<text>" --json',
  openrouter_refused: 'OpenRouter refused the call; nothing was charged · wait 60 seconds, then run opsfy call openrouter --input model=<model> --input prompt="<text>" --json; if it is refused again, ask the person before calling again',
  openrouter_changed: 'the model is not available at the held price; nothing was charged · run opsfy call openrouter --input model=<model> --input prompt="<text>" --json to read its current price',
  openrouter_lost: 'the call answer did not arrive; its charge is unconfirmed · run opsfy jobs --json and check the job before starting another call'
});
const JEV_WORDS = Object.freeze({
  "jev_model": "Jev takes typesafe/jev-1.14 or typesafe/jev-1.13; nothing was charged · choose one, then run opsfy call jev --input-file input.json --json",
  "jev_input": "the Jev inputs are invalid; nothing was charged · run opsfy info jev --json, then fix input.json and run opsfy call jev --input-file input.json --json",
  "jev_price": "the Jev price or context limit could not be read; nothing was charged · wait 60 seconds, then run opsfy call jev --input-file input.json --json",
  "jev_output_price": "Jev now has an output price, so its maximum charge cannot be bounded; nothing was charged · ask the person before calling Jev again",
  "jev_unavailable": "Jev is not available right now; nothing was charged · ask the person to check OpenRouter availability before running opsfy call jev --input-file input.json --json",
  "jev_refused": "Jev refused the call; nothing was charged · wait 60 seconds, then run opsfy call jev --input-file input.json --json; if it is refused again, ask the person before calling again"
});
const APIFY_WORDS = Object.freeze({
  "apify_actor": "Actor id not found; nothing was charged · check the Actor id, written user/name, then run opsfy call apify --input-file input.json --json",
  "apify_price": "this Actor's cost cannot be capped right now; nothing was charged · choose a per-event Actor whose price includes its platform usage, or run the call again in 15 minutes",
  "apify_unavailable": "Apify is not available right now; nothing was charged · try again later",
  "apify_refused": "Apify refused the input; nothing was charged · check the Actor's input fields, fix input.json, then run the call again",
  "apify_dollars": "max_usd must be a positive dollar string such as \"0.10\", with a leading digit and at most six decimal places; nothing was charged · fix max_usd and run the call again",
  "apify_input": "Apify takes actor, max_usd and one input object only; nothing was charged · run opsfy info apify --json, then fix input.json and run the call again",
  "apify_minimum": "max_usd is below this Actor's minimum of $<minimum>; nothing was charged · set max_usd to at least that amount and run the call again",
  "apify_access": "this Actor asks for full access to the Apify account, which Opsfy does not give; nothing was charged · choose an Actor with limited permissions, then run the call again"
});
const ERRORS = Object.freeze({
  call_not_sent: [503, "call_not_sent"],
  ...Object.fromEntries(Object.keys(require("./serverless.js").WORDS).map(code => [code, [code === "serverless_unavailable" ? 503 : 400, code]])),
  ...Object.fromEntries(Object.keys(APIFY_WORDS).map(code => [code, [code === "apify_unavailable" ? 503 : code === "apify_refused" ? 502 : 400, code]])),
  rental_price: [400, "rental_price"], rental_capacity: [502, "rental_capacity"],
  rental_unavailable: [503, "rental_unavailable"], rental_refused: [502, "rental_refused"],
  ...Object.fromEntries(Object.keys(JEV_WORDS).map(code => [code, [code === "jev_unavailable" ? 503 : code === "jev_refused" ? 502 : 400, code]])),
  method_not_allowed: [405, "update_needed"], invalid_request: [400, "update_needed"],
  unsupported_media_type: [415, "update_needed"], body_too_large: [413, "update_needed"],
  invalid_question: [400, "invalid_question"], tool_not_open: [400, "tool_not_open"],
  invalid_input: [400, "invalid_input"], unbounded_call: [400, "unbounded_call"],
  job_start_refused: [502, "job_start_refused"],
  invalid_key: [401, "key_not_working"], configuration_unavailable: [503, "configuration_unavailable"],
  storage_unavailable: [503, "storage_unavailable"], insufficient_balance: [402, "insufficient_balance"],
  rate_limited: [429, "rate_limited"], search_failed: [502, "search_failed"],
  openrouter_model: [400, "openrouter_model"], openrouter_price: [400, "openrouter_price"],
  openrouter_policy: [400, "openrouter_policy"], openrouter_input: [400, "openrouter_input"],
  openrouter_unavailable: [503, "openrouter_unavailable"], openrouter_changed: [409, "openrouter_changed"], openrouter_lost: [502, "openrouter_lost"],
  openrouter_refused: [502, "openrouter_refused"],
});
const AMOUNTS = new Set([1000, 2500, 5000, 10000, 25000, 50000].map(n => n * 10000));

function wordsFor(tool) {
  if (!tool) return WORDS;
  return { ...WORDS,
    invalid_question: `opsfy.ai refused the ${tool.main_input || "input"} · check its limits with opsfy info ${tool.slug}, change it, then run the call again`,
    search_failed: `${tool.name} answered with an error; nothing was charged · run the same call again`,
    rate_limited: `too many calls (10 a minute for each account, or ${tool.name}'s own limit) · wait 60 seconds, then run the call again`,
    ...(tool.job ? require("./jobs.js").startWords : {}),
    ...(tool.chat ? { ...CHAT_WORDS, call_unavailable: CHAT_WORDS.openrouter_lost, stopped_call: CHAT_WORDS.openrouter_lost } : {}),
    ...(tool.slug === "jev" ? JEV_WORDS : {}),
    ...(tool.slug === "apify" ? APIFY_WORDS : {}),
    ...(tool.slug === "runpod-serverless" ? require("./serverless.js").WORDS : {}),
    ...(tool.rental ? require("./rentals.js").WORDS : {}),
    ...(tool.binary ? { ...binaryOutput.WORDS, call_unavailable: binaryOutput.WORDS.binary_lost, stopped_call: binaryOutput.WORDS.binary_lost } : {}),
    invalid_input: invalidMessage(tool) };
}

function jobStartRefusal(tool, status) {
  if (status === 432 || status === 433) return `${tool.name} is not available right now; nothing was charged · ask the person to check the tool's availability before running the same call again`;
  if (status === 429) return `${tool.name} is busy; nothing was charged · try again later with the same call`;
  if (status === 400) return `${tool.name} refused the inputs; nothing was charged · run opsfy info ${tool.slug} --json, correct the inputs, then run the call again`;
  if (status === 401) return `${tool.name} could not authenticate; nothing was charged · ask the person to check the tool before running the same call again`;
  return `${tool.name} answered HTTP ${status}; nothing was charged · wait 60 seconds, then run the same call again`;
}

function allowedValues(value, tool) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 &&
    Object.entries(value).every(([name, values]) => {
      const input = tool.inputs.find(input => input.name === name && input.type === "string");
      return input && Array.isArray(values) && values.length >= 1 && values.length <= 32 && new Set(values).size === values.length &&
        values.every(item => typeof item === "string" && item.trim().length > 0 && [...item].length <= input.max_length && !/[\p{Cc}\p{Cf}]/u.test(item));
    });
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

// Node's own client has no implicit header/body deadline; the call's signal still aborts it.
function chatRequest(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? require("node:https") : require("node:http");
    const req = client.request(target, { method: options.method, headers: options.headers,
      agent: false, signal: options.signal }, incoming => {
      try {
        const headers = new Headers();
        for (let at = 0; at < incoming.rawHeaders.length; at += 2) headers.append(incoming.rawHeaders[at], incoming.rawHeaders[at + 1]);
        const response = new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers });
        Object.defineProperty(response, "url", { value: url });
        resolve(response);
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function request(base, command, key, keys, inputBody, before, signal, tool) {
  const unknown = command === "call" ? "call_unavailable" : "balance_unavailable";
  const words = wordsFor(tool);
  const url = base + (command === "call" ? "/api/call" : "/api/history") +
    (before === undefined ? "" : "?before=" + encodeURIComponent(before));
  if (hasCredential(url, keys)) throw new Refusal("base", 2);
  const controller = new AbortController();
  const options = { method: command === "call" ? "POST" : "GET", redirect: "error", signal: controller.signal,
    headers: { accept: "application/json", authorization: "Bearer " + key, "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1", "Opsfy-Chat": "chat-v1", "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1", "Opsfy-Rentals": "rentals-v1", "Opsfy-Text": "text-v1", "Opsfy-USD": "usd-v1", "Opsfy-Serverless": "serverless-v1" } };
  if (command === "call") {
    options.headers["content-type"] = "application/json";
    options.body = tool?.json ? jsonValues.stringify(inputBody) : JSON.stringify(inputBody);
  }
  let timer, response, consumed = false, result;
  const abort = () => {
    controller.abort();
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const deadline = new Promise((_, reject) => {
    if (!(command === "call" && (tool?.chat || tool?.wait))) timer = setTimeout(() => { abort(); reject(new Error()); }, 15000);
  });
  try {
    result = await Promise.race([deadline, (async () => {
      response = command === "call" && (tool?.chat || tool?.wait) ? await chatRequest(url, options) : await fetch(url, options);
      if (controller.signal.aborted || !envelope(response, url, options.method)) throw new Error();
      const source = await response.text(), body = JSON.parse(source);
      if (tool?.json && Object.hasOwn(body || {}, "answers")) {
        if (Buffer.byteLength(source, "utf8") > 1048576) throw new Error();
        body.answers = jsonValues.parse(source).answers;
      }
      consumed = true;
      if (controller.signal.aborted) throw new Error();
      if (body?.ok === false) {
        if (typeof body.error !== "string" || !Object.hasOwn(ERRORS, body.error)) throw new Error();
        const [status, code] = ERRORS[body.error];
        if (response.status !== status) throw new Error();
        if (code === "job_start_refused") {
          if (command !== "call" || !tool?.job || !exact(body, ["ok", "error", "status"]) ||
              !Number.isInteger(body.status) || body.status < 400 || body.status > 599) throw new Error();
          return { failure: new CallRefusal(code, 1, jobStartRefusal(tool, body.status)) };
        }
        if (code === "insufficient_balance") {
          if (command !== "call" || !exact(body, ["ok", "error", "price_microusd", "balance_microusd"]) ||
              !moneyNumber(body.price_microusd) || body.price_microusd === 0 || !moneyNumber(body.balance_microusd)) throw new Error();
          return { failure: new CallRefusal(code, 1,
            `a ${tool.slug} ${tool.unit} needs a hold of ${money(body.price_microusd)} and the balance is ${money(body.balance_microusd)}; nothing was charged · ask the person to add money, then run opsfy topup 10 --json`) };
        }
        if (code === "unbounded_call") {
          if (command !== "call" || !exact(body, ["ok", "error", "input"]) ||
              !tool.inputs.some(input => input.name === body.input)) throw new Error();
          return { failure: new CallRefusal(code, 1,
            `the maximum charge needs ${body.input}, which was not given; nothing was charged · run the call again with --input ${body.input}=<value> (opsfy info ${tool.slug} --json lists its range)`) };
        }
        if (["jev_refused", "openrouter_refused", "apify_refused"].includes(code) && Object.hasOwn(body, "charged_microusd")) {
          if (!exact(body, ["ok", "error", "held_microusd", "charged_microusd", "message"]) ||
              !moneyNumber(body.held_microusd) || !moneyNumber(body.charged_microusd) || body.charged_microusd > body.held_microusd) throw new Error();
          const n = BigInt(body.charged_microusd), clause = n === 0n ? "nothing was charged" : "charged $" + n / 1000000n + "." + String(n % 1000000n).padStart(6, "0") + " USD";
          const expected = words[code].replace("nothing was charged", clause);
          if (body.message !== expected && !(code === "jev_refused" && body.message === expected.replace("Jev refused the call", "Jev could not relay the answer"))) throw new Error();
          const failure = new CallRefusal(code, 1, body.message);
          failure.amounts = { held_microusd: body.held_microusd, charged_microusd: body.charged_microusd };
          return { failure };
        }
        if (["jev_input", "jev_model"].includes(code) && Object.hasOwn(body, "field")) {
          if (!exact(body, ["ok", "error", "field", "limit"]) || !safeJevField(body.field, body.limit) || hasCredential(body.field + body.limit, keys)) throw new Error();
          return { failure: new CallRefusal(code, 1, code === "jev_model" ? words[code] : body.field + ": " + body.limit +
            "; nothing was charged · run opsfy info jev --json, then fix input.json and run opsfy call jev --input-file input.json --json") };
        }
        if (code === "apify_minimum") {
          if (!exact(body, ["ok", "error", "minimum"]) || typeof body.minimum !== "string" ||
              !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(body.minimum) || body.minimum.length > 100) throw new Error();
          return { failure: new CallRefusal(code, 1, words[code].replace("<minimum>", body.minimum)) };
        }
        if (code === "invalid_input") {
          const values = Object.hasOwn(body, "allowed_values");
          if (command !== "call" || !exact(body, ["ok", "error", "allowed_inputs", ...(values ? ["allowed_values"] : [])]) ||
              values && (!allowedValues(body.allowed_values, tool) || hasCredential(JSON.stringify(body.allowed_values), keys)) ||
              JSON.stringify(body.allowed_inputs) !== JSON.stringify(tool.inputs.map(input => input.name))) throw new Error();
          return { failure: new CallRefusal(code, 1, words[code]) };
        }
        if (!exact(body, ["ok", "error"])) throw new Error();
        return { failure: code === "key_not_working" ? new Refusal("invalidKey") : new CallRefusal(code, 1, words[code]) };
      }
      if ((command === "call" && (tool?.chat || tool?.wait) ? ![200, 202].includes(response.status) || (response.status === 200) !== Object.hasOwn(body || {}, "call_id") :
          response.status !== (command === "call" && tool?.job ? 202 : 200)) || body?.ok !== true) throw new Error();
      if ((tool?.chat || tool?.json) && hasCredential(jsonValues.stringify(body), keys)) throw new Error();
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

function safeJevField(field, limit) {
  if (typeof field !== "string" || field.length > 65536 || /[\p{Cc}\p{Cs}]/u.test(field) || typeof limit !== "string") return false;
  return ["typesafe/jev-1.14, typesafe/jev-1.13", "model, state and questions only", "text, 1 to 131072 characters; no credentials",
    "one object, at most 65536 UTF-8 bytes and depth 16; no credentials or reserved keys", "noul, choice or score only",
    "type, instructions and criteria only; instructions are text, object, array or null", "true and false only", "1 to 255 choices", "1 to 10 levels"].includes(limit);
}

function checkedCall(body, tool) {
  if (tool.results?.object && Object.hasOwn(body, "call_id")) {
    const waiting = tool.wait === true;
    const fields = ["ok", "tool", "call_id", "answers", ...(waiting ? ["model", "tokens_in", "held_microusd", "charged_microusd", "balance_microusd", "status", "reason"] :
      ["price_microusd", "balance_microusd", "held_microusd", "charged_microusd"])];
    if (!exact(body, fields) || body.ok !== true || body.tool !== tool.slug || !/^[0-9a-f]{32}$/.test(body.call_id) ||
        body.answers === null || typeof body.answers !== "object" || Array.isArray(body.answers) || body.answers instanceof jsonValues.JSONNumber ||
        !jsonValues.valid(body.answers, tool.results.max_bytes, tool.results.max_depth) ||
        !moneyNumber(body.held_microusd) || !moneyNumber(body.charged_microusd) || body.charged_microusd > body.held_microusd || !moneyNumber(body.balance_microusd) ||
        (waiting ? typeof body.model !== "string" || !body.model.trim() || [...body.model].length > 200 || /[\p{Cc}\p{Cf}]/u.test(body.model) ||
          !(body.tokens_in === null || moneyNumber(body.tokens_in)) || body.status !== "succeeded" ||
          !(body.reason === null || ["usage_missing", "usage_above_hold"].includes(body.reason) && body.charged_microusd === body.held_microusd) :
          body.price_microusd !== body.charged_microusd)) throw new CallRefusal("call_unavailable", 1, wordsFor(tool).call_unavailable);
    return Object.fromEntries(fields.map(name => [name, body[name]]));
  }
  if (tool.chat && Object.hasOwn(body, "call_id")) {
    const fields = ["ok", "tool", "call_id", "text", "model", "tokens_in", "tokens_out", "held_microusd", "charged_microusd", "balance_microusd", "status", "reason"];
    const count = value => value === null || moneyNumber(value);
    if (!exact(body, fields) || body.ok !== true || body.tool !== "openrouter" || !/^[0-9a-f]{32}$/.test(body.call_id) ||
        typeof body.text !== "string" || Buffer.byteLength(body.text, "utf8") > 8388608 ||
        typeof body.model !== "string" || !body.model.trim() || [...body.model].length > 200 || /[\p{Cc}\p{Cf}]/u.test(body.model) ||
        !count(body.tokens_in) || !count(body.tokens_out) || !moneyNumber(body.held_microusd) || !moneyNumber(body.charged_microusd) ||
        body.charged_microusd > body.held_microusd || !moneyNumber(body.balance_microusd) ||
        !["succeeded", "failed", "cancelled", "timed_out"].includes(body.status) ||
        !(body.reason === null || body.reason === "usage_above_hold" && body.charged_microusd === body.held_microusd)) {
      throw new CallRefusal("call_unavailable", 1, wordsFor(tool).call_unavailable);
    }
    return Object.fromEntries(fields.map(name => [name, body[name]]));
  }
  if (tool.job) {
    try { return require("./jobs.js").checked(body, undefined, tool); }
    catch { throw new CallRefusal("call_unavailable", 1, wordsFor(tool).call_unavailable); }
  }
  const metered = body !== null && typeof body === "object" && Object.hasOwn(body, "held_microusd");
  if (!exact(body, ["ok", "tool", "call_id", "results", "price_microusd", "balance_microusd",
      ...(metered ? ["held_microusd", "charged_microusd"] : [])]) ||
      body.tool !== tool.slug || typeof body.call_id !== "string" || !/^[0-9a-f]{32}$/.test(body.call_id) ||
      !moneyNumber(body.price_microusd) || (metered ?
        !moneyNumber(body.held_microusd) || body.held_microusd === 0 || !moneyNumber(body.charged_microusd) ||
        body.charged_microusd !== body.price_microusd || body.charged_microusd > body.held_microusd : body.price_microusd === 0) ||
      !moneyNumber(body.balance_microusd) ||
      !Array.isArray(body.results) || body.results.length > tool.results.max_results || !body.results.every(row =>
        exact(row, tool.results.fields) && tool.results.fields.every(name => typeof row[name] === "string"))) {
    throw new CallRefusal("call_unavailable", 1, wordsFor(tool).call_unavailable);
  }
  return { ok: true, tool: body.tool, call_id: body.call_id, results: body.results,
    price_microusd: body.price_microusd, balance_microusd: body.balance_microusd,
    ...(metered ? { held_microusd: body.held_microusd, charged_microusd: body.charged_microusd } : {}) };
}

function plainCall(body, tool) {
  if (tool.results?.object && Object.hasOwn(body, "call_id")) return jsonValues.stringify(body.answers) +
    (tool.wait ? `\nmodel ${body.model} · tokens in ${body.tokens_in ?? "unknown"}` : "") +
    `\n${tool.slug} ${tool.unit} · call ${body.call_id} · held ${money(body.held_microusd)} · charged ${money(body.charged_microusd)} · balance ${money(body.balance_microusd)} USD` +
    (tool.wait ? ` · ${body.status}` : "");
  if (tool.chat && Object.hasOwn(body, "call_id")) {
    const text = body.text.replace(/[\p{Cc}\p{Cf}]/gu, c => c === "\n" || c === "\t" ? c : " ");
    return text + `\nmodel ${body.model} · tokens in ${body.tokens_in ?? "unknown"} · tokens out ${body.tokens_out ?? "unknown"}` +
      `\nopenrouter chat · call ${body.call_id} · held ${money(body.held_microusd)} · charged ${money(body.charged_microusd)} · balance ${money(body.balance_microusd)} USD · ${body.status}`;
  }
  if (tool.job) return require("./jobs.js").plain(body);
  const clean = value => value.replace(/[\p{Cc}\p{Cf}]+/gu, " ");
  const rows = body.results.map((row, index) => tool.results.fields.map((name, field) => {
    const value = clean(row[name]);
    return field === 0 ? `${index + 1}. ${value}` : "   " + (field >= 2 ? [...value].slice(0, 300).join("") : value);
  }).join("\n"));
  rows.push(`${tool.slug} ${tool.unit} · call ${body.call_id} · ${Object.hasOwn(body, "held_microusd") ?
    `held ${money(body.held_microusd)} · ` : ""}charged ${money(body.price_microusd)} · balance ${money(body.balance_microusd)} USD`);
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
        if (!exact(row, ["kind", "id", "at", "tool", "status", "price_microusd",
            ...(row.tool_type === "personal" ? ["tool_type"] : [])]) ||
            typeof row.id !== "string" || !/^[0-9a-f]{32}$/.test(row.id) || !slug(row.tool) ||
            !["charged", "failed"].includes(row.status) || !moneyNumber(row.price_microusd) ||
            (row.status === "failed" && row.price_microusd !== 0)) bad();
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
    if (row.kind === "call" && row.tool_type === "personal") return privateTools.line("history", {
      ...row, at: stamp, slug: row.tool,
      outcome: row.status === "failed" ? "failed · $0 charged" : "charged " + money(row.price_microusd) });
    return row.kind === "topup" ? `${stamp} · top-up ${row.id} · +${money(row.amount_microusd)}` :
      `${stamp} · call ${row.id} · ${row.tool} ${Object.hasOwn(tools, row.tool) ? tools[row.tool].unit : "call"} · ${row.status === "failed" ? "failed · $0 charged" : "charged " + money(row.price_microusd)}`;
  })].join("\n");
}

async function run(command, args, answer = new Answer(), tool = tools[(args[0] || "").toLowerCase().split(".")[0]]) {
  let store, output, failure;
  try {
    const binary = command === "call" && tool?.binary, parsed = binary ? binaryOutput.argumentsFor(args) : { args };
    const inputBody = await argumentsFor(command, parsed.args, tool);
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
    let body;
    if (binary) {
      const delivery = binaryOutput.open(parsed.file, keys);
      body = await binaryOutput.call({ base, key, keys, body: inputBody, tool, delivery, store, answer, words: wordsFor(tool), errors: ERRORS });
    } else {
      const signal = waitingSignals(store, command, answer, tool);
      body = command === "call" ? checkedCall(await request(base, command, key, keys, inputBody, undefined, signal, tool), tool) :
        await history(base, key, keys, signal);
    }
    output = answer.json ? body : binary && Object.hasOwn(body, "file") ? binaryOutput.plain(body) : command === "call" ? plainCall(body, tool) : plainHistory(body);
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); } catch { failure = new Refusal("badFile"); }
  }
  if (failure) {
    if (failure instanceof CallRefusal || failure instanceof InputRefusal || failure instanceof binaryOutput.BinaryRefusal) {
      answer.failure(failure.code, failure.message, failure.amounts);
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

module.exports = { run, money, APIFY_WORDS };
