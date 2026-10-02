"use strict";

const { spawn } = require("node:child_process");
const { validPaymentURL } = require("./wallet.js");

async function open(url) {
  if (!validPaymentURL(url, [process.env.OPSFY_API_KEY])) return false;
  const platform = process.platform;
  let program, args;
  const options = { stdio: "ignore", windowsHide: true, shell: false,
    windowsVerbatimArguments: platform === "win32" };
  if (platform === "darwin") {
    program = "open";
    args = [url];
  } else if (platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    program = "xdg-open";
    args = [url];
  } else if (platform === "win32") {
    program = "cmd";
    args = ["/d", "/v:off", "/s", "/c", 'start "" "%OPSFY_TOPUP_URL%"'];
    options.env = { ...process.env, OPSFY_TOPUP_URL: url };
    delete options.env.OPSFY_API_KEY;
  } else return false;

  return new Promise(resolve => {
    let child, timer, done = false;
    const finish = success => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(success);
    };
    timer = setTimeout(() => {
      finish(false);
      try { child?.kill(); } catch {}
    }, 2000);
    try {
      child = spawn(program, args, options);
      child.once("error", () => finish(false));
      child.once("close", code => finish(code === 0));
    } catch { finish(false); }
  });
}

module.exports = { open };
