"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ENDPOINTS, validateBase, request } = require("./api.js");
const { installId } = require("./install-id.js");

async function report() {
  try {
    if (process.env.OPSFY_NO_COUNT === "1" || process.env.OPSFY_DRY_RUN === "1") return;
    validateBase();
    const home = path.resolve(process.env.OPSFY_HOME || path.join(os.homedir(), ".opsfy"));
    const marker = path.join(home, "first-run-sent");
    try { fs.lstatSync(marker); return; }
    catch (error) { if (error.code !== "ENOENT") return; }

    const id = installId();
    if (id === null) return;
    await request("POST", ENDPOINTS.firstRun, { install_id: id });

    const fd = fs.openSync(marker, "wx", 0o600);
    try {
      const bytes = Buffer.from("sent\n");
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) return;
        offset += written;
      }
    } finally { fs.closeSync(fd); }
  } catch {
    // A failed report or marker write must never affect the command.
  }
}

module.exports = { report };
