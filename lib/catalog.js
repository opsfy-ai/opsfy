"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ENDPOINTS, request } = require("./api.js");

const BUCKETS = Object.freeze(["free", "paid", "soon"]);
const HEADINGS = Object.freeze({
  free: "Free · install now · opsfy install <app>",
  paid: "Paid · by waitlist · opsfy login --email you@example.com",
  soon: "Coming soon",
});
const DAY = 24 * 60 * 60 * 1000;

function validates(catalog) {
  return Boolean(
    catalog && typeof catalog === "object" && !Array.isArray(catalog) &&
    Array.isArray(catalog.tools) && catalog.tools.every((tool) =>
      tool && typeof tool === "object" && !Array.isArray(tool) &&
      typeof tool.slug === "string" &&
      tool.slug.match(/^[a-z0-9-]+$/)?.[0] === tool.slug &&
      ["name", "line", "url"].every((key) =>
        typeof tool[key] === "string" && !/[\x00-\x1f\x7f]/.test(tool[key])) &&
      BUCKETS.includes(tool.bucket))
  );
}

function readCatalog(filename) {
  try {
    const catalog = JSON.parse(fs.readFileSync(filename, "utf8"));
    return validates(catalog) ? catalog : null;
  } catch {
    return null;
  }
}

function cacheFetched(filename, catalog) {
  try {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(filename, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
  } catch {
    // A read-only cache must not hide a valid fetched catalogue.
  }
}

async function load() {
  if (process.env.OPSFY_CATALOG !== undefined) {
    const catalog = readCatalog(process.env.OPSFY_CATALOG);
    if (!catalog) throw new Error(`bad catalogue file: ${process.env.OPSFY_CATALOG}`);
    return catalog;
  }

  const home = process.env.OPSFY_HOME || path.join(os.homedir(), ".opsfy");
  const filename = path.join(home, "cache", "tools.json");
  const cached = readCatalog(filename);
  if (cached) {
    try {
      if (Date.now() - fs.statSync(filename).mtimeMs < DAY) return cached;
    } catch {
      // A cache that disappeared can still be used after a failed refresh.
    }
  }

  try {
    const catalog = await request("GET", process.env.OPSFY_CATALOG_URL || ENDPOINTS.catalog);
    if (validates(catalog)) {
      cacheFetched(filename, catalog);
      return catalog;
    }
  } catch {
    // Offline, invalid JSON and unsuccessful responses all use the fallback.
  }

  return cached || require("../catalog.json");
}

function find(catalog, value) {
  const query = value.toLowerCase();
  return catalog.tools.find((tool) => tool.slug === query) ||
    catalog.tools.find((tool) => tool.name.toLowerCase() === query) || null;
}

module.exports = { load, validates, find, BUCKETS, HEADINGS };
