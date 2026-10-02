"use strict";

const fs = require("node:fs");
if (process.env.NODE_TEST_CONTEXT === "child-v8" && require.main === module) {
  // Match the retained suite's descriptor-backed reporting in restricted sandboxes.
  Object.defineProperty(process, "stdout", {
    value: fs.createWriteStream(null, { fd: 1, autoClose: false }),
  });
}
const path = require("node:path");
const crypto = require("node:crypto");
const ENTRY = path.resolve(__dirname, "../bin/opsfy.js");
const NOW = 1790769600000;
const BASE = "http://127.0.0.1:9";
const PAGE = "https://checkout.stripe.com/c/pay/opaque#Exact";
const keyFor = label => "opsfy_sk_" + crypto.createHash("sha256").update("wallet-test:" + label).digest("hex");

// This file also acts as a preload/entry driver. Inputs travel in a file, never argv.
function fixture(filename) {
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  };
  Math.random = () => 0.3141592653589793;
  crypto.randomBytes = size => Buffer.alloc(size, 73);
  crypto.randomFillSync = value => { value.fill(73); return value; };
  crypto.webcrypto.getRandomValues = crypto.randomFillSync;
  crypto.randomUUID = () => "49494949-4949-4949-8949-494949494949";

  const report = { requests: [], forbidden: [], aborted: 0 };
  const deny = () => { report.forbidden.push("outside fetch"); throw new Error("offline fixture"); };
  for (const [module, names] of [
    ["node:child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
    ["node:http", ["request", "get", "createServer"]],
    ["node:https", ["request", "get", "createServer"]],
    ["node:http2", ["connect", "createServer", "createSecureServer"]],
    ["node:net", ["connect", "createConnection", "createServer"]],
    ["node:tls", ["connect", "createServer"]],
    ["node:dgram", ["createSocket"]],
    ["node:worker_threads", ["Worker"]],
  ]) {
    const target = require(module);
    for (const name of names) target[name] = deny;
  }
  require("node:net").Socket.prototype.connect = deny;
  require("node:net").Server.prototype.listen = deny;
  const dns = require("node:dns");
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (name.startsWith("resolve") || ["lookup", "lookupService", "setServers"].includes(name)) target[name] = deny;
    }
  }
  if (config.environment !== undefined) {
    process.env.OPSFY_API_KEY = config.environment === "other" ? keyFor("other") : config.environment;
  }
  const selected = process.env.OPSFY_API_KEY || keyFor("saved");
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const index = report.requests.length;
    const body = request.method === "GET" ? "" : await request.text();
    report.requests.push({
      url: request.url, method: request.method, body,
      bearerMatches: request.headers.get("authorization") === "Bearer " + selected,
      accept: request.headers.get("accept"), redirect: request.redirect,
    });
    request.signal.addEventListener("abort", () => report.aborted++, { once: true });
    const reply = config.replies[index];
    if (!reply) { report.forbidden.push("unexpected request"); throw new Error("offline fixture"); }
    if (reply.network) throw new TypeError("untrusted transport detail");
    const response = new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...reply.headers },
    });
    Object.defineProperty(response, "url", { value: request.url });
    if (reply.interrupt) {
      // A response was received, but the connection/stream cannot supply its body.
      response.text = async () => { throw new TypeError("untrusted interrupted body"); };
    }
    return response;
  };
  process.on("exit", () => fs.writeFileSync(config.report, JSON.stringify(report)));
  process.argv = [process.execPath, ENTRY, ...config.args];
  require(ENTRY);
}

