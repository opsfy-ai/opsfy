"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { out, err } = require("./output.js");
const { Answer } = require("./answer.js");

const WORDS = Object.freeze({
  emailPrompt: "Email:",
  sent: "login · code sent to <email>; it works for 10 minutes and 5 tries · ask the person for the 6-digit code, then run opsfy login --email <email> --code <code> --json",
  sentTerminal: "login · code sent to <email>; it works for 10 minutes and 5 tries",
  codePrompt: "Code:",
  login: "login · logged in as <email> · the key is saved in ~/.opsfy/",
  logout: "logout · logged out · the key no longer works",
  logoutRemoved: "logout · logged out · the key no longer works and is removed from this computer",
  logoutAll: "logout · every key on this account is stopped; the saved key is removed from this computer · run opsfy login --email <email> --json",
  rotate: "key · rotated · the new key is saved in ~/.opsfy/; the old one no longer works",
  missing: "no email given · ask the person for their email, then run opsfy login --email <email> --json",
  email: "that is not a valid email address · ask the person for their email again, then run opsfy login --email <email> --json",
  code: "a code is the 6 digits in the email opsfy.ai sent · ask the person for it, then run opsfy login --email <email> --code <code> --json",
  emailReask: "enter a valid email address",
  codeReask: "enter the six-digit code from your email",
  codeIncorrectReask: "the code does not match; each code allows 5 tries · type it again",
  code_invalid: "the code does not match the one sent to <email>; each code allows 5 tries · ask the person to check it, then run opsfy login --email <email> --code <code> --json",
  code_expired: "the code sent to <email> is older than 10 minutes · run opsfy login --email <email> --json for a new code, then ask the person for it",
  code_locked: "5 incorrect tries used up the code sent to <email> · run opsfy login --email <email> --json for a new code, then ask the person for it",
  rate_email: "3 codes went to <email> in the last hour, the most allowed · run opsfy login --email <email> --json again after <time>",
  rate_ip: "10 codes went out from this network in the last hour, the most allowed · run opsfy login --email <email> --json again after <time>",
  cancelled: "login stopped before it finished; the key on this computer is unchanged · run opsfy login --email <email> --json",
  otherAccount: "this computer is logged in as <email>; opsfy keeps one email at a time · ask the person whether to log out, then run opsfy logout --json and log in with the new email",
  pending: "an earlier login or key change for <email> did not finish, so the key is not confirmed · run opsfy login --email <email> --json, then ask the person for the new code",
  display: "key · logged in as <email> · key ending <last4> · from ~/.opsfy/",
  displayEnv: "key · logged in as <email> · key ending <last4> · from OPSFY_API_KEY",
  noKey: "no key on this computer, and OPSFY_API_KEY is not set · ask the person for their email, then run opsfy login --email <email> --json",
  invalidKey: "opsfy.ai no longer accepts this key · ask the person for their email, then run opsfy login --email <email> --json",
  revokedLogout: "the key had already stopped working, so it is removed from this computer · to log in again, run opsfy login --email <email> --json",
  revokedAll: "this key had already stopped working; it is removed from this computer, but stopping every account key was not confirmed · ask the person for their email, then run opsfy login --email <email> --json; once logged in, run opsfy logout --all --json",
  offlineLogout: "opsfy.ai could not be reached, so the key still works · run opsfy logout --json again once online",
  offlineAll: "opsfy.ai could not be reached; this command stopped no keys and kept the saved key · run opsfy logout --all --json again once online",
  env: "OPSFY_API_KEY is set; login and key rotate work only with the saved key · unset OPSFY_API_KEY, then run the same command again",
  envAll: "OPSFY_API_KEY is set; logout --all uses the saved account · unset OPSFY_API_KEY, then run opsfy logout --all --json",
  envInvalid: "OPSFY_API_KEY is not an opsfy key (opsfy_sk_ and 64 hex characters) · fix OPSFY_API_KEY or unset it, then run the same command again",
  envLogout: "OPSFY_API_KEY still holds the old key, which no longer works · unset OPSFY_API_KEY",
  unknown: "no clear answer came back from opsfy.ai · wait 60 seconds, then run the same command again",
  badFile: "opsfy could not read or write its files in ~/.opsfy/ · run the same command again; if it fails again, ask the person to email support@opsfy.ai",
  busy: "another opsfy command is using ~/.opsfy/ right now · wait for it to finish, then run the same command again",
  dry: "OPSFY_DRY_RUN=1 is set, so <command> does not run · unset OPSFY_DRY_RUN to run it",
  usage: "opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json",
  keyUsage: "opsfy key takes nothing, or rotate · run opsfy key --json or opsfy key rotate --json",
  logoutUsage: "opsfy logout takes --all or no option · run opsfy logout --json for this key, or opsfy logout --all --json for every key on the account",
  stale: "an earlier opsfy command stopped without releasing ~/.opsfy/auth-lock · if no opsfy command is running, delete that file, then run the same command again",
  base: "OPSFY_API_BASE must be https (or http on localhost) with no username, password, query or fragment · unset OPSFY_API_BASE to use https://opsfy.ai",
});

