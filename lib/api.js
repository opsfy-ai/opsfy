"use strict";

const { err } = require("./output.js");
const { version } = require("../package.json");

const API_BASE = (process.env.OPSFY_API_BASE || "https://opsfy.ai").replace(/\/+$/, "");
const ENDPOINTS = Object.freeze({
  catalog: `${API_BASE}/tools.json`,
  install: `${API_BASE}/api/install`,
  pulled: `${API_BASE}/api/pulled`,
  key: `${API_BASE}/api/key`,
  tool: `${API_BASE}/api/tool`,
});

function validateBase() {
  try {
    const url = new URL(API_BASE);
    if (/^https?:\/\//i.test(API_BASE) && (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      return;
    }
  } catch {
    // Malformed URLs get the same refusal as disallowed protocols and hosts.
  }
  throw new Error(`OPSFY_API_BASE must be https, or http on localhost: ${process.env.OPSFY_API_BASE}`);
}

async function request(method, url, fields = {}) {
  const isPulled = method === "GET" && url === ENDPOINTS.pulled;
  const body = Object.entries(fields)
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");

  if (process.env.OPSFY_DRY_RUN === "1") {
    err(`dry-run: ${method} ${url}${method === "POST" ? " " + body : ""}`);
    if (isPulled) return { pulled: [] };
    return method === "GET" ? null : true;
  }

  const headers = { accept: "application/json", "user-agent": `opsfy/${version}` };
  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    options.body = body;
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    throw new Error(timedOut ? "timed out" : "network error");
  }
  if (!response.ok || (isPulled && response.status !== 200)) {
    throw new Error(`status ${response.status}`);
  }
  if (isPulled) {
    // The fetch signal's original deadline also covers the complete body.
    const list = await response.json();
    if (!list || typeof list !== "object" || Array.isArray(list) ||
      Object.keys(list).length !== 1 || !Object.hasOwn(list, "pulled") ||
      !Array.isArray(list.pulled) || !list.pulled.every((slug) =>
        typeof slug === "string" && slug.length >= 1 && slug.length <= 60 && !/[^a-z0-9-]/.test(slug))) {
      throw new Error("invalid pulled list");
    }
    return list;
  }
  return method === "GET" ? response.json() : true;
}

async function count(slug, ok) {
  if (process.env.OPSFY_NO_COUNT === "1") return;
  try {
    await request("POST", ENDPOINTS.install, { tool: slug, ok: ok ? "1" : "0" });
  } catch {
    // An unavailable count endpoint does not change an install's result.
  }
}

module.exports = { ENDPOINTS, validateBase, request, count };
