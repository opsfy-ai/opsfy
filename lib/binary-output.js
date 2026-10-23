"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { exact } = require("./tool-inputs.js");
const { hasCredential } = require("./prices.js");
const { Refusal } = require("./auth.js").walletSupport;

const WORDS = Object.freeze({
  elevenlabs_model: "model id not found; nothing was charged · run opsfy info elevenlabs --json for model ids, then run the call with --input model=<id>",
  elevenlabs_limit: "the text exceeds this model's limit of <limit> characters; nothing was charged · shorten the text or choose a model with a larger limit from opsfy info elevenlabs --json",
  elevenlabs_changed: "this model's limit or rate has changed; nothing was charged · ask the person to check ElevenLabs model pricing before running the call again",
  elevenlabs_voice: "the voice is unavailable or has a custom rate; nothing was charged · run opsfy info elevenlabs --json for voices, then run the call with --input voice=<id>",
  elevenlabs_unavailable: "ElevenLabs is not available right now; nothing was charged · ask the person to check ElevenLabs availability before running the call again",
  elevenlabs_refused: "ElevenLabs refused the call; nothing was charged · wait 60 seconds, then run the call again; if it is refused again, ask the person before calling again",
  output_required: "this tool returns a file · run the call with --out <new-file.mp3> --json",
  output_unavailable: "the output path must name a new writable regular file; nothing was charged · choose a new path and run the call with --out <new-file.mp3> --json",
  binary_lost: "the file is incomplete and the call may have been charged · run opsfy jobs --json and check the job before starting another call"
});

class BinaryRefusal extends Error {
  constructor(code, status = 1, message = WORDS[code], amounts) {
    super(message); this.code = code; this.status = status; this.amounts = amounts;
  }
}

function argumentsFor(args) {
  const indexes = args.flatMap((v, i) => v === "--out" ? [i] : []), at = indexes[0];
  if (indexes.length !== 1 || at === 0 || !args[at + 1] || args[at + 1] === "-" || args[at + 1].startsWith("--")) {
    throw new BinaryRefusal("output_required", 2);
  }
  const file = args[at + 1];
  if (/[\p{Cc}\p{Cs}]/u.test(file)) throw new BinaryRefusal("output_unavailable", 2);
  return { file, args: [...args.slice(0, at), ...args.slice(at + 2)] };
}

function open(file, keys) {
  let fd, owned = false;
  try {
    if (hasCredential(file, keys)) throw new Error();
    const target = path.resolve(file), parent = path.dirname(target);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error();
    if (fs.realpathSync(parent) !== parent) throw new Error();
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    owned = true;
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error();
    return { file, target, fd, stat, bytes: 0, metadata: null };
  } catch {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { if (owned) fs.unlinkSync(path.resolve(file)); } catch {}
    throw new BinaryRefusal("output_unavailable", 2);
  }
}

function remove(delivery) {
  if (delivery.fd !== undefined) {
    try { fs.closeSync(delivery.fd); delivery.fd = undefined; } catch {}
  }
  try {
    const stat = fs.lstatSync(delivery.target);
    if (stat.dev !== delivery.stat.dev || stat.ino !== delivery.stat.ino || !stat.isFile()) return "remaining";
    fs.unlinkSync(delivery.target);
    return "removed";
  } catch (error) { return error.code === "ENOENT" ? "removed" : "remaining"; }
}

const amount = n => Number.isSafeInteger(n) && n >= 0;
const id = s => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const money = n => require("./call.js").money(n);