const ERROR_CODES = Object.freeze({
  usage: "usage", keyUsage: "usage", logoutUsage: "usage", base: "bad_api_base", dry: "dry_run",
  missing: "email_needed", email: "invalid_email", code: "invalid_code", code_invalid: "code_incorrect",
  code_expired: "code_expired", code_locked: "code_locked", rate_email: "rate_email", rate_ip: "rate_ip",
  otherAccount: "other_account", pending: "login_pending", env: "api_key_env_set", noKey: "not_logged_in",
  envInvalid: "api_key_env_set", envAll: "api_key_env_set",
  invalidKey: "key_not_working", revokedLogout: "key_removed", offlineLogout: "offline",
  revokedAll: "key_removed", offlineAll: "offline",
  unknown: "server_error", badFile: "key_files", busy: "busy", stale: "stale_lock", cancelled: "cancelled",
});

const errorCode = word => ERROR_CODES[word];

const EMAIL_WORDS = new Set(["sent", "sentTerminal", "login", "display", "displayEnv", "code", "code_invalid",
  "code_expired", "code_locked", "rate_email", "rate_ip", "otherAccount", "pending"]);

function line(name, values = {}) {
  return WORDS[name].replace(/<(email|last4|time|command)>/g, (placeholder, field) =>
    field === "email" && !EMAIL_WORDS.has(name) ? placeholder : values[field] ?? placeholder);
}

class Refusal extends Error {
  constructor(word, status = 1, values = {}) {
    super(word);
    this.word = word;
    this.status = status;
    this.values = values;
  }
}

function refuse(word, status = 1, values) {
  throw new Refusal(word, status, values);
}

const normalizeEmail = value => value.trim().toLowerCase();
const validEmail = value => typeof value === "string" && value.length <= 254 &&
  value === normalizeEmail(value) && !/[\p{Cc}\p{Cf}]/u.test(value) &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validKey = value => typeof value === "string" && value.length === 73 && /^opsfy_sk_[0-9a-f]{64}$/.test(value);
const validFingerprint = value => typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const fingerprint = key => crypto.createHash("sha256").update(key, "utf8").digest("hex");
const normalizeCode = value => value.trim().replace(/[ -]/g, "");
const validCode = value => value.length === 6 && /^[0-9]{6}$/.test(value);

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function parseArguments(command, args) {
  if (command === "logout") {
    if (args.length > 1 || (args.length && args[0] !== "--all")) refuse("logoutUsage", 2);
    return { all: args.length === 1 };
  }
  if (command === "key") {
    if (args.length > 1 || (args.length && args[0] !== "rotate")) refuse("keyUsage", 2);
    return { rotate: args.length === 1 };
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!["--email", "--code"].includes(flag) || Object.hasOwn(options, flag.slice(2))) refuse("usage", 2);
    const value = args[i + 1];
    if (value === undefined) refuse("usage", 2);
    // Valid values can start with hyphens; a flag in place of a value is still usage.
    if (value.startsWith("--") && !(flag === "--email" ? validEmail(normalizeEmail(value)) : validCode(normalizeCode(value)))) refuse("usage", 2);
    options[flag.slice(2)] = value;
  }
  if (options.code !== undefined && options.email === undefined) refuse("usage", 2);
  return options;
}

