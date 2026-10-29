"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, Refusal, apiBase, validKey, line, errorCode } = require("./auth.js").walletSupport;
const { exact, slug } = require("./tool-inputs.js");
const { hasCredential, envelope } = require("./prices.js");
const { Answer } = require("./answer.js");
const { out } = require("./output.js");
const jsonValues = require("./json-values.js");

const WORDS = Object.freeze({
  unknown: "this account has no such job · run opsfy jobs --json for this account's job ids",
  usage: "usage: opsfy job status|wait|stop|result <id> --json; run opsfy jobs --json for this account's job ids",
  unavailable: "the job could not be checked; do not start another · run opsfy job status <id> --json",
  list_unavailable: "the jobs list could not be read; do not start another job · run opsfy jobs --json again in a minute",
  result_unavailable: "the company no longer keeps this result; the charge stands · run opsfy job status <id> --json",
  result_refused: "Opsfy refused a result containing a credential; the charge stands",
  result_not_supported: "this tool cannot relay a result without a further charge · run opsfy job status <id> --json",
  stopped_waiting: "stopped waiting; the last job outcome is unconfirmed · run opsfy job status <id> --json",
  result_unknown: "Opsfy cannot follow this job, so it has no result to read; the charge stands · ask the person before starting it again",
  result_lost: "Opsfy does not retain the text; the charge stands · run opsfy job status <id> --json",
  result_audio: "Opsfy does not retain the audio; the charge stands · run opsfy job status <id> --json"
});
const startWords = Object.freeze({
  call_unavailable: "the job start is unconfirmed · run opsfy jobs --json before starting another",
  stopped_call: "stopped before the job answer came back · run opsfy jobs --json before starting another"
});
const MESSAGES = Object.freeze({
  pending: "The job is running; its hold stays reserved.",
  chat_pending: "The answer was interrupted; its hold stays reserved until the generation record settles the charge. Opsfy does not retain the text.",
  ended: "The job ended; its charge is final.",
  timed_out: "The job ran out of time; use a longer limit for a new call.",
  apify_timed_out: "The Actor reached its own time limit; its charge is final.",
  stop: "A stop was requested; the hold stays until the company reports the end.",
  unsupported: "This job cannot be stopped; it finishes and is charged as it ends.",
  start_unconfirmed: "The company did not confirm the start, so Opsfy cannot follow this job; it may still run, and it is charged its hold.",
  status_gone: "The company no longer has this job's status, so Opsfy cannot learn how it ended; it is charged its hold.",
  status_too_large: "The company's answer for this job was too large for Opsfy to read, so Opsfy cannot learn how it ended; it is charged its hold."
});
const ASK = "ask the person before starting it again";
const FIELDS = ["ok", "tool", "job_id", "status", "held_microusd", "charged_microusd", "released_microusd", "balance_microusd",
  "stoppable", "retention_seconds", "result_expires_at", "reason", "message", "next"];
const EXITS = { succeeded: 0, failed: 3, cancelled: 4, timed_out: 5, starting: 6, running: 6, unknown: 7 };
const jobID = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
const pending = body => body.status === "starting" || body.status === "running";
const words = (name, id) => WORDS[name].replaceAll("<id>", id || "<id>");

class JobRefusal extends Error {
  constructor(code, message, status = 1, next) {
    super(message);
    this.code = code; this.status = status; this.next = next;
  }
}

function readReceipt(value) {
  return exact(value, ["call_id", "held_microusd", "charged_microusd"]) && jobID(value.call_id) &&
    amount(value.held_microusd) && value.held_microusd > 0 && (value.charged_microusd === null ||
      amount(value.charged_microusd) && value.charged_microusd <= value.held_microusd);
}

function readLine(value) {
  const money = require("./call.js").money;
  return `result read · call ${value.call_id} · held ${money(value.held_microusd)} · charged ${value.charged_microusd === null ? "pending" : money(value.charged_microusd)} USD`;
}

