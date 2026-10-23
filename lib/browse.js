"use strict";

const { load, find } = require("./catalog.js");
const { apiBase } = require("./auth.js").walletSupport;
const { exact, slug, publicDescriptor } = require("./tool-inputs.js");
const { out } = require("./output.js");

const GROUPS = { paid: "Pay as you go", free: "One-command install", soon: "Self-serve" };
const STOPWORDS = new Set(["a", "an", "the", "to", "for", "with", "of", "and"]);
const UNAVAILABLE = "opsfy.ai did not send the tool's details · wait 60 seconds, then run the same command again";

function action(tool) {
  if (tool.bucket === "paid") return tool.call ? `open · opsfy call ${tool.slug}` : "not open yet";
  return tool.bucket === "free" ? `opsfy install ${tool.slug}` : `get it at ${tool.url}`;
}
function plainAction(tool, finding = false) {
  if (tool.bucket === "paid") {
    if (!tool.call) return "not open yet";
    const prefix = finding ? `open: run opsfy info ${tool.slug} --json, then ` : "run ";
    return `${prefix}opsfy call ${tool.slug} "<input>" --json`;
  }
  return tool.bucket === "free" ? `run opsfy install ${tool.slug} --json` : `the person gets it at ${tool.url}`;
}
function words(value) {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word && !STOPWORDS.has(word)));
}
function price(value) {
  const amount = BigInt(value), decimals = amount % 100n === 0n ? 4 : 6;
  return "$" + amount / 1000000n + "." + String(amount % 1000000n).padStart(6, "0").slice(0, decimals);
}
function infoFailure(answer) { answer.failure("info_unavailable", UNAVAILABLE); return 1; }

async function getMetadata(name) {
  if (!slug(name)) throw new Error();
  const url = apiBase() + "/api/tools/" + name;
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
        headers: { accept: "application/json", "Opsfy-Meter": "units-v1", "Opsfy-Jobs": "jobs-v1", "Opsfy-Chat": "chat-v1",
          "Opsfy-JSON": "json-v1", "Opsfy-Output": "binary-v1", "Opsfy-Rentals": "rentals-v1", "Opsfy-Text": "text-v1" } });
      if (controller.signal.aborted || response.status !== 200 || response.url !== url || response.redirected !== false ||
          response.headers.get("content-type") !== "application/json; charset=utf-8" || response.headers.get("cache-control") !== "no-store") throw new Error();
      for (const name of response.headers.keys()) {
        if (["cookie", "set-cookie", "set-cookie2", "location", "retry-after", "allow"].includes(name) || name.startsWith("access-control-allow-")) throw new Error();
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) throw new Error();
        chunks.push(value);
      }
      consumed = true;
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
      if (!exact(body, ["ok", "tool"]) || body.ok !== true || !publicDescriptor(body.tool, name)) throw new Error();
      return body.tool;
    })()]);
  } finally {
    clearTimeout(timer);
    if (!consumed) abort();
    try { reader?.releaseLock(); } catch {}
  }
}

