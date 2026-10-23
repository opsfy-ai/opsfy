"use strict";

// Numeric tokens are private in-memory values. Only stringify emits their wire
// representation; ordinary input fields continue to use JavaScript numbers.
function JSONNumber(token) { this.token = token; }

function unique(source) {
  const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  let at = 0;
  const walk = () => {
    const token = tokens[at++];
    if (token === "{") {
      const names = new Set();
      if (tokens[at] === "}") { at++; return; }
      for (;;) {
        const name = JSON.parse(tokens[at++]);
        if (names.has(name)) throw new Error("duplicate JSON key");
        names.add(name); at++; walk();
        if (tokens[at++] === "}") break;
      }
    } else if (token === "[") {
      if (tokens[at] === "]") { at++; return; }
      for (;;) { walk(); if (tokens[at++] === "]") break; }
    }
  };
  walk();
}

function numbers(value, tokens) {
  if (typeof value === "number") return new JSONNumber(tokens);
  if (Array.isArray(value)) return value.map((v, i) => numbers(v, tokens[i]));
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.keys(value).map(k => [k, numbers(value[k], tokens[k])]));
  return value;
}

function parse(source) {
  const body = JSON.parse(source);
  unique(source);
  const tokens = JSON.parse(source.replace(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => token.startsWith('"') ? token : JSON.stringify(token)));
  return numbers(body, tokens);
}

function hasNumbers(value) {
  return value instanceof JSONNumber || value !== null && typeof value === "object" && Object.values(value).some(hasNumbers);
}

function stringify(value) {
  if (!hasNumbers(value)) return JSON.stringify(value);
  return wire(value);
}

function wire(value) {
  if (value instanceof JSONNumber) {
    if (!/^-?(0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.token)) throw new Error("invalid JSON number");
    return value.token;
  }
  if (Array.isArray(value)) return "[" + value.map(v => wire(v) ?? "null").join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value)
    .filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ":" + wire(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

function credential(text, credentials = []) {
  for (;;) {
    if (/opsfy_sk_[0-9a-f]{64}|sk-or-v1-[A-Za-z0-9_-]+/i.test(text) ||
        credentials.some(key => key && text.includes(key))) return true;
    const decoded = text.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === text) return false;
    text = decoded;
  }
}

function valid(value, maxBytes, maxDepth, credentials = [], controls = false) {
  try {
    const text = s => (controls || !/[\p{Cc}\p{Cs}]/u.test(s.replace(/[\t\r\n]/g, ""))) && !credential(s, credentials);
    const walk = (v, depth) => {
      if (v instanceof JSONNumber) return true;
      if (typeof v === "string") return text(v);
      if (v === null || typeof v === "boolean") return true;
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v !== "object" || depth >= maxDepth) return false;
      return Array.isArray(v) ? v.every(x => walk(x, depth + 1)) :
        Object.entries(v).every(([k, x]) => !["__proto__", "constructor", "prototype"].includes(k) &&
          text(k) && walk(x, depth + 1));
    };
    return walk(value, 0) && Buffer.byteLength(stringify(value), "utf8") <= maxBytes;
  } catch { return false; }
}

module.exports = { JSONNumber, parse, stringify, valid, credential };