function resultEnvelope(source) {
  const lexical = jsonValues.parse(source);
  const numbers = value => value instanceof jsonValues.JSONNumber ? Number(value.token) :
    Array.isArray(value) ? value.map(numbers) : value && typeof value === "object" ?
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k, numbers(v)])) : value;
  if (!lexical || typeof lexical !== "object" || Array.isArray(lexical)) throw new Error("invalid envelope");
  return Object.fromEntries(Object.entries(lexical).map(([k, v]) => [k, ["results", "answers"].includes(k) ? v : numbers(v)]));
}

function checked(body, expectedID, tool, results = false) {
  if (body?.rental === true && !results) return require("./rentals.js").checked(body, expectedID, tool);
  const text = results && body && Object.hasOwn(body, "text");
  const rows = results && body?.tool === "apify";
  const serverless = results && body?.tool === "runpod-serverless";
  const fields = [...FIELDS, ...(text ? ["text"] : []), ...(results ? [serverless ? "answers" : "results"] : []), ...(rows ? ["result_read"] : [])];
  if (!exact(body, fields) || body.ok !== true || !slug(body.tool) ||
      !jobID(body.job_id) || (expectedID && body.job_id !== expectedID) || (tool && body.tool !== tool.slug) ||
      !Object.hasOwn(EXITS, body.status) || !amount(body.held_microusd) || (!body.held_microusd && body.tool !== "openrouter") ||
      !amount(body.released_microusd) || !amount(body.balance_microusd) || typeof body.stoppable !== "boolean" ||
      !(body.retention_seconds === null || Number.isInteger(body.retention_seconds) && body.retention_seconds >= 1 && body.retention_seconds <= 31536000) ||
      !(body.result_expires_at === null || amount(body.result_expires_at)) ||
      !(body.reason === null || ["usage_missing", "usage_above_hold", "start_unconfirmed", "status_gone", "status_too_large", "not_sent"].includes(body.reason) ||
        body.status === "failed" && /^http_[1-5][0-9]{2}$/.test(body.reason))) throw new Error("invalid job answer");
  if (tool && (tool.job.stoppable !== body.stoppable || tool.job.retention_seconds !== body.retention_seconds)) throw new Error("invalid job capabilities");
  if (pending(body) ? body.charged_microusd !== null || body.released_microusd !== 0 || body.reason !== null || body.result_expires_at !== null :
      !amount(body.charged_microusd) || body.charged_microusd > body.held_microusd || body.released_microusd !== body.held_microusd - body.charged_microusd) throw new Error("invalid job amounts");
  const unknown = body.status === "unknown";
  if (unknown ? !["start_unconfirmed", "status_gone", "status_too_large"].includes(body.reason) || body.charged_microusd !== body.held_microusd || body.result_expires_at !== null :
      ["start_unconfirmed", "status_gone", "status_too_large"].includes(body.reason)) throw new Error("invalid job outcome");
  const chat = ["openrouter", "jev"].includes(body.tool);
  if (chat && (body.stoppable || body.retention_seconds !== null || body.result_expires_at !== null)) throw new Error("invalid chat job capabilities");
  const read = body.tool === "apify" && !body.stoppable;
  const next = read || body.tool === "tavily-research" && !pending(body) && body.status !== "succeeded" && !unknown ? "opsfy job status " + body.job_id + " --json" : unknown ? ASK : "opsfy job " + (pending(body) ? chat ? "status" : "wait" : "result") + " " + body.job_id + " --json";
  const messages = unknown ? [MESSAGES[body.reason]] : pending(body) ?
    [chat ? MESSAGES.chat_pending : MESSAGES.pending, body.stoppable ? MESSAGES.stop : MESSAGES.unsupported] :
    [body.status === "timed_out" ? body.tool === "apify" ? MESSAGES.apify_timed_out : MESSAGES.timed_out : MESSAGES.ended];
  if (body.next !== next || !messages.includes(body.message)) throw new Error("invalid job next action");
  if (rows && (!readReceipt(body.result_read) || !Array.isArray(body.results) || body.results.length > 50 || pending(body) || unknown ||
      Buffer.byteLength(jsonValues.stringify(body.results), "utf8") > 262144 || !body.results.every(row => row && typeof row === "object" &&
        !Array.isArray(row) && !(row instanceof jsonValues.JSONNumber) && jsonValues.valid(row, 262144, 16)))) throw new Error("invalid JSON rows");
  if (serverless && (pending(body) || unknown || !exact(body.answers, ["output"]) || !jsonValues.valid(body.answers, 262155, 17, [], true))) throw new Error("invalid serverless result");
  if (results && !rows && !serverless && (pending(body) || unknown || !Array.isArray(body.results) || body.results.length > 50 ||
      !body.results.every(row => row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).length >= 1 && Object.keys(row).length <= 8 &&
        Object.entries(row).every(([name, value]) => /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) && !["constructor", "prototype"].includes(name) && typeof value === "string")))) throw new Error("invalid job results");
  if (text && (typeof body.text !== "string" || Buffer.byteLength(body.text, "utf8") > 8388608)) throw new Error("invalid job text");
  return Object.fromEntries(fields.map(name => [name, body[name]]));
}

