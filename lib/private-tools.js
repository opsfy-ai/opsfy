"use strict";

const { apiBase, validKey } = require("./auth.js").walletSupport;
const { savedKey, hasCredential, envelope } = require("./prices.js");
const { exact, publicDescriptor } = require("./tool-inputs.js");

// PROPOSED: owner approval of every new line is required before the later release.
const LINES = Object.freeze({
  list_heading: "private_tools: <N> tools · run opsfy info <tool> --json",
  list_item: "private_tool: <slug> · <name> · <price> a <unit> · run opsfy info <slug> --json",
  info: "private_tool: <slug> · <name> · <N> inputs · <price> a <unit> · run <next>",
  next_main: 'opsfy call <slug> --input <main_input>="<text>" --json',
  next_named: "opsfy call <slug> --input <name>=<value> --json",
  description: "description: <line>",
  main_input: "main_input: <json>",
  input: "input: <json>",
  results: "results: <json>",
  history: "call: <at> · call <id> · <slug> call · <outcome> · type personal · run opsfy logs --json",
});

function format(template, values) {
  return template.replace(/<([A-Za-z_]+)>/g, (placeholder, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
function line(name, values = {}) {
  if (values.usd && !values.metering) values = { ...values, metering: { model: "input_usd", rates: [], max_hold_microusd: null } };
  if ((values.chat || values.wait || values.rental || values.slug === "runpod-serverless") && !values.metering) values = { ...values, metering: { model: "dynamic", rates: [], max_hold_microusd: null } };
  // Load at rendering time: call.js also uses the personal history template.
  const template = values.metering ? LINES[name].replace("<price> a <unit>", "<quote>") : LINES[name];
  const fields = template.includes("<quote>") ? { ...values, quote: require("./prices.js").quote(values.metering, values.rental, values.slug === "runpod-serverless") } : template.includes("<price>") ?
    { ...values, price: require("./call.js").money(values.price_microusd) } : values;
  return format(template, fields);
}

function descriptor(value) {
  if (!exact(value, ["slug", "name", "line", "unit", "main_input", "inputs", "results", "tool_type", "price_microusd", ...["chat", "json", "wait", "binary", "rental", "usd"].filter(k => value && Object.hasOwn(value, k)), ...(value && Object.hasOwn(value, "job") ? ["job"] : [])]) ||
      value.tool_type !== "personal" || (value.chat || value.wait || value.rental || value.usd || value.slug === "runpod-serverless" ? value.price_microusd !== null : !Number.isSafeInteger(value.price_microusd) || value.price_microusd <= 0)) return false;
  const { tool_type, price_microusd, ...publicFields } = value;
  return publicDescriptor(publicFields, value.slug);
}

async function request(url, key, optionsMode = false) {
  const controller = new AbortController();
  let response, reader, timer, consumed = false;
  const abort = () => {
    controller.abort();
    if (reader) reader.cancel().catch(() => {});
    else { try { response?.body?.cancel().catch(() => {}); } catch {} }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { abort(); reject(new Error()); }, 5000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", authorization: "Bearer " + key, "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1", "Opsfy-Chat": "chat-v1", "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1", "Opsfy-Rentals": "rentals-v1", "Opsfy-Text": "text-v1", "Opsfy-USD": "usd-v1", "Opsfy-Serverless": "serverless-v1" } });
      if (controller.signal.aborted || response.status !== 200 || !envelope(response, url)) throw new Error();
      reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error();
        if (done) break;
        length += value.byteLength;
        if (length > 1048576) throw new Error();
        chunks.push(value);
      }
      consumed = true;
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
      if (optionsMode === "serverless") {
        if (!exact(body, ["ok", "tool", "catalog"]) || body.ok !== true || !descriptor(body.tool) || body.tool.slug !== "runpod-serverless" || hasCredential(JSON.stringify(body), [key])) throw new Error();
        return require("./serverless.js").catalog(body.catalog);
      }
      if (optionsMode === "rental") {
        if (!exact(body, ["ok", "tool", "catalog"]) || body.ok !== true || !descriptor(body.tool) || !body.tool.rental || hasCredential(JSON.stringify(body), [key])) throw new Error();
        return require("./rentals.js").catalog(body.catalog);
      }
      if (optionsMode) {
        const o = body?.options;
        if (!exact(body, ["ok", "options"]) || body.ok !== true || !exact(o, ["models", "voices"]) ||
            !Array.isArray(o.models) || !o.models.length || o.models.length > 100 || !Array.isArray(o.voices) || o.voices.length > 10000 ||
            !o.models.every(m => exact(m, ["id", "max_length", "default", "microusd", "units"]) &&
              typeof m.id === "string" && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(m.id) && typeof m.default === "boolean" &&
              [m.max_length, m.microusd, m.units].every(n => Number.isSafeInteger(n) && n > 0)) ||
            o.models.filter(m => m.default).length !== 1 || new Set(o.models.map(m => m.id)).size !== o.models.length ||
            !o.voices.every(v => exact(v, ["id", "category"]) && typeof v.id === "string" && /^[A-Za-z0-9]{20}$/.test(v.id) &&
              ["premade", "generated", "professional"].includes(v.category)) || new Set(o.voices.map(v => v.id)).size !== o.voices.length ||
            hasCredential(JSON.stringify(o), [key])) throw new Error();
        return o;
      }
      if (!exact(body, ["ok", "tools"]) || body.ok !== true || !Array.isArray(body.tools) ||
          !body.tools.every(descriptor) || new Set(body.tools.map(tool => tool.slug)).size !== body.tools.length ||
          hasCredential(JSON.stringify(body), [key])) throw new Error();
      return body.tools;
    })()]);
  } finally {
    clearTimeout(timer);
    if (!consumed) abort();
    try { reader?.releaseLock(); } catch {}
  }
}

