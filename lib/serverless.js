"use strict";

const jsonValues = require("./json-values.js");
const WORDS = Object.freeze({
  "serverless_endpoint": "unknown endpoint; nothing was charged · run opsfy info runpod-serverless --json and choose an Opsfy endpoint name",
  "serverless_sleeping": "this endpoint is asleep; nothing was charged · ask the person to wake it, then run opsfy info runpod-serverless --json",
  "serverless_price": "the endpoint price or configuration could not be read safely; nothing was charged · run opsfy info runpod-serverless --json before trying again",
  "serverless_unavailable": "Runpod is not available right now; nothing was charged · ask the person to check Runpod availability before starting another job"
});
const PRICE = "price depends on the endpoint and seconds; the call holds the limit plus up to 420 seconds of waiting and 5 seconds after running, then charges reported use";
const RESULT_ERRORS = Object.freeze({
  "result_missing": "Runpod returned no output for this job; the charge stands",
  "result_malformed": "Runpod returned an invalid result; the charge stands",
  "result_too_large": "the output is over the relay's 262144-byte bound; the charge stands"
});

function validInputs(values) {
  const v = values.input;
  if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof jsonValues.JSONNumber) return false;
  const unsafe = v => typeof v === "string" ? /RUNPOD_SECRET_/i.test(v) :
    v && typeof v === "object" && !(v instanceof jsonValues.JSONNumber) ? Object.entries(v).some(([k, x]) =>
      ["policy", "webhook", "s3Config", "lowPriority"].includes(k) || unsafe(k) || unsafe(x)) : false;
  return !unsafe(v);
}
function catalog(value) {
  const exact = require("./tool-inputs.js").exact;
  if (!exact(value, ["endpoints"]) || !Array.isArray(value.endpoints) || value.endpoints.length > 1000 ||
      new Set(value.endpoints.map(e => e.name)).size !== value.endpoints.length ||
      !value.endpoints.every(e => exact(e, ["name", "model", "pool", "gpu_count", "hour_microusd"]) &&
        typeof e.name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.name) && e.name.length <= 60 &&
        [e.model, e.pool].every(v => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(v)) &&
        Number.isInteger(e.gpu_count) && e.gpu_count >= 1 && e.gpu_count <= 8 &&
        Number.isSafeInteger(e.hour_microusd) && e.hour_microusd > 0)) throw new Error("invalid endpoint catalog");
  return value;
}
function catalogPlain(value) {
  const money = require("./call.js").money;
  return value.endpoints.map(e => `${e.name} · ${e.model} · ${e.pool} · ${e.gpu_count} GPU · ${money(e.hour_microusd)} USD per hour`);
}
module.exports = { WORDS, PRICE, RESULT_ERRORS, validInputs, catalog, catalogPlain };