function plain(body) {
  if (body.rental) return require("./rentals.js").plain(body);
  const money = require("./call.js").money;
  const clean = value => value.replace(/[\p{Cc}\p{Cf}]+/gu, " ");
  const rows = body.tool === "apify" && body.results ? [clean(jsonValues.stringify(body.results))] : (body.results || []).map((row, index) => Object.values(row).map((value, field) =>
    (field === 0 ? `${index + 1}. ` : "   ") + clean(value)).join("\n"));
  if (Object.hasOwn(body, "answers")) rows.unshift(jsonValues.stringify(body.answers));
  if (Object.hasOwn(body, "text")) rows.unshift(body.text.replace(/[\p{Cc}\p{Cf}]/gu, value =>
    value === "\n" || value === "\t" ? value : " "));
  rows.push(`job ${body.job_id} · ${body.status} · held ${money(body.held_microusd)} · charged ${body.charged_microusd === null ? "pending" : money(body.charged_microusd)} · released ${money(body.released_microusd)} · balance ${money(body.balance_microusd)} USD · ${body.message} · ${body.status === "unknown" ? "" : "run "}${body.next}`);
  if (body.result_read) rows.push(readLine(body.result_read));
  return rows.join("\n");
}

function signals(store, id, answer) {
  const controller = new AbortController();
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.removeListener(signal, store.signalHandlers.get(signal));
    const handler = () => {
      controller.abort();
      try { store.release(true); } catch {}
      if (signal === "SIGINT") answer.failure("stopped_waiting", words("stopped_waiting", id), { job_id: id });
      process.exit(status);
    };
    store.signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  return controller.signal;
}