function metadata(incoming, tool) {
  const headers = new Map();
  for (let at = 0; at < incoming.rawHeaders.length; at += 2) {
    const name = incoming.rawHeaders[at].toLowerCase(), value = incoming.rawHeaders[at + 1];
    if (headers.has(name) && (["content-type", "cache-control"].includes(name) || name.startsWith("opsfy-")) || typeof value !== "string") throw new Error();
    headers.set(name, value);
    if (["cookie", "set-cookie", "set-cookie2", "location", "retry-after", "allow"].includes(name) ||
        name.startsWith("access-control-allow-")) throw new Error();
  }
  const get = name => headers.get(name), integer = name => {
    const value = get(name);
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !amount(Number(value))) throw new Error();
    return Number(value);
  };
  if (incoming.statusCode !== 200 || get("content-type") !== tool.binary.media_type || get("cache-control") !== "no-store" ||
      !id(get("opsfy-call-id"))) throw new Error();
  const result = { call_id: get("opsfy-call-id"), counted_units: get("opsfy-counted-units") === "unknown" ? null : integer("opsfy-counted-units"),
    held_microusd: integer("opsfy-held-microusd"), charged_microusd: integer("opsfy-charged-microusd"),
    balance_microusd: integer("opsfy-balance-microusd"), reason: get("opsfy-reason") === "none" ? null : get("opsfy-reason") };
  if (!result.held_microusd || result.charged_microusd > result.held_microusd ||
      ![null, "usage_missing", "usage_above_hold"].includes(result.reason) ||
      (result.counted_units === null) !== (result.reason === "usage_missing") ||
      result.reason !== null && result.charged_microusd !== result.held_microusd) throw new Error();
  return result;
}

function facts(tool, delivery) {
  return { tool: tool.slug, file: delivery.file, bytes: delivery.bytes, ...delivery.metadata };
}

function plain(body) {
  return `file ${body.file} · ${body.bytes} bytes · counted units ${body.counted_units ?? "unknown"} · call ${body.call_id} · held ${money(body.held_microusd)} · charged ${money(body.charged_microusd)} · balance ${money(body.balance_microusd)} USD`;
}

function incomplete(tool, delivery) {
  const partial = remove(delivery);
  if (!delivery.metadata) return new BinaryRefusal("binary_lost", 1, WORDS.binary_lost +
    (partial === "remaining" ? ` · partial file remains at ${delivery.file}; remove it before another call` : ""));
  const body = facts(tool, delivery);
  const message = plain(body) + (partial === "remaining" ?
    ` · the file is incomplete and remains at ${delivery.file}; remove that partial file` : " · the file was incomplete and removed") +
    `; the charge stands · run opsfy job status ${body.call_id} --json before starting another call`;
  return new BinaryRefusal("binary_incomplete", 1, message, { ...body, partial_file: partial });
}

function refusal(incoming, body, tool, words, errors) {
  const code = body?.error, status = incoming.statusCode;
  if (code === "elevenlabs_charged") {
    const fields = ["call_id", "counted_units", "held_microusd", "charged_microusd", "balance_microusd", "reason", "next"];
    if (status !== 502 || !exact(body, ["ok", "error", ...fields]) || !id(body.call_id) ||
        !amount(body.counted_units) || !amount(body.held_microusd) || !amount(body.charged_microusd) || !body.charged_microusd ||
        body.charged_microusd > body.held_microusd || !amount(body.balance_microusd) ||
        !(body.reason === "usage_above_hold" && body.charged_microusd === body.held_microusd || /^http_[1-5][0-9]{2}$/.test(body.reason)) ||
        body.next !== "opsfy job status " + body.call_id + " --json") throw new Error();
    const message = `ElevenLabs failed the call · call ${body.call_id} · held ${money(body.held_microusd)} · charged ${money(body.charged_microusd)} · balance ${money(body.balance_microusd)} USD · reason ${body.reason} · run ${body.next} before starting another call`;
    return new BinaryRefusal(code, 1, message, Object.fromEntries(fields.map(k => [k, body[k]])));
  }
  if (code === "elevenlabs_limit") {
    if (status !== 400 || !exact(body, ["ok", "error", "limit"]) || !amount(body.limit) || !body.limit || body.limit > 40000) throw new Error();
    return new BinaryRefusal(code, 1, WORDS[code].replace("<limit>", body.limit.toLocaleString("en-US")));
  }
  if (Object.hasOwn(WORDS, code) && code.startsWith("elevenlabs_")) {
    if (status !== (code === "elevenlabs_unavailable" ? 503 : code === "elevenlabs_refused" ? 502 : 400) ||
        !exact(body, ["ok", "error"])) throw new Error();
    return new BinaryRefusal(code);
  }
  if (!Object.hasOwn(errors, code) || status !== errors[code][0]) throw new Error();
  if (code === "insufficient_balance") {
    if (!exact(body, ["ok", "error", "price_microusd", "balance_microusd"]) || !amount(body.price_microusd) ||
        !body.price_microusd || !amount(body.balance_microusd)) throw new Error();
    return new BinaryRefusal(code, 1, `a ${tool.slug} ${tool.unit} needs a hold of ${money(body.price_microusd)} and the balance is ${money(body.balance_microusd)}; nothing was charged · ask the person to add money, then run opsfy topup 10 --json`);
  }
  if (code === "invalid_input") {
    if (!exact(body, ["ok", "error", "allowed_inputs"]) ||
        JSON.stringify(body.allowed_inputs) !== JSON.stringify(tool.inputs.map(i => i.name))) throw new Error();
    return new BinaryRefusal(code, 1, words[code]);
  }
  if (!exact(body, ["ok", "error"])) throw new Error();
  if (code === "invalid_key") return new Refusal("invalidKey");
  return new BinaryRefusal(errors[code][1], 1, words[errors[code][1]]);
}

