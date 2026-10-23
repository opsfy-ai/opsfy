"use strict";

const { exact } = require("./tool-inputs.js");
const { hasCredential } = require("./prices.js");
const FIELDS = ["ok", "tool", "job_id", "rental", "status", "pod_state", "ready", "addresses", "gpu", "gpu_count", "cloud", "paid_until",
  "held_microusd", "charged_microusd", "reserved_microusd", "released_microusd", "balance_microusd", "reason", "message", "next"];
const WORDS = Object.freeze({
  rental_price: "GPU id, price or count is unavailable; nothing was charged · run opsfy info runpod --json and choose a listed GPU, count and cloud",
  rental_capacity: "Runpod could not place this request; nothing was charged · try another GPU, count or cloud with opsfy call runpod",
  rental_unavailable: "Runpod is not available right now; nothing was charged · ask the person to check Runpod availability before starting another rental",
  rental_refused: "Runpod refused the start; nothing was charged · run opsfy jobs --json and ask the person before starting another rental"
});
const PRICE = "price depends on the GPU, cloud, count and disk; the call holds 15 minutes at the current rate";
const CATALOG = "GPU prices are per GPU-hour. Container disk is additional; a start quotes and holds 15 minutes at the current price.";
const ASK = "ask the person before starting it again";
const amount = value => Number.isSafeInteger(value) && value >= 0;
const port = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const text = value => typeof value === "string" && value.trim().length && [...value].length <= 200 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const ipv4 = value => typeof value === "string" && /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value) && value.split(".").every(n => Number(n) <= 255);

function validInputs(values) {
  const macro = value => typeof value === "string" ? /RUNPOD_SECRET_/i.test(value) :
    value && typeof value === "object" ? Object.entries(value).some(([k,v]) => macro(k) || macro(v)) : false;
  const ports = values.ports ?? [];
  return !macro(values) && ["SECURE", "COMMUNITY"].includes(values.cloud ?? "SECURE") &&
    (!Object.hasOwn(values, "min_cuda") || /^[0-9]+\.[0-9]+$/.test(values.min_cuda)) &&
    Array.isArray(ports) && ports.length <= 32 && new Set(ports).size === ports.length &&
    ports.filter(p => typeof p === "string" && p.endsWith("/http")).length <= 10 &&
    ports.every(p => typeof p === "string" && /^[1-9][0-9]{0,4}\/(http|tcp)$/.test(p) && Number(p.split("/")[0]) <= 65535) &&
    (!Object.hasOwn(values, "env") || values.env && typeof values.env === "object" && !Array.isArray(values.env) &&
      Object.entries(values.env).every(([k,v]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === "string" && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)));
}