function apiBase() {
  const value = process.env.OPSFY_API_BASE || "https://opsfy.ai";
  try {
    if (/\s/.test(value) || !/^https?:\/\//i.test(value) || /[?#]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === "https:" || (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    refuse("base", 2);
  }
}

function stat(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function ensureDirectory(directory) {
  const existing = stat(directory);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) refuse("badFile");
    return;
  }
  const parent = path.dirname(directory);
  ensureDirectory(parent);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = stat(directory);
    if (!raced?.isDirectory() || raced.isSymbolicLink()) refuse("badFile");
  }
  // Persist the new parent entry before any work below the new directory.
  syncDirectory(parent);
  fs.chmodSync(directory, 0o700);
}

function writeAll(fd, content) {
  const bytes = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) refuse("badFile");
    offset += written;
  }
}

const AUTH_FILES = ["key", "prior", "account", "pending", "recovery", "auth-next", "auth-lock"];

class Store {
  constructor() {
    this.directory = path.resolve(process.env.OPSFY_HOME || path.join(os.homedir(), ".opsfy"));
    this.locked = false;
    this.cancelPrompt = null;
    this.signalHandlers = new Map();
  }

  file(name) { return path.join(this.directory, name); }

  prepare() {
    ensureDirectory(this.directory);
    fs.chmodSync(this.directory, 0o700);
    let unsafe = false;
    // Inspect only the named root files. In particular, never walk cache/.
    for (const name of AUTH_FILES) {
      const s = stat(this.file(name));
      if (!s) continue;
      if (!s.isFile() || s.isSymbolicLink()) unsafe = true;
      else fs.chmodSync(this.file(name), 0o600);
    }
    if (unsafe) refuse("badFile");
  }

