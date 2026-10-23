"use strict";

const fs = require("node:fs");
const tools = require("./tool-data.json");
const jsonValues = require("./json-values.js");
const LIMIT = 16384;
const UNREADABLE = "the input is not one JSON object of at most 16,384 bytes · fix it, then run the call again";
const CHAT_UNREADABLE = "the input is not one UTF-8 JSON object of at most 1,048,576 bytes · fix input.json, then run opsfy call openrouter --input-file input.json --json";
const byteLimit = tool => (tool?.chat || tool?.json || tool?.binary) ? 1048576 : LIMIT;
const unreadableWords = tool => tool?.binary ? "the input is not one UTF-8 JSON object of at most 1,048,576 bytes · fix input.json, then run the call with --input-file input.json --out <new-file.mp3> --json" : tool?.json ? CHAT_UNREADABLE.replace("openrouter", tool.slug) : tool?.chat ? CHAT_UNREADABLE : UNREADABLE;

class InputRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 2; }
}

function invalidMessage(tool) {
  const facts = tool.job && !tool.chat && !tool.json && !tool.binary && !tool.rental ?
    " · " + tool.inputs.map(input => `${input.name}: ${input.description}`).join(" ") : "";
  return `the inputs do not match ${tool.slug}'s; it takes: ${tool.inputs.map(input => input.name).join(", ")}${facts} · run opsfy info ${tool.slug} for each input's type and limits`;
}
function invalid(tool) { throw new InputRefusal("invalid_input", invalidMessage(tool)); }
function unreadable(tool) { throw new InputRefusal("input_unreadable", unreadableWords(tool)); }
function usage(tool) {
  throw new InputRefusal("usage", tool.main_input === null ?
    `usage: opsfy call ${tool.slug} --input <name>=<value> [--json]` :
    `no ${tool.main_input} given · run opsfy call ${tool.slug} "<${tool.main_input}>"`);
}
function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
}
function slug(value) { return typeof value === "string" && /^[a-z0-9-]{1,60}$/.test(value); }
function field(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(value) && !["constructor", "prototype"].includes(value);
}
function text(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function dollars(value) {
  if (typeof value !== "string" || value.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split("."), micro = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return micro > 0n && (micro * 6n + 4n) / 5n <= BigInt(Number.MAX_SAFE_INTEGER);
}

function validValue(input, value, chat = false) {
  if (input.type === "dollars") return dollars(value);
  if (input.type === "json") return jsonValues.valid(value, input.max_bytes, input.max_depth);
  if (input.type === "string") return (chat || input.multiline) ? typeof value === "string" && value.trim().length > 0 && [...value].length <= input.max_length &&
    !/[\p{Cc}\p{Cs}]/u.test(value.replace(/[\t\r\n]/g, "")) : text(value, input.max_length);
  if (input.type === "integer") return Number.isSafeInteger(value) && value >= input.minimum && value <= input.maximum;
  return input.type === "boolean" && typeof value === "boolean";
}

function publicDescriptor(value, expectedSlug) {
  if (!exact(value, ["slug", "name", "line", "unit", "main_input", "inputs", "results", ...["chat", "json", "wait", "binary", "rental", "usd"].filter(k => value && Object.hasOwn(value, k)), ...(value && Object.hasOwn(value, "job") ? ["job"] : [])]) || !slug(value.slug) || value.slug !== expectedSlug ||
      !text(value.name, 80) || !text(value.line, 160) || !text(value.unit, 40) ||
      !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 16) return false;
  if (Object.hasOwn(value, "binary") && (!exact(value.binary, ["media_type", "extension"]) ||
      typeof value.binary.media_type !== "string" || value.binary.media_type.length > 100 ||
      !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value.binary.media_type) ||
      typeof value.binary.extension !== "string" || !/^\.[A-Za-z0-9]{1,16}$/.test(value.binary.extension) ||
      !value.job || value.job.stoppable !== false || value.job.retention_seconds !== null)) return false;
  if (Object.hasOwn(value, "json") && value.json !== true) return false;
  if (Object.hasOwn(value, "usd") && (value.usd !== true || !value.inputs.some(input => input.type === "dollars"))) return false;
  if (Object.hasOwn(value, "rental") && (value.rental !== true || !value.job || value.job.stoppable !== true || value.job.retention_seconds !== null || value.chat || value.json || value.wait || value.binary)) return false;
  if (Object.hasOwn(value, "wait") && (value.wait !== true || !value.json || value.slug !== "jev" || !value.job || value.job.stoppable || value.job.retention_seconds !== null)) return false;
  if (Object.hasOwn(value, "chat") && (value.chat !== true || value.slug !== "openrouter" || !value.job || value.job.stoppable !== false || value.job.retention_seconds !== null)) return false;
  if (Object.hasOwn(value, "job") && (!exact(value.job, ["stoppable", "retention_seconds"]) || typeof value.job.stoppable !== "boolean" ||
      !(value.job.retention_seconds === null || Number.isInteger(value.job.retention_seconds) && value.job.retention_seconds >= 1 && value.job.retention_seconds <= 31536000))) return false;
  const names = new Set();
  for (const input of value.inputs) {
    if (!input || !["string", "integer", "boolean", "json", "dollars"].includes(input.type)) return false;
    const fields = ["name", "type", "required", "description", "example"];
    if (input.type === "string") fields.push("max_length", ...(Object.hasOwn(input, "multiline") ? ["multiline"] : []));
    if (input.type === "json") fields.push("max_bytes", "max_depth");
    if (input.type === "integer") fields.push("minimum", "maximum");
    if (value.job && input.type === "integer" && Object.hasOwn(input, "default")) fields.push("default");
    if (!exact(input, fields) || !field(input.name) || names.has(input.name) || typeof input.required !== "boolean" || !text(input.description, 160)) return false;
    names.add(input.name);
    if (input.type === "string" && (!Number.isSafeInteger(input.max_length) || input.max_length < 1 || input.max_length > (value.chat || input.multiline ? 131072 : 2000))) return false;
    if (Object.hasOwn(input, "multiline") && input.multiline !== true) return false;
    if (input.type === "json" && (!(value.json || value.rental) || !Number.isSafeInteger(input.max_bytes) || input.max_bytes < 1 || input.max_bytes > 65536 ||
        !Number.isSafeInteger(input.max_depth) || input.max_depth < 1 || input.max_depth > 16)) return false;
    if (input.type === "integer" && (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || input.minimum > input.maximum)) return false;
    if (input.type === "dollars" && !value.usd || !validValue(input, input.example, value.chat)) return false;
    if (Object.hasOwn(input, "default") && (input.required || !validValue(input, input.default, value.chat))) return false;
  }
  return (value.main_input === null || value.inputs.some(input => input.name === value.main_input && input.required && input.type === "string")) &&
    (value.results?.rows ? value.json === true && exact(value.results, ["rows", "max_results", "max_bytes", "max_depth"]) &&
      value.results.rows === true && Number.isInteger(value.results.max_results) && value.results.max_results >= 1 && value.results.max_results <= 50 &&
      Number.isInteger(value.results.max_bytes) && value.results.max_bytes >= 1 && value.results.max_bytes <= 262144 &&
      Number.isInteger(value.results.max_depth) && value.results.max_depth >= 1 && value.results.max_depth <= 16 :
    value.results?.object ? value.json === true && exact(value.results, ["object", "max_bytes", "max_depth"]) && value.results.object === true &&
      Number.isSafeInteger(value.results.max_bytes) && value.results.max_bytes >= 1 && value.results.max_bytes <= 262144 &&
      Number.isSafeInteger(value.results.max_depth) && value.results.max_depth >= 1 && value.results.max_depth <= 16 :
    exact(value.results, ["fields", "max_results"]) && Array.isArray(value.results.fields) &&
    value.results.fields.length >= 1 && value.results.fields.length <= 8 && value.results.fields.every(field) &&
    new Set(value.results.fields).size === value.results.fields.length && Number.isSafeInteger(value.results.max_results) &&
    value.results.max_results >= 1 && value.results.max_results <= 50);
}

// Parse first for JSON grammar, then walk tokens to reject duplicate decoded keys.
function objectJSON(bytes, tool) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) unreadable(tool);
    const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
    let at = 0;
    const walk = () => {
      const token = tokens[at++];
      if (token === "{") {
        const keys = new Set();
        if (tokens[at] === "}") { at++; return; }
        for (;;) {
          const key = JSON.parse(tokens[at++]);
          if (keys.has(key)) unreadable(tool);
          keys.add(key);
          at++; // colon; JSON.parse has already checked the syntax.
          walk();
          if (tokens[at++] === "}") break;
        }
      } else if (token === "[") {
        if (tokens[at] === "]") { at++; return; }
        for (;;) { walk(); if (tokens[at++] === "]") break; }
      }
    };
    walk();
    if (tool?.json) {
      const lexical = jsonValues.parse(source);
      for (const input of tool.inputs) if (input.type === "json" && Object.hasOwn(value, input.name)) value[input.name] = lexical[input.name];
    }
    return value;
  } catch { unreadable(tool); }
}