function checked(body, expectedID, tool) {
  if (!exact(body, FIELDS) || body.ok !== true || body.rental !== true || body.tool !== "runpod" || tool && tool.slug !== body.tool ||
      typeof body.job_id !== "string" || !/^[0-9a-f]{32}$/.test(body.job_id) || expectedID && body.job_id !== expectedID ||
      !["starting", "active", "searching", "deleting", "deleted", "refused"].includes(body.status) ||
      !(body.pod_state === null || ["PROVISIONING", "STARTING", "RUNNING", "EXITED", "ERROR", "TERMINATED"].includes(body.pod_state)) ||
      typeof body.ready !== "boolean" || !text(body.gpu) || !amount(body.gpu_count) || body.gpu_count === 0 || !["SECURE", "COMMUNITY"].includes(body.cloud) ||
      !amount(body.paid_until) || body.paid_until > 8640000000000000 ||
      !["held", "charged", "reserved", "released", "balance"].every(k => amount(body[k + "_microusd"])) ||
      BigInt(body.held_microusd) !== BigInt(body.charged_microusd) + BigInt(body.reserved_microusd) + BigInt(body.released_microusd) ||
      !(body.reason === null || ["stopped", "balance", "price_changed", "ended", "storage_changed", "status_unavailable", "start_unconfirmed",
        "scan_incomplete", "name_ambiguous", "record_too_large", "not_sent"].includes(body.reason) || /^http_[3-5][0-9]{2}$/.test(body.reason)) ||
      !Array.isArray(body.addresses) || body.addresses.length > 32 || !body.addresses.every(a => port(a?.port) && (a.type === "http" ?
        exact(a, ["type", "port", "url"]) && typeof a.url === "string" && new RegExp("^https://[A-Za-z0-9_-]{1,200}-" + a.port + "\\.proxy\\.runpod\\.net$").test(a.url) :
        a.type === "tcp" && exact(a, ["type", "port", "ip", "public_port"]) && ipv4(a.ip) && port(a.public_port))) ||
      new Set(body.addresses.map(a => a.port + "/" + a.type)).size !== body.addresses.length ||
      ["starting", "searching", "deleted", "refused"].includes(body.status) && body.addresses.length ||
      hasCredential(JSON.stringify(body))) throw new Error("invalid rental answer");
  const done = body.status === "deleted";
  let message = "The rental is held ahead. The address is public: keep your server key; stream long generations or add a TCP port (HTTP proxy connections end at 100 seconds).";
  let next = "opsfy job " + (body.status === "active" ? "wait" : "status") + " " + body.job_id + " --json";
  if (done) message = "The pod is deleted; its charge is final.";
  if (body.reason === "not_sent") { message="Opsfy did not send this start; nothing was charged."; next="opsfy info runpod --json"; }
  else if (body.status === "refused") { message="Runpod refused this start; nothing was charged."; next="opsfy info runpod --json"; }
  else if (body.status === "searching") {
    if (/^http_5[0-9]{2}$/.test(body.reason)) { message="Runpod failed this start; nothing was charged. Opsfy is checking that no pod was left running."; next="opsfy info runpod --json"; }
    else { message="The start is unconfirmed; cleanup is pending. Ask the person before starting another rental."; next="ask the person before starting it again"; }
  } else if (body.status === "deleting" && body.reason === "start_unconfirmed") {
    message="The start is unconfirmed; cleanup is pending. Ask the person before starting another rental."; next=ASK;
  } else if (body.status === "deleting" && ["stopped","balance","ended","storage_changed"].includes(body.reason)) {
    message={stopped:"The pod is being deleted after the stop; its charge is final once deletion is confirmed.",
      balance:"The paid time ended and the next 15 minutes could not be held, so the pod is being deleted. Add money before starting another rental.",
      ended:"The pod's container ended, so the pod is being deleted; its charge is final once deletion is confirmed.",
      storage_changed:"The pod changed in a way Opsfy cannot hold, so it is being deleted; its charge is final once deletion is confirmed."}[body.reason];
  } else if (body.reason==="balance") {
    message=done?"The next 15 minutes could not be held, so the pod is deleted; its charge is final. Add money before starting another rental.":
      "The next 15 minutes could not be held. Add money before "+new Date(body.paid_until).toISOString()+" with opsfy topup 10 --json, then run opsfy job status "+body.job_id+" --json to keep this rental; without it, the pod is deleted then.";
    if(!done)next="opsfy topup 10 --json";
  } else if(body.reason==="price_changed")message="The pod price changed; deletion is required. Start again after deletion is confirmed.";
  else if(body.reason==="status_unavailable"&&!done)message="The company is not available to confirm this rental. Deletion is pending; check status before starting another rental.";
  if (body.message !== message || body.next !== next || ["deleted", "refused"].includes(body.status) && body.reserved_microusd !== 0) throw new Error("invalid rental outcome");
  return Object.fromEntries(FIELDS.map(k => [k, body[k]]));
}

function plain(body) {
  const { money } = require("./call.js");
  return [`rental ${body.job_id} · ${body.status} · ${body.pod_state ?? "unknown"} · ${body.gpu} × ${body.gpu_count} · ${body.cloud}`,
    ...body.addresses.map(a => a.type === "http" ? "address " + a.url : `address ${a.ip}:${a.public_port} (TCP ${a.port})`),
    `paid until ${new Date(body.paid_until).toISOString()} · held ${money(body.held_microusd)} · charged ${money(body.charged_microusd)} · reserved ${money(body.reserved_microusd)} · released ${money(body.released_microusd)} · balance ${money(body.balance_microusd)} USD`,
    body.message + " · " + (body.next === ASK ? "" : "run ") + body.next].join("\n");
}
function pending(body) { return ["starting", "active", "deleting"].includes(body.status) && !body.ready; }
function exit(body) { return ["deleted", "refused"].includes(body.status) ? 4 : body.status === "searching" ? 7 : pending(body) ? 6 : 0; }
function catalog(value) {
  if (!exact(value, ["gpus", "disk_month_microusd", "month_seconds", "message"]) || value.message !== CATALOG ||
      !amount(value.disk_month_microusd) || !amount(value.month_seconds) || value.month_seconds === 0 ||
      !Array.isArray(value.gpus) || value.gpus.length > 2000 || !value.gpus.every(g => exact(g, ["gpu", "cloud", "max_count", "hour_microusd"]) &&
        text(g.gpu) && ["SECURE", "COMMUNITY"].includes(g.cloud) && amount(g.max_count) && g.max_count > 0 && amount(g.hour_microusd) && g.hour_microusd > 0) ||
      new Set(value.gpus.map(g => g.gpu + "/" + g.cloud)).size !== value.gpus.length || hasCredential(JSON.stringify(value))) throw new Error("invalid rental catalog");
  return value;
}
function catalogPlain(value) {
  const { money } = require("./call.js");
  return [...value.gpus.map(g => `gpu: ${g.gpu} · ${g.cloud} · ${money(g.hour_microusd)} per GPU-hour · max ${g.max_count}`), value.message];
}

module.exports = { WORDS, PRICE, validInputs, checked, plain, pending, exit, catalog, catalogPlain };