  acquire() {
    let fd;
    try { fd = fs.openSync(this.file("auth-lock"), "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = fs.readFileSync(this.file("auth-lock"), "utf8");
      if (/^[1-9][0-9]*\n$/.test(holder) && holder.indexOf("\n") === holder.length - 1) {
        const pid = Number(holder.slice(0, -1));
        if (Number.isSafeInteger(pid) && pid <= 2147483647) {
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch { /* Not proof of a live holder. */ }
          if (alive) refuse("busy", 2);
        }
      }
      refuse("stale");
    }
    this.locked = true;
    // Register synchronously once this process owns the lock, before any await.
    for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
      const handler = () => {
        if (signal === "SIGINT" && this.cancelPrompt) {
          this.cancelPrompt();
          return;
        }
        try { this.cancelPrompt?.(); } catch { /* A hung-up terminal may be gone. */ }
        try { this.release(true); } catch { /* Keep the signal's exit status on cleanup failure. */ }
        // Exit synchronously so no awaiting request can resume and change auth state.
        process.exit(status);
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    try {
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, process.pid + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(this.directory);
  }

  release(interrupted = false) {
    if (!this.locked) return;
    try {
      // Normal failures may need a sync for an earlier rename/unlink. Signals only release the lock.
      if (!interrupted) syncDirectory(this.directory);
      this.remove("auth-lock");
    } finally {
      this.locked = false;
      // Keep the listeners through unlink and directory sync, including either failure.
      for (const [signal, handler] of this.signalHandlers) process.removeListener(signal, handler);
      this.signalHandlers.clear();
    }
  }

  read(name) {
    return stat(this.file(name)) ? fs.readFileSync(this.file(name), "utf8") : null;
  }

  replace(name, content) {
    const scratch = this.file("auth-next");
    const fd = fs.openSync(scratch, "wx", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(scratch, this.file(name));
    syncDirectory(this.directory);
  }

  json(name, value) { this.replace(name, JSON.stringify(value) + "\n"); }

  remove(name) {
    try { fs.unlinkSync(this.file(name)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    syncDirectory(this.directory);
  }

  load() {
    const readKey = name => {
      const value = this.read(name);
      if (value === null) return null;
      if (value.length !== 74 || !value.endsWith("\n") || !validKey(value.slice(0, -1))) refuse("badFile");
      return value.slice(0, -1);
    };
    const readJSON = name => {
      const value = this.read(name);
      if (value === null) return null;
      const parsed = JSON.parse(value);
      if (parsed === null) refuse("badFile");
      return parsed;
    };
    const key = readKey("key"), prior = readKey("prior");
    const account = readJSON("account"), pending = readJSON("pending");
    const recovery = this.read("recovery");
    // Validate the whole authoritative state before repairing any restart leftovers.
    if (account !== null && (!exactObject(account, ["email", "key_fingerprint"]) ||
        !validEmail(account.email) || !validFingerprint(account.key_fingerprint))) refuse("badFile");
    if (pending !== null && (!exactObject(pending, ["email", "candidates"]) ||
        !validEmail(pending.email) || !Array.isArray(pending.candidates) || !pending.candidates.length ||
        !pending.candidates.every(validKey) || new Set(pending.candidates).size !== pending.candidates.length)) refuse("badFile");
    if (recovery !== null && (!pending || recovery !== pending.email + "\n")) refuse("badFile");
    if (pending) {
      if (account && account.email !== pending.email) refuse("badFile");
      if (!key) {
        if (account || prior) refuse("badFile");
      } else if (pending.candidates.includes(key)) {
        // Key promotion precedes account replacement, including the first login.
        const possible = [...pending.candidates, ...(prior ? [prior] : [])];
        if (account ? !possible.some(raw => fingerprint(raw) === account.key_fingerprint) : prior !== null) refuse("badFile");
      } else if (prior !== key || !account || account.key_fingerprint !== fingerprint(key)) {
        refuse("badFile");
      }
    } else {
      if (key && (!account || account.key_fingerprint !== fingerprint(key))) refuse("badFile");
      if (prior && prior !== key) refuse("badFile");
    }
    this.remove("auth-next");
    if (!pending && prior) this.remove("prior");
    if (!key && !pending && account) this.remove("account");
    return { key, prior: pending ? prior : null, account: key ? account : null, pending, recovery };
  }

  promote(email, candidate) {
    this.replace("key", candidate + "\n");
    this.json("account", { email, key_fingerprint: fingerprint(candidate) });
    this.remove("prior");
    this.remove("recovery");
    this.remove("pending");
  }
}

const ROUTES = Object.freeze({ "login-code": "POST", login: "POST", session: "GET", logout: "POST", "key-rotate": "POST" });
const ERRORS = Object.freeze({
  method_not_allowed: [405, Object.keys(ROUTES)],
  invalid_request: [400, Object.keys(ROUTES)],
  unsupported_media_type: [415, ["login-code", "login", "logout", "key-rotate"]],
  body_too_large: [413, ["login-code", "login", "logout", "key-rotate"]],
  invalid_email: [400, ["login-code", "login"]],
  invalid_code: [400, ["login"]],
  invalid_fingerprint: [400, ["login", "key-rotate"]],
  invalid_key: [401, ["session", "logout", "key-rotate"]],
  code_invalid: [400, ["login"]],
  code_expired: [410, ["login"]],
  code_locked: [429, ["login"]],
  fingerprint_used: [409, ["login", "key-rotate"]],
  rate_email: [429, ["login-code"]],
  rate_ip: [429, ["login-code"]],
  send_failed: [503, ["login-code"]],
  storage_unavailable: [503, Object.keys(ROUTES)],
});
const CLEAR_REFUSALS = new Set(["code_invalid", "code_expired", "code_locked", "fingerprint_used",
  "invalid_email", "invalid_code", "invalid_fingerprint", "invalid_request", "method_not_allowed",
  "unsupported_media_type", "body_too_large"]);

function validateResponse(response, body, route, url, identity) {
  if (response.url !== url || response.redirected ||
      response.headers.get("content-type") !== "application/json; charset=utf-8" ||
      response.headers.get("cache-control") !== "no-store") return false;
  for (const name of response.headers.keys()) {
    if (["set-cookie", "set-cookie2", "cookie", "location"].includes(name) || name.startsWith("access-control-allow-")) return false;
  }
  let error = null;
  if (body?.ok === false) {
    if (!exactObject(body, ["ok", "error"]) || typeof body.error !== "string" || !Object.hasOwn(ERRORS, body.error)) return false;
    const [status, applicable] = ERRORS[body.error];
    if (response.status !== status || !applicable.includes(route)) return false;
    error = body.error;
  } else {
    if (body?.ok !== true || response.status !== (route === "login-code" ? 202 : 200)) return false;
    if (route === "login-code") {
      if (!exactObject(body, ["ok", "expires_in"]) || body.expires_in !== 600) return false;
    } else if (route === "logout") {
      if (!exactObject(body, ["ok"])) return false;
    } else if (!exactObject(body, ["ok", "email", "key_fingerprint"]) || !validEmail(body.email) ||
        !validFingerprint(body.key_fingerprint) || body.key_fingerprint !== identity.key_fingerprint ||
        (identity.email !== undefined && body.email !== identity.email)) return false;
  }
  const allow = response.headers.get("allow"), retry = response.headers.get("retry-after");
  if (error === "method_not_allowed" ? allow !== ROUTES[route] : allow !== null) return false;
  if (error === "send_failed") { if (retry !== "60") return false; }
  else if (error === "rate_email" || error === "rate_ip") {
    if (retry === null || !/^[1-9][0-9]*$/.test(retry)) return false;
  } else if (retry !== null) return false;
  return true;
}

function neverSent(error) {
  return error instanceof TypeError && (
    (["ENOTFOUND", "EAI_AGAIN"].includes(error.cause?.code) && error.cause?.syscall === "getaddrinfo") ||
    (error.cause?.code === "ECONNREFUSED" && error.cause?.syscall === "connect"));
}

async function request(base, route, fields = {}, bearer, identity = {}) {
  const url = base + "/api/" + route;
  const controller = new AbortController();
  const options = { method: ROUTES[route], headers: { accept: "application/json" }, redirect: "error", signal: controller.signal };
  if (bearer) options.headers.authorization = "Bearer " + bearer;
  if (options.method === "POST") {
    options.headers["content-type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(fields).toString();
  }
  let received = false, timer;
  const unknown = { kind: "unknown", neverSent: false };
  // A new deadline for this request covers both fetch and the complete response body.
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(unknown); }, 10000);
  });
  try {
    const response = await Promise.race([deadline, (async () => {
      const response = await fetch(url, options);
      received = true;
      const body = JSON.parse(await response.text());
      if (controller.signal.aborted || !validateResponse(response, body, route, url, identity)) return unknown;
      return body.ok ? { kind: "success", body }
        : { kind: "error", error: body.error, retryAfter: response.headers.get("retry-after") };
    })()]);
    return response;
  } catch (error) {
    return { kind: "unknown", neverSent: !received && !controller.signal.aborted && neverSent(error) };
  } finally { clearTimeout(timer); }
}

function remoteWord(result) {
  const names = { invalid_email: "email", invalid_code: "code", invalid_key: "invalidKey",
    code_invalid: "code_invalid", code_expired: "code_expired", code_locked: "code_locked",
    rate_email: "rate_email", rate_ip: "rate_ip" };
  return result.kind === "error" && Object.hasOwn(names, result.error) ? names[result.error] : "unknown";
}

function prompt(store, label) {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    const wasRaw = !!input.isRaw;
    const decoder = new StringDecoder("utf8");
    let text = "", done = false, sequence = "";
    let echo = label === "emailPrompt";
    const writeTerminal = value => {
      if (!echo) return;
      try { writeAll(0, value); }
      catch { echo = false; } // A read-only or hung-up terminal must not stop input.
    };
    const finish = (cancelled = false) => {
      if (done) return;
      done = true;
      store.cancelPrompt = null;
      if (text) writeTerminal("\n");
      input.pause();
      input.removeListener("data", data);
      input.removeListener("end", cancel);
      input.removeListener("error", cancel);
      try { input.setRawMode(wasRaw); }
      catch { reject(new Refusal("cancelled")); return; }
      if (cancelled) reject(new Refusal("cancelled"));
      else resolve(text);
    };
    const cancel = () => finish(true);
    const data = chunk => {
      for (const character of decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        // Retain sequence state across reads; an invalid continuation is handled normally below.
        if (sequence === "escape") {
          sequence = "";
          if (character === "[") { sequence = "csi"; continue; }
          if (character === "O") { sequence = "ss3"; continue; }
        } else if (sequence === "csi") {
          if (character >= "\x20" && character <= "\x3f") continue;
          sequence = "";
          if (character >= "\x40" && character <= "\x7e") continue;
        } else if (sequence === "ss3") {
          sequence = "";
          if (character >= "\x20" && character <= "\x7e") continue;
        }
        if (character === "\x1b") { sequence = "escape"; continue; }
        if (character === "\x03" || character === "\x04") { cancel(); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\x7f" || character === "\b") {
          if (text) {
            text = Array.from(text).slice(0, -1).join("");
            writeTerminal("\r" + text + "\x1b[K");
          }
        } else if (character >= "\x20") {
          text += character;
          writeTerminal(character);
        }
      }
    };
    try {
      // Echo must already be disabled when the prompt becomes visible.
      input.setRawMode(true);
      input.on("data", data);
      input.once("end", cancel);
      input.once("error", cancel);
      store.cancelPrompt = cancel;
      out(WORDS[label]);
      input.resume();
    } catch { cancel(); }
  });
}

function loginAllowed(state, email, environmentKey) {
  if (state.pending && state.pending.email !== email) refuse("pending", 2, { email: state.pending.email });
  if (environmentKey) refuse("env", 2);
  if (!state.pending && state.account && state.account.email !== email) refuse("otherAccount", 2, state.account);
}

async function mutate(store, state, base, email, code, rotating = false) {
  const earlier = state.pending;
  const marker = state.recovery;
  if (earlier && !marker) refuse("pending", 2, { email: earlier.email });
  const fields = rotating ? { key_fingerprint: "0".repeat(64) }
    : { email, code, key_fingerprint: "0".repeat(64) };
  if (!rotating) {
    const replacements = [...new Set([state.prior, state.key, ...(earlier?.candidates || [])]
      .filter(Boolean).map(fingerprint))];
    if (replacements.length) fields.replace_fingerprints = JSON.stringify(replacements);
    // Refuse before any journal write; recovery must keep every earlier candidate.
    if (Buffer.byteLength(new URLSearchParams(fields).toString(), "utf8") > 4096) refuse("badFile");
  }
  if (!earlier && state.key) store.replace("prior", state.key + "\n");
  const candidate = "opsfy_sk_" + crypto.randomBytes(32).toString("hex");
  const journal = { email, candidates: [...(earlier?.candidates || []), candidate] };
  store.json("pending", journal);
  store.remove("recovery");
  const hash = fingerprint(candidate);
  fields.key_fingerprint = hash;
  const result = await request(base, rotating ? "key-rotate" : "login", fields,
    rotating ? state.key : undefined, { email, key_fingerprint: hash });
  if (result.kind === "success") {
    store.promote(email, candidate);
  } else if (result.kind === "error" && CLEAR_REFUSALS.has(result.error)) {
    if (earlier) {
      store.json("pending", earlier);
      if (marker) store.replace("recovery", marker);
    } else {
      // Preserve a valid restart state after every individual durable deletion.
      store.remove("recovery");
      store.remove("pending");
      store.remove("prior");
    }
  }
  // Unknown outcomes (including exact storage errors and rotation 401) retain all candidates.
  return result;
}

async function login(store, state, base, options, environmentKey) {
  let email = options.email === undefined ? undefined : normalizeEmail(options.email);
  const emailPrompt = email === undefined;
  const codePrompt = !options.json && options.code === undefined && !!process.stdin.isTTY;
  while (true) {
    if (emailPrompt) email = normalizeEmail(await prompt(store, "emailPrompt"));
    if (emailPrompt && !validEmail(email)) {
      err(WORDS.emailReask);
      continue;
    }
    loginAllowed(state, email, environmentKey);
    if (!validEmail(email)) refuse("email", 2);
    if (options.code !== undefined) break;
    // A replacement admission invalidates the older recovery permission even if it fails.
    store.remove("recovery");
    state.recovery = null;
    const admission = await request(base, "login-code", { email });
    if (admission.kind === "success") {
      if (state.pending) {
        state.recovery = email + "\n";
        store.replace("recovery", state.recovery);
      }
      if (!codePrompt) return options.json
        ? { status: "code_sent", email, expires_in: 600 }
        : [line("sent", { email })];
      out(line("sentTerminal", { email }));
      break;
    }
    if (emailPrompt && admission.kind === "error" && admission.error === "invalid_email") {
      err(WORDS.emailReask);
      continue;
    }
    const time = ["rate_email", "rate_ip"].includes(admission.error)
      ? new Date(Date.now() + Number(admission.retryAfter) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
      : undefined;
    refuse(remoteWord(admission), 1, { email, time });
  }
  let code;
  while (true) {
    if (code === undefined) code = normalizeCode(codePrompt ? await prompt(store, "codePrompt") : options.code);
    if (!validCode(code)) {
      if (!codePrompt) refuse("code", 2, { email });
      err(WORDS.codeReask);
      code = undefined;
      continue;
    }
    const result = await mutate(store, state, base, email, code);
    if (result.kind === "success") return options.json
      ? { status: "logged_in", email }
      : [line("login", { email })];
    if (codePrompt && result.kind === "error" && ["invalid_code", "code_invalid"].includes(result.error)) {
      err(result.error === "invalid_code" ? WORDS.codeReask : WORDS.codeIncorrectReask);
      code = undefined;
      continue;
    }
    if (codePrompt && result.kind === "error" && result.error === "invalid_email") {
      err(WORDS.emailReask);
      do {
        email = normalizeEmail(await prompt(store, "emailPrompt"));
        if (!validEmail(email)) err(WORDS.emailReask);
      } while (!validEmail(email));
      loginAllowed(state, email, environmentKey);
      // The clearly refused attempt did not consume the code or its recovery marker.
      // Retry only after the user's corrected input, without another admission.
      continue;
    }
    refuse(remoteWord(result), 1, { email });
  }
}

async function authenticated(store, state, base, command, options, environmentKey) {
  if (state.pending) refuse("pending", 2, { email: state.pending.email });
  if (environmentKey && options.all) refuse("envAll", 2);
  if (environmentKey && options.rotate) refuse("env", 2);
  if (environmentKey && !validKey(environmentKey)) refuse("envInvalid", 2);
  const selected = environmentKey || state.key;
  if (!selected) refuse("noKey", 2);
  if (!validKey(selected)) refuse("badFile");
  if (command === "logout") {
    const result = await request(base, "logout", options.all ? { all: "1" } : {}, selected);
    const matching = state.key === selected;
    if (result.kind === "success" || (result.kind === "error" && result.error === "invalid_key")) {
      if (matching) { store.remove("key"); store.remove("account"); }
      if (result.kind === "error") refuse(options.all ? "revokedAll" : matching ? "revokedLogout" : "invalidKey");
      if (options.all) return options.json
        ? { status: "logged_out_all", message: WORDS.logoutAll }
        : [WORDS.logoutAll];
      return options.json
        ? { status: "logged_out", ...(environmentKey ? { warning: WORDS.envLogout } : {}) }
        : [matching ? WORDS.logoutRemoved : WORDS.logout, ...(environmentKey ? [WORDS.envLogout] : [])];
    }
    if (!environmentKey && result.neverSent) refuse(options.all ? "offlineAll" : "offlineLogout");
    refuse(remoteWord(result));
  }
  const identity = { key_fingerprint: fingerprint(selected) };
  if (!environmentKey && state.account) identity.email = state.account.email;
  const session = await request(base, "session", {}, selected, identity);
  if (session.kind !== "success") refuse(remoteWord(session));
  const email = session.body.email;
  if (email.includes(selected)) refuse("unknown");
  if (!options.rotate) return options.json
    ? { status: "logged_in", email, key_ending: selected.slice(-4), key_from: environmentKey ? "OPSFY_API_KEY" : "saved_file" }
    : [line(environmentKey ? "displayEnv" : "display", { email, last4: selected.slice(-4) })];
  const result = await mutate(store, state, base, email, undefined, true);
  if (result.kind !== "success") refuse(remoteWord(result), 1, { email });
  return options.json ? { status: "rotated" } : [WORDS.rotate];
}

async function run(command, args, answer = new Answer()) {
  let store, output, failure;
  try {
    const options = { ...parseArguments(command, args), json: answer.json };
    const base = apiBase();
    if (process.env.OPSFY_DRY_RUN === "1") refuse("dry", 2, { command });
    if (command === "login" && options.email === undefined && (options.json || !process.stdin.isTTY)) refuse("missing", 2);
    store = new Store();
    store.prepare();
    store.acquire();
    const state = store.load();
    const environmentKey = process.env.OPSFY_API_KEY || "";
    output = command === "login"
      ? await login(store, state, base, options, environmentKey)
      : await authenticated(store, state, base, command, options, environmentKey);
  } catch (error) { failure = error; }
  finally {
    try { store?.release(); }
    catch (error) { failure = error; }
  }
  if (failure) {
    // Local and remote exception text can contain secrets; only table words reach output.
    const word = failure instanceof Refusal ? failure.word : "badFile";
    answer.failure(errorCode(word), line(word, failure.values));
    return failure instanceof Refusal ? failure.status : 1;
  }
  if (answer.json) answer.success(output);
  else output.forEach(value => out(value));
  return 0;
}

module.exports = { run };

module.exports.walletSupport = { Store, Refusal, apiBase, validKey, line, errorCode };