async function run(command, args, answer) {
  if (command === "find") {
    const query = words(args.join(" "));
    if (!query.size) { answer.failure("usage", 'no words given · run opsfy find "<job>" --json'); return 2; }
    const catalog = await load();
    const matches = catalog.tools.map(tool => {
      const jobs = typeof tool.jobs === "string" ? tool.jobs : Array.isArray(tool.jobs) ? tool.jobs.filter(value => typeof value === "string").join(" ") : "";
      const fields = [[words(tool.name), 3], [words(tool.line), 2], [words(jobs), 1]];
      const score = [...query].reduce((score, word) => score + fields.reduce((total, [tokens, weight]) => total + (tokens.has(word) ? weight : 0), 0), 0);
      return { tool, score };
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score ||
      Number(b.tool.bucket === "paid" && !!b.tool.call) - Number(a.tool.bucket === "paid" && !!a.tool.call) ||
      (a.tool.slug < b.tool.slug ? -1 : a.tool.slug > b.tool.slug ? 1 : 0))
      .map(({ tool }) => tool);
    const message = 'no tool matches those words · run opsfy list --json for the whole library, or opsfy ask "<tool>" --json to ask for one';
    if (answer.json) answer.success({ ok: true,
      matches: matches.map(tool => ({ slug: tool.slug, name: tool.name, group: GROUPS[tool.bucket], action: action(tool) })),
      ...(!matches.length ? { message } : {}) });
    else out(matches.length ? matches.map(tool => `${tool.name} · ${GROUPS[tool.bucket]} · ${plainAction(tool, true)}`).join("\n") : message);
    return 0;
  }
  if (args.length !== 1) { answer.failure("usage", 'opsfy info takes one tool name · run opsfy info <tool> --json; opsfy find "<job>" --json gives the names'); return 2; }
  const tool = find(await load(), args[0]);
  if (!tool || !tool.call) {
    const privateTools = require("./private-tools.js"), descriptor = await privateTools.find(tool?.slug || args[0]);
    if (descriptor) {
      const prices = await require("./prices.js").load();
      let options;
      try { if (descriptor.binary || descriptor.rental || descriptor.slug === "runpod-serverless") options = await privateTools.options(descriptor); } catch { return infoFailure(answer); }
      const { result, text } = privateTools.info(descriptor, prices.metering?.[descriptor.slug], options);
      if (answer.json) answer.success({ ok: true, tool: result }); else out(text);
      return 0;
    }
  }
  if (!tool) {
    answer.failure("not_in_catalogue", `${args[0]} is not in opsfy's library · run opsfy find "<job>" --json for one that is, or opsfy ask ${args[0]} --json to ask for it`, { tool: args[0] }, out);
    return 2;
  }
  const result = { slug: tool.slug, name: tool.name, group: GROUPS[tool.bucket], action: action(tool), line: tool.line };
  const state = tool.bucket === "paid" ? (tool.call ? " · open" : " · not open yet") : "";
  const lines = [`${result.name} · ${result.group}${state}`, result.line, plainAction(tool)];
  if (tool.bucket === "paid" && tool.call) {
    let descriptor;
    try { descriptor = await getMetadata(tool.slug); } catch { return infoFailure(answer); }
    Object.assign(result, { inputs: descriptor.inputs, main_input: descriptor.main_input, results: descriptor.results, unit: descriptor.unit });
    if (descriptor.job) result.job = descriptor.job;
    const prices = await require("./prices.js").load();
    result.prices = prices.state === "shown" && !Object.hasOwn(prices.prices, tool.slug) ? "unavailable" : prices.state;
    if (result.prices === "shown") {
      result.price_microusd = prices.prices[tool.slug];
      if (prices.metering) result.metering = prices.metering[tool.slug];
    }
    for (const input of descriptor.inputs) {
      const type = input.type === "string" ? "text" : input.type;
      const limits = input.type === "string" ? ` · up to ${String(input.max_length).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} characters` :
        input.type === "integer" ? ` · ${input.minimum} to ${input.maximum}` : "";
      lines.push(`${input.name}: ${type} · ${input.required ? "required" : "optional"}${limits}${Object.hasOwn(input, "default") ? " · default: " + input.default : ""} · ${input.description} · example: ${JSON.stringify(input.example)}`);
    }
    lines.push(result.prices === "shown" ? (result.metering ? require("./prices.js").quote(result.metering) :
      `${price(result.price_microusd)} a ${descriptor.unit}, from the balance`) :
      result.prices === "login_required" ? "the price shows after login: run opsfy login --email <email> --json" :
        "the price could not be read · run the same command again in 60 seconds");
  }
  if (answer.json) answer.success({ ok: true, tool: result }); else out(lines.join("\n"));
  return 0;
}

module.exports = { run, getMetadata, infoFailure };