if (require.main === module && process.argv[2] === "--fixture") {
  fixture(process.argv[3]);
} else {
  const { test } = require("node:test");
  const assert = require("node:assert/strict");
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const unavailable = "top-ups are unavailable right now · try again in a minute\n";
  const storage = "your balance could not be read or updated · try again in a minute\n";

  function world(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "home"), privateHome = path.join(home, "private");
    fs.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
    const key = keyFor("saved");
    const saved = {
      key: key + "\n",
      account: JSON.stringify({ email: "saved@example.invalid", key_fingerprint: crypto.createHash("sha256").update(key).digest("hex") }) + "\n",
    };
    for (const [name, data] of Object.entries(saved)) fs.writeFileSync(path.join(privateHome, name), data, { mode: 0o600 });
    return (args, replies, extra = {}) => {
      const config = path.join(root, "input.json"), report = path.join(root, "report.json");
      fs.writeFileSync(config, JSON.stringify({ args, replies, report, ...extra }));
      const stdout = path.join(root, "stdout.txt"), stderr = path.join(root, "stderr.txt");
      const out = fs.openSync(stdout, "w"), err = fs.openSync(stderr, "w");
      let result;
      try {
        result = spawnSync(process.execPath, [__filename, "--fixture", config], {
          cwd: root, timeout: 5000, stdio: ["ignore", out, err],
          env: { PATH: "/usr/bin:/bin", HOME: home, OPSFY_HOME: privateHome,
            OPSFY_API_BASE: BASE, OPSFY_NO_COUNT: "1", TMPDIR: root, TZ: "America/Los_Angeles",
            NODE_DISABLE_COMPILE_CACHE: "1" },
        });
      } finally { fs.closeSync(out); fs.closeSync(err); }
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const observation = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.deepEqual(observation.forbidden, []);
      for (const request of observation.requests) {
        assert.equal(request.bearerMatches, true);
        assert.equal(request.accept, "application/json");
        assert.equal(request.redirect, "error");
      }
      assert.deepEqual(fs.readdirSync(privateHome).sort(), ["account", "key"]);
      for (const [name, data] of Object.entries(saved)) assert.equal(fs.readFileSync(path.join(privateHome, name), "utf8"), data);
      return { status: result.status, stdout: fs.readFileSync(stdout), stderr: fs.readFileSync(stderr), observation };
    };
  }

  function check(result, status, stdout, stderr) {
    assert.equal(result.status, status);
    assert.deepEqual(result.stdout, Buffer.from(stdout));
    assert.deepEqual(result.stderr, Buffer.from(stderr));
  }

  const creation = (amount = 2500) => ({ status: 201, body: {
    ok: true, id: "0123456789abcdef0123456789abcdef", status: "open", session_id: "opaque-session", url: PAGE, amount_cents: amount,
    currency: "usd", expires_at: NOW / 1000 + 3600,
  } });
  const row = index => ({ session_id: "session-" + index, amount_cents: 2500, paid_at: "2026-09-30T00:00:59.000Z" });
  const page = (rows = [], cursor = null, balance = 0) => ({ status: 200,
    body: { ok: true, currency: "usd", balance_cents: balance, topups: rows, next_before: cursor } });

  test("wallet topup sends canonical cents and returns only the checked page", t => {
    const run = world(t);
    for (const amount of ["25", "$25.00USD", " 25usd "]) {
      const result = run(["topup", amount], [creation()]);
      check(result, 0, "pay $25.00 USD here: " + PAGE + "\nthen run: opsfy topup wait 0123456789abcdef0123456789abcdef\n", "");
      assert.deepEqual(result.observation.requests.map(r => [r.url, r.method, r.body]), [[BASE + "/api/topup", "POST", "amount_cents=2500"]]);
    }
  });

  test("wallet malformed environment keys never fall back to the saved key", t => {
    const run = world(t);
    for (const args of [["topup", "25"], ["logs"], ["logs", "--json"]]) {
      check(run(args, [], { environment: " " }), 2, "", "OPSFY_API_KEY is set · unset it, then try again\n");
    }
  });

  test("wallet interrupted response bodies fail once without exposing transport text", t => {
    const run = world(t);
    for (const args of [["topup", "25"], ["logs"], ["logs", "--json"]]) {
      const reply = args[0] === "topup" ? creation() : page();
      const result = run(args, [{ ...reply, interrupt: true }]);
      check(result, 1, "", args[0] === "topup" ? unavailable : storage);
      assert.equal(result.observation.requests.length, 1);
      assert.equal(result.observation.aborted, 1);
    }
  });

  test("wallet later interrupted history bodies discard all buffered output", t => {
    const run = world(t), first = Array.from({ length: 50 }, (_, i) => row(i));
    for (const args of [["logs"], ["logs", "--json"]]) {
      const result = run(args, [page(first, "100", 125000), { ...page([row(51)], null, 127500), interrupt: true }]);
      check(result, 1, "", storage);
      assert.equal(result.observation.requests.length, 2);
      assert.equal(result.observation.aborted, 1);
    }
  });

  test("wallet session IDs remain unique across nonadjacent history pages", t => {
    const run = world(t);
    const first = Array.from({ length: 50 }, (_, i) => row(i));
    const second = Array.from({ length: 50 }, (_, i) => row(i + 50));
    for (const args of [["logs"], ["logs", "--json"]]) {
      const result = run(args, [page(first, "200", 250000), page(second, "100", 250000), page([row(0)])]);
      check(result, 1, "", storage);
      assert.equal(result.observation.requests.length, 3);
    }
  });

  test("wallet history retains the first balance and server order in text and JSON", t => {
    const run = world(t);
    const first = Array.from({ length: 50 }, (_, i) => row(i));
    const last = { ...row(50), paid_at: "+010000-01-01T00:00:00.000Z" };
    const replies = [page(first, "100", 9007199254740990), page([last], null, 0)];
    const expected = "balance: $90071992547409.90 USD\n" +
      "2026-09-30 00:00 UTC · top-up +$25.00 USD\n".repeat(50) +
      "+010000-01-01 00:00 UTC · top-up +$25.00 USD\n";
    check(run(["logs"], replies, { environment: "other" }), 0, expected, "");
    const result = run(["logs", "--json"], replies, { environment: "other" });
    check(result, 0, JSON.stringify({ currency: "usd", balance_cents: 9007199254740990,
      topups: [...first, last].map(({ amount_cents, paid_at }) => ({ amount_cents, paid_at })) }, null, 2) + "\n", "");
    assert.deepEqual(result.observation.requests.map(r => r.url), [BASE + "/api/wallet", BASE + "/api/wallet?before=100"]);
  });
}
