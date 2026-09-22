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

module.exports = { out, err };
