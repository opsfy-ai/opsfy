"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function stat(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readId(home, filename) {
  if (!fs.lstatSync(home).isDirectory()) return null;
  const existing = fs.lstatSync(filename);
  if (!existing.isFile() || existing.size !== 33) return null;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const content = fs.readFileSync(fd, "utf8");
    return content.length === 33 && /^[0-9a-f]{32}\n$/.test(content) ? content.slice(0, -1) : null;
  } finally { fs.closeSync(fd); }
}

function installId() {
  let temporary, fd, created = false;
  try {
    const home = path.resolve(process.env.OPSFY_HOME || path.join(os.homedir(), ".opsfy"));
    let directory = stat(home);
    if (!directory) {
      try { fs.mkdirSync(home, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      directory = fs.lstatSync(home);
    }
    if (!directory.isDirectory()) return null;

    const filename = path.join(home, "id");
    if (stat(filename)) return readId(home, filename);

    const id = crypto.randomBytes(16).toString("hex");
    temporary = path.join(home, ".id-" + crypto.randomBytes(8).toString("hex"));
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    const bytes = Buffer.from(id + "\n", "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) return null;
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try { fs.linkSync(temporary, filename); }
    catch (error) {
      if (error.code === "EEXIST") return readId(home, filename);
      throw error;
    }
    return id;
  } catch {
    // An unavailable or invalid id must never prevent an install count.
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Best effort after a write, sync or close failure. */ }
    }
    // Only remove the temporary file this call successfully created.
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* Later calls inspect only id. */ }
    }
  }
}

module.exports = { installId };