async function request(base, key, keys, id, action, signal, end) {
  const url = base + "/api/jobs" + (id ? "/" + id + (["stop", "result"].includes(action) ? "/" + action : "") : "");
  if (hasCredential(url, keys)) throw new Refusal("base", 2);
  const controller = new AbortController(), duration = Math.min(10000, end - Date.now());
  let response, timer, consumed = false;
  const abort = () => {
    controller.abort();
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const unavailable = () => new JobRefusal("job_unavailable", id ? words("unavailable", id) : WORDS.list_unavailable);
  try {
    if (duration <= 0) throw unavailable();
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort(); reject(unavailable()); }, duration); });
    return await Promise.race([deadline, (async () => {
      response = await fetch(url, { method: action === "stop" ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", authorization: "Bearer " + key, "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1", "Opsfy-Chat": "chat-v1", "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1", "Opsfy-Rentals": "rentals-v1", "Opsfy-Text": "text-v1", "Opsfy-USD": "usd-v1", "Opsfy-Serverless": "serverless-v1",
          ...(action === "stop" ? { "content-type": "application/json" } : {}) },
        ...(action === "stop" ? { body: "{}" } : {}) });
      if (controller.signal.aborted || !envelope(response, url)) throw unavailable();
      const text = await response.text();
      consumed = true;
      const bytes = Buffer.byteLength(text);
      if (controller.signal.aborted || bytes > (action === "result" ? 8454144 : 1048576)) throw unavailable();
      const body = action === "result" ? resultEnvelope(text) : JSON.parse(text);
      if (hasCredential(text, keys)) {
        if (action === "result" && body?.tool === "runpod-serverless") throw new JobRefusal("result_refused",
          WORDS.result_refused, 1, "opsfy job status " + id + " --json");
        throw unavailable();
      }
      if (bytes > 1048576 && !(action === "result" && typeof body?.text === "string")) throw unavailable();
      if (body?.ok === false) {
        if (body.error === "invalid_key" && response.status === 401 && exact(body, ["ok", "error"])) throw new Refusal("invalidKey");
        if (body.error === "unknown_job" && response.status === 404 && exact(body, ["ok", "error"])) throw new JobRefusal("unknown_job", WORDS.unknown);
        if (action === "result" && body.error === "insufficient_balance" && response.status === 402 &&
            exact(body, ["ok", "error", "price_microusd", "balance_microusd"]) && amount(body.price_microusd) && amount(body.balance_microusd)) {
          const money = require("./call.js").money;
          throw new JobRefusal(body.error, `the result read needs a hold of ${money(body.price_microusd)} and the balance is ${money(body.balance_microusd)}; nothing was charged · ask the person to add money, then run opsfy topup 10 --json`, 1, "opsfy topup 10 --json");
        }
        if (action === "result" && body.error === "rate_limited" && response.status === 429 && exact(body, ["ok", "error"])) {
          const next = "opsfy job result " + id + " --json";
          throw new JobRefusal(body.error, "too many calls (10 a minute for each account); nothing was charged · wait 60 seconds, then run " + next, 1, next);
        }
        if (action === "result" && exact(body, ["ok", "error", "message", "next"])) {
          const cases = {
            result_pending: [409, "this job is still running; nothing is charged until it ends", "wait"],
            result_unavailable: [410, "this job ended without a result; its charge stands", "status"],
            serverless_unavailable: [503, "Runpod is not available right now; nothing was charged", "result"]
          };
          const ruled = cases[body.error];
          if (ruled && response.status === ruled[0] && body.message === ruled[1] && body.next === "opsfy job " + ruled[2] + " " + id + " --json")
            throw new JobRefusal(body.error, body.message, 1, body.next);
        }
        if (Object.hasOwn(require("./serverless.js").RESULT_ERRORS, body.error) && response.status === (body.error === "result_too_large" ? 413 : 422)) {
          if (!exact(body, ["ok", "error", "message", "next"]) || body.message !== require("./serverless.js").RESULT_ERRORS[body.error] || body.next !== "opsfy job status " + id + " --json") throw unavailable();
          throw new JobRefusal(body.error, body.message, 1, body.next);
        }
        if (["result_unavailable", "result_not_supported"].includes(body.error) && response.status === (body.error === "result_unavailable" ? 410 : 409)) {
          if (Object.hasOwn(body, "result_read")) {
            const messages = ["Opsfy refused a result over 262,144 bytes; the read charge stands",
              "Apify no longer keeps the result; the run charge stands", "Apify did not answer; the read charge stands",
              "Opsfy could not relay the result; the read charge stands", "Opsfy did not send this result read; nothing was charged"];
            if (body.error !== "result_unavailable" || !exact(body, ["ok", "error", "message", "next", "result_read"]) ||
                !readReceipt(body.result_read) || !messages.includes(body.message) ||
                body.next !== "opsfy job status " + body.result_read.call_id + " --json") throw unavailable();
            const failure = new JobRefusal(body.error, body.message + " · " + readLine(body.result_read) + " · run " + body.next, 1, body.next);
            failure.result_read = body.result_read;
            throw failure;
          }
          const unknown = body.next === ASK, message = body.error === "result_not_supported" && body.message === "Use the rental address directly." ?
            "Use the rental address directly. · run opsfy job status " + id + " --json" :
            words(unknown ? "result_unknown" : body.error === "result_unavailable" && body.message === "Opsfy does not retain the audio; the charge stands" ? "result_audio" : body.error === "result_unavailable" && body.message === "Opsfy does not retain the text; the charge stands" ? "result_lost" : body.error, id);
          if (!exact(body, ["ok", "error", "message", "next"]) || message !== body.message + " · " + (unknown ? "" : "run ") + body.next) throw unavailable();
          throw new JobRefusal(body.error, message, 1, body.next);
        }
        throw unavailable();
      }
      if (response.status !== 200) throw unavailable();
      if (id) {
        if (action === "result" && body.tool === "runpod-serverless" && jsonValues.credential(jsonValues.stringify(body.answers), keys))
          throw new JobRefusal("result_refused", WORDS.result_refused, 1, "opsfy job status " + id + " --json");
        return checked(body, id, undefined, action === "result");
      }
      if (!exact(body, ["ok", "jobs"]) || body.ok !== true || !Array.isArray(body.jobs) || body.jobs.length > 50 ||
          new Set(body.jobs.map(row => row.job_id)).size !== body.jobs.length) throw unavailable();
      return { ok: true, jobs: body.jobs.map(row => checked(row)) };
    })()]);
  } catch (error) {
    if (error instanceof JobRefusal || error instanceof Refusal) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (!consumed) abort();
  }
}

