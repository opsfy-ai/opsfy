"use strict";

const { err } = require("./output.js");

const API_BASE = (process.env.OPSFY_API_BASE || "https://opsfy.ai").replace(/\/+$/, "");
const ENDPOINTS = Object.freeze({
  catalog: `${API_BASE}/tools.json`,
  install: `${API_BASE}/api/install`,
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
  const body = Object.entries(fields)
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");

  if (process.env.OPSFY_DRY_RUN === "1") {
    err(`dry-run: ${method} ${url}${method === "POST" ? " " + body : ""}`);
    return method === "GET" ? null : true;
  }

  const headers = { accept: "application/json" };
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
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
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