async function load() {
  if (process.env.OPSFY_DRY_RUN === "1") return [];
  try {
    const environmentKey = process.env.OPSFY_API_KEY || "";
    if (environmentKey && !validKey(environmentKey)) return [];
    const key = environmentKey || savedKey();
    if (!key) return [];
    const url = apiBase() + "/api/tools";
    if (hasCredential(url, [key])) return [];
    return await request(url, key);
  } catch { return []; }
}

async function find(value) {
  const tools = await load(), query = value.toLowerCase();
  return tools.find(tool => tool.slug === query) || tools.find(tool => tool.name.toLowerCase() === query) || null;
}

async function options(tool) {
  const key = process.env.OPSFY_API_KEY || savedKey();
  if (!validKey(key)) throw new Error();
  const serverless = tool.slug === "runpod-serverless";
  return request(apiBase() + "/api/tools/" + tool.slug + (tool.rental || serverless ? "" : "/options"), key, serverless ? "serverless" : tool.rental ? "rental" : true);
}

function info(tool, metering, options) {
  const next = tool.binary ? `opsfy call ${tool.slug} --input text="<text>" --input voice=<id> --out voice.mp3 --json` : tool.json ? `opsfy call ${tool.slug} --input-file input.json --json` : tool.chat ? 'opsfy call openrouter --input model=<model> --input prompt="<text>" --json' :
    tool.job && !tool.rental ? `opsfy call ${tool.slug}` + tool.inputs.filter(input => input.required).map(input =>
      ` --input ${input.name}=${JSON.stringify(tool.slug === "tavily-research" && input.name === "question" ? "<question>" : input.example)}`).join("") + " --json" :
    line(tool.main_input === null ? "next_named" : "next_main", { slug: tool.slug, main_input: tool.main_input });
  const message = line("info", { ...tool, N: tool.inputs.length, next, metering });
  return { result: { ...tool, group: "Private tools", message, ...(metering ? { metering } : {}), ...(options ? tool.rental || tool.slug === "runpod-serverless" ? { catalog: options } : { options } : {}) },
    text: [message, line("description", tool), line("main_input", { json: JSON.stringify(tool.main_input) }),
      ...tool.inputs.map(input => line("input", { json: JSON.stringify(input) })),
      line("results", { json: JSON.stringify(tool.results) }), ...(options ? tool.slug === "runpod-serverless" ? require("./serverless.js").catalogPlain(options) : tool.rental ? require("./rentals.js").catalogPlain(options) : ["options: " + JSON.stringify(options)] : [])].join("\n") };
}

module.exports = { load, find, line, info, options };
