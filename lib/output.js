"use strict";

const fs = require("node:fs");

function write(fd, value) {
  for (const line of String(value).split("\n")) {
    fs.writeSync(fd, line + "\n");
  }
}

function out(value = "") {
  write(1, value);
}

function err(value) {
  write(2, value);
}

function json(value) {
  // A proxy preserves ok first even when a catalogue has integer-index keys.
  const ordered = new Proxy(value, {
    ownKeys: target => ["ok", ...Object.keys(target).filter(key => key !== "ok")],
  });
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n", "utf8");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = fs.writeSync(1, bytes, offset, bytes.length - offset, null);
      offset += written;
      if (written === 0) Atomics.wait(pause, 0, 0, 1);
    } catch (error) {
      if (error.code === "EINTR") continue;
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

module.exports = { out, err, json };
