"use strict";

const { out, err, json } = require("./output.js");

// One instance belongs to one invocation. Plain failures lead with their stable code.
class Answer {
  constructor(enabled = false) {
    this.json = enabled;
    this.sent = false;
  }

  success(fields, message) {
    if (this.json) this.write({ ...fields, ok: true });
    else out(message);
  }

  failure(error, message, fields = {}, print = err) {
    if (this.json) this.write({ ok: false, error, message, ...fields });
    else print(message.startsWith(error + ":") ? message : `${error}: ${message}`);
  }

  write(value) {
    if (this.sent) return;
    this.sent = true;
    json(value);
  }
}

module.exports = { Answer };