function pause(ms) {
  // Signal handlers abort the active request, release the lock and exit. Between
  // requests only the cadence timer is needed; it does not extend the wait bound.
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(command, args, answer = new Answer()) {
  let store, output, failure, code = 0;
  const action = command === "jobs" ? "list" : args[0], id = command === "job" ? args[1] : undefined;
  try {
    if (command === "jobs" ? args.length !== 0 : args.length !== 2 || !["status", "wait", "stop", "result"].includes(action) || !jobID(id)) {
      throw new JobRefusal("usage", WORDS.usage, 2);
    }
    const base = apiBase();
    if (process.env.OPSFY_DRY_RUN === "1") throw new JobRefusal("dry_run",
      `OPSFY_DRY_RUN=1 is set, so ${command} does not run · unset OPSFY_DRY_RUN to run it`, 2);
    store = new Store();
    const parent = fs.lstatSync(path.dirname(store.directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Refusal("badFile");
    store.prepare(); store.acquire();
    const state = store.load();
    if (state.pending) {
      if (hasCredential(state.pending.email)) throw new Refusal("badFile");
      throw new Refusal("pending", 2, { email: state.pending.email });
    }
    const environmentKey = process.env.OPSFY_API_KEY || "";
    if (environmentKey && !validKey(environmentKey)) throw new Refusal("envInvalid", 2);
    const key = environmentKey || state.key;
    if (!key) throw new Refusal("noKey", 2);
    const signal = signals(store, id, answer), end = Date.now() + (action === "wait" ? 600000 : 10000);
    let body;
    do {
      const started = Date.now();
      body = await request(base, key, [key, state.key], id, action, signal, end);
      if (action !== "wait" || !(body.rental ? require("./rentals.js").pending(body) : pending(body))) break;
      await pause(Math.min(3000, Math.max(0, end - Date.now())));
      if (Date.now() < started) throw new Error("invalid clock");
    } while (Date.now() < end);
    if (action === "wait") code = body.rental ? require("./rentals.js").exit(body) : EXITS[body.status];
    output = answer.json ? body : action === "list" ? body.jobs.map(plain).join("\n") : plain(body);
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); } catch { failure = new Refusal("badFile"); }
  }
  if (failure) {
    if (failure instanceof JobRefusal) {
      const message = !answer.json && failure.next && !failure.message.includes(failure.next) ? failure.message + " · run " + failure.next : failure.message;
      answer.failure(failure.code, message, { ...(failure.next ? { next: failure.next } : {}),
        ...(failure.result_read ? { result_read: failure.result_read } : {}) });
      return failure.status;
    }
    let message = line("badFile"), name = "key_files", status = 1;
    if (failure instanceof Refusal) {
      message = line(failure.word, failure.values); name = errorCode(failure.word); status = failure.status;
      if (hasCredential(message)) { message = line("badFile"); name = "key_files"; status = 1; }
    }
    answer.failure(name, message);
    return status;
  }
  if (answer.json) answer.success(output); else out(output);
  return code;
}

module.exports = { run, checked, plain, startWords };