async function call({ base, key, keys, body, tool, delivery, store, answer, words, errors }) {
  const url = new URL(base + "/api/call"), controller = new AbortController();
  let incoming, req;
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.removeListener(signal, store.signalHandlers.get(signal));
    const handler = () => {
      controller.abort(); incoming?.destroy();
      const error = incomplete(tool, delivery);
      try { store.release(true); } catch {}
      answer.failure(error.code, error.message, error.amounts);
      process.exit(status);
    };
    store.signalHandlers.set(signal, handler); process.on(signal, handler);
  }
  try {
    if (hasCredential(url.href, keys)) throw new Refusal("base", 2);
    incoming = await new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? require("node:https") : require("node:http");
      req = client.request(url, { method: "POST", agent: false, signal: controller.signal,
        headers: { accept: tool.binary.media_type + ", application/json", authorization: "Bearer " + key,
          "content-type": "application/json", "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1",
          "Opsfy-Chat": "chat-v1", "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1" } }, resolve);
      req.on("error", reject);
      req.end(tool.json ? require("./json-values.js").stringify(body) : JSON.stringify(body));
    });
    if (incoming.headers["content-type"] === "application/json; charset=utf-8") {
      const headers = new Headers();
      for (let at = 0; at < incoming.rawHeaders.length; at += 2) headers.append(incoming.rawHeaders[at], incoming.rawHeaders[at + 1]);
      if (!require("./prices.js").envelope({ url: url.href, redirected: false, status: incoming.statusCode, headers }, url.href)) throw new Error();
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length; if (length > 1048576) throw new Error(); chunks.push(chunk);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
      if (hasCredential(text, keys)) throw new Error();
      const value = JSON.parse(text);
      if (value?.ok === false) throw refusal(incoming, value, tool, words, errors);
      if (incoming.statusCode !== 202) throw new Error();
      const job = require("./jobs.js").checked(value, undefined, tool);
      if (job.status !== "unknown") throw new Error();
      if (remove(delivery) === "remaining") throw new BinaryRefusal("binary_lost", 1, WORDS.binary_lost +
        ` · partial file remains at ${delivery.file}; remove it before another call`);
      return job;
    }
    delivery.metadata = metadata(incoming, tool);
    for await (const bytes of incoming) {
      for (let at = 0; at < bytes.length;) {
        const length = Math.min(65536, bytes.length - at), written = fs.writeSync(delivery.fd, bytes, at, length);
        if (!Number.isSafeInteger(written) || written <= 0 || written > length) throw new Error();
        at += written; delivery.bytes += written;
        if (!amount(delivery.bytes)) throw new Error();
      }
    }
    fs.closeSync(delivery.fd); delivery.fd = undefined;
    return { ok: true, ...facts(tool, delivery) };
  } catch (error) {
    controller.abort(); incoming?.destroy(); req?.destroy();
    if (error instanceof BinaryRefusal || error instanceof Refusal) {
      if (remove(delivery) === "remaining" && !error.message.includes(" · partial file remains at ")) {
        const suffix = ` · partial file remains at ${delivery.file}; remove it before another call`;
        if (error instanceof BinaryRefusal) error.message += suffix;
        else throw new BinaryRefusal(require("./auth.js").walletSupport.errorCode(error.word), error.status,
          require("./auth.js").walletSupport.line(error.word, error.values) + suffix);
      }
      throw error;
    }
    throw incomplete(tool, delivery);
  }
}

module.exports = { WORDS, BinaryRefusal, argumentsFor, open, call, plain };
