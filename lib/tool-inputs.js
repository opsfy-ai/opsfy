"use strict";

const fs = require("node:fs");
const tools = require("./tool-data.json");
const LIMIT = 16384;
const UNREADABLE = "the input is not one JSON object of at most 16,384 bytes · fix it, then run the call again";

class InputRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 2; }
}

function invalidMessage(tool) {
  return `the inputs do not match ${tool.slug}'s; it takes: ${tool.inputs.map(input => input.name).join(", ")} · run opsfy info ${tool.slug} for each input's type and limits`;
}
function invalid(tool) { throw new InputRefusal("invalid_input", invalidMessage(tool)); }
function unreadable() { throw new InputRefusal("input_unreadable", UNREADABLE); }
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
function validValue(input, value) {
  if (input.type === "string") return text(value, input.max_length);
  if (input.type === "integer") return Number.isSafeInteger(value) && value >= input.minimum && value <= input.maximum;
  return input.type === "boolean" && typeof value === "boolean";
}

function publicDescriptor(value, expectedSlug) {
  if (!exact(value, ["slug", "name", "line", "unit", "main_input", "inputs", "results"]) || !slug(value.slug) || value.slug !== expectedSlug ||
      !text(value.name, 80) || !text(value.line, 160) || !text(value.unit, 40) ||
      !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 16) return false;
  const names = new Set();
  for (const input of value.inputs) {
    if (!input || !["string", "integer", "boolean"].includes(input.type)) return false;
    const fields = ["name", "type", "required", "description", "example"];
    if (input.type === "string") fields.push("max_length");
    if (input.type === "integer") fields.push("minimum", "maximum");
    if (!exact(input, fields) || !field(input.name) || names.has(input.name) || typeof input.required !== "boolean" || !text(input.description, 160)) return false;
    names.add(input.name);
    if (input.type === "string" && (!Number.isSafeInteger(input.max_length) || input.max_length < 1 || input.max_length > 2000)) return false;
    if (input.type === "integer" && (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || input.minimum > input.maximum)) return false;
    if (!validValue(input, input.example)) return false;
  }
  return (value.main_input === null || value.inputs.some(input => input.name === value.main_input && input.required && input.type === "string")) &&
    exact(value.results, ["fields", "max_results"]) && Array.isArray(value.results.fields) &&
    value.results.fields.length >= 1 && value.results.fields.length <= 8 && value.results.fields.every(field) &&
    new Set(value.results.fields).size === value.results.fields.length && Number.isSafeInteger(value.results.max_results) &&
    value.results.max_results >= 1 && value.results.max_results <= 50;
}

// Parse first for JSON grammar, then walk tokens to reject duplicate decoded keys.
function objectJSON(bytes) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) unreadable();
    const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
    let at = 0;
    const walk = () => {
      const token = tokens[at++];
      if (token === "{") {
        const keys = new Set();
        if (tokens[at] === "}") { at++; return; }
        for (;;) {
          const key = JSON.parse(tokens[at++]);
          if (keys.has(key)) unreadable();
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
    return value;
  } catch { unreadable(); }
}

function fileBytes(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, "r");
    if (!fs.fstatSync(fd).isFile()) unreadable();
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > LIMIT) unreadable();
    return bytes.subarray(0, length);
  } catch { unreadable(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function stdinBytes() {
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
    const failure = () => new InputRefusal("input_unreadable", UNREADABLE);
    const data = chunk => { length += chunk.length; if (length > LIMIT) stop(failure()); else chunks.push(chunk); };
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
  let values, short = false;
  if (named && file) invalid(tool);
  if (file) {
    if (rest.length !== 2 || rest[0] !== "--input-file" || !rest[1] || rest[1].startsWith("--")) invalid(tool);
    values = objectJSON(rest[1] === "-" ? await stdinBytes() : fileBytes(rest[1]));
  } else if (named) {
    values = Object.create(null);
    for (let at = 0; at < rest.length; at += 2) {
      const token = rest[at + 1];
      if (rest[at] !== "--input" || typeof token !== "string" || !token.includes("=")) invalid(tool);
      const split = token.indexOf("="), name = token.slice(0, split), raw = token.slice(split + 1);
      const input = tool.inputs.find(input => input.name === name);
      if (!input || Object.hasOwn(values, name)) invalid(tool);
      let value = raw;
      if (input.type === "integer") {
        if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) invalid(tool);
        value = Number(raw);
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
  if (Object.keys(values).some(name => !tool.inputs.some(input => input.name === name)) ||
      !tool.inputs.every(input => Object.hasOwn(values, input.name) ? validValue(input, values[input.name]) : !input.required)) invalid(tool);
  const body = short && tool.legacy_question ? { tool: tool.slug, question: values[tool.main_input] } : { tool: tool.slug, inputs: values };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > LIMIT) unreadable();
  return body;
}

module.exports = { tools, InputRefusal, invalidMessage, exact, slug, publicDescriptor, parse };