function fileBytes(filename, tool) {
  let fd;
  try {
    fd = fs.openSync(filename, "r");
    if (!fs.fstatSync(fd).isFile()) unreadable(tool);
    const bytes = Buffer.alloc(byteLimit(tool) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > byteLimit(tool)) unreadable(tool);
    return bytes.subarray(0, length);
  } catch { unreadable(tool); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function stdinBytes(tool) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const stop = (error) => {
      clearTimeout(timer);
      process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end);
      process.stdin.removeListener("error", stop);
      process.stdin.pause();
      if (error) reject(failure()); else resolve(Buffer.concat(chunks, length));
    };
    const failure = () => new InputRefusal("input_unreadable", unreadableWords(tool));
    const data = chunk => { length += chunk.length; if (length > byteLimit(tool)) stop(failure()); else chunks.push(chunk); };
    const end = () => stop();
    const timer = setTimeout(() => stop(failure()), 5000);
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", stop);
  });
}

async function parse(tool, args) {
  if (args[0].toLowerCase() !== tool.slug) usage(tool);
  const rest = args.slice(1), named = rest.includes("--input"), file = rest.includes("--input-file");
  if (tool.slug === "tavily-research" && rest[0]?.startsWith("--") && !["--input", "--input-file"].includes(rest[0]))
    throw new InputRefusal("invalid_input", "a question that starts with -- must be passed as --input question=...");
  let values, short = false;
  if (named && file) invalid(tool);
  if (file) {
    if (rest.length !== 2 || rest[0] !== "--input-file" || !rest[1] || rest[1].startsWith("--")) invalid(tool);
    values = objectJSON(rest[1] === "-" ? await stdinBytes(tool) : fileBytes(rest[1], tool), tool);
  } else if (named) {
    values = Object.create(null);
    let start = 0;
    if (rest[0] !== "--input") {
      if (tool.main_input === null || rest[0].startsWith("--")) invalid(tool);
      values[tool.main_input] = rest[0];
      start = 1;
    }
    for (let at = start; at < rest.length; at += 2) {
      const token = rest[at + 1];
      if (rest[at] !== "--input" || typeof token !== "string" || !token.includes("=")) invalid(tool);
      const split = token.indexOf("="), name = token.slice(0, split), raw = token.slice(split + 1);
      const input = tool.inputs.find(input => input.name === name);
      if (!input && tool.slug === "apify") throw new InputRefusal("apify_input", require("./call.js").APIFY_WORDS.apify_input);
      if (!input || Object.hasOwn(values, name)) invalid(tool);
      let value = raw;
      if (input.type === "integer") {
        if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) invalid(tool);
        value = Number(raw);
      } else if (input.type === "json") {
        try { value = tool.rental && name === "ports" && !raw.startsWith("[") ? raw.split(",") : jsonValues.parse(raw); } catch { unreadable(tool); }
      } else if (input.type === "boolean") {
        if (!["true", "false"].includes(raw)) invalid(tool);
        value = raw === "true";
      }
      values[name] = value;
    }
  } else {
    if (tool.main_input === null || rest.length !== 1) usage(tool);
    if (!rest[0].trim()) { if (tool.legacy_question) usage(tool); else invalid(tool); }
    short = true;
    values = { [tool.main_input]: rest[0] };
    const mainInput = tool.inputs.find(input => input.name === tool.main_input);
    if (tool.legacy_question && !validValue(mainInput, rest[0])) {
      const characters = [...rest[0]];
      throw new InputRefusal("invalid_question", characters.length > mainInput.max_length ?
        `the ${tool.main_input} has ${characters.length.toLocaleString("en-US")} characters; the most is ${mainInput.max_length.toLocaleString("en-US")} · shorten it, then run the call again` :
        `the ${tool.main_input} has a line break or a hidden character at character ${characters.findIndex(character => /[\p{Cc}\p{Cf}]/u.test(character)) + 1} · remove it, then run the call again`);
    }
  }
  if (tool.slug === "apify") {
    const words = require("./call.js").APIFY_WORDS;
    const refuse = code => { throw new InputRefusal(code, words[code]); };
    if (Object.keys(values).some(name => !["actor", "max_usd", "input"].includes(name))) refuse("apify_input");
    if (!Object.hasOwn(values, "max_usd")) throw new InputRefusal("unbounded_call",
      "the maximum charge needs max_usd, which was not given; nothing was charged · run the call again with --input max_usd=<value> (opsfy info apify --json lists its range)");
    if (!dollars(values.max_usd)) refuse("apify_dollars");
    if (typeof values.actor !== "string" || !/^(?:[A-Za-z0-9]{17}|[A-Za-z0-9][A-Za-z0-9_-]{0,99}[~/][A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.test(values.actor)) refuse("apify_actor");
    if (Object.hasOwn(values, "input") && (!values.input || typeof values.input !== "object" || Array.isArray(values.input) ||
        values.input instanceof jsonValues.JSONNumber || !jsonValues.valid(values.input, 65536, 16))) refuse("apify_input");
  }
  if (Object.keys(values).some(name => !tool.inputs.some(input => input.name === name)) ||
      !tool.inputs.every(input => Object.hasOwn(values, input.name) ? validValue(input, values[input.name], tool.chat) : !input.required)) invalid(tool);
  if (tool.rental && !require("./rentals.js").validInputs(values)) invalid(tool);
  if (tool.slug === "runpod-serverless" && !require("./serverless.js").validInputs(values)) invalid(tool);
  const body = short && tool.legacy_question ? { tool: tool.slug, question: values[tool.main_input] } : { tool: tool.slug, inputs: values };
  if (Buffer.byteLength(jsonValues.stringify(body), "utf8") > byteLimit(tool)) unreadable(tool);
  return body;
}

module.exports = { tools, InputRefusal, invalidMessage, exact, slug, publicDescriptor, parse };
