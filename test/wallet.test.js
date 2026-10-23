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
  let currentTime = NOW;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  };
  if (config.fastDeadlines) {
    const setTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => setTimer(callback, ms === 10000 ? 1 : ms, ...args);
  }
  Math.random = () => 0.3141592653589793;
  crypto.randomBytes = size => Buffer.alloc(size, 73);
  crypto.randomFillSync = value => { value.fill(73); return value; };
  crypto.webcrypto.getRandomValues = crypto.randomFillSync;
  crypto.randomUUID = () => "49494949-4949-4949-8949-494949494949";

  const report = { requests: [], forbidden: [], aborted: 0, opened: [] };
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
  if (config.terminal) {
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    require("../lib/topup-browser.js").open = async url => {
      report.opened.push(url);
      return config.opened === true;
    };
  }
  if (config.answers) {
    const input = new (require("node:events").EventEmitter)();
    Object.defineProperty(process, "stdin", { value: input });
    input.isTTY = true;
    input.setRawMode = raw => { input.isRaw = raw; };
    input.pause = () => input;
    input.resume = () => {
      setImmediate(() => input.emit("data", Buffer.from(config.answers.shift())));
      return input;
    };
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const index = report.requests.length;
    const body = request.method === "GET" ? "" : await request.text();
    report.requests.push({
      url: request.url, method: request.method, body,
      bearerMatches: request.headers.get("authorization") === "Bearer " + selected,
      accept: request.headers.get("accept"), redirect: request.redirect,
      balanceUnit: request.headers.get("Opsfy-Balance"),
    });
    request.signal.addEventListener("abort", () => report.aborted++, { once: true });
    const reply = config.replies[index];
    if (!reply) { report.forbidden.push("unexpected request"); throw new Error("offline fixture"); }
    if (reply.advance) currentTime += reply.advance;
    if (reply.signal) process.emit(reply.signal);
    if (reply.network) throw new TypeError("untrusted transport detail");
    if (reply.deadline) return new Promise(() => {});
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
  const unavailable = "opsfy.ai cannot start a top-up right now; nothing was charged · wait 60 seconds, then run the same command again\n";
  const storage = "opsfy.ai could not read top-up 0123456789abcdef0123456789abcdef; a payment still counts · wait 60 seconds, then run opsfy topup status 0123456789abcdef0123456789abcdef --json\n";
  const logsUnavailable = "opsfy.ai could not read the balance · wait 60 seconds, then run opsfy logs again\n";

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
  const row = index => ({ kind: "topup", id: "session-" + index, amount_microusd: 25000000, at: new Date(Date.parse("+010000-01-01T00:00:59.000Z") - index * 1000).toISOString() });
  const page = (rows = [], cursor = null, balance = 0) => ({ status: 200,
    body: { ok: true, currency: "usd", balance_microusd: balance, entries: rows, next_before: cursor === null ? null : String(Date.parse(rows.at(-1).at)).padStart(16, "0") + ":t:" + Buffer.from(rows.at(-1).id).toString("hex") } });

  test("wallet topup sends canonical cents and returns only the checked page", t => {
    const run = world(t);
    for (const amount of ["25", "$25.00USD", " 25usd "]) {
      const result = run(["topup", amount], [creation()]);
      check(result, 0, "top-up 0123456789abcdef0123456789abcdef · open · $25.00 · pay at " + PAGE +
        " until 2026-09-30T13:00:00Z · ask the person to pay there, then run opsfy topup wait 0123456789abcdef0123456789abcdef --json\n", "");
      assert.deepEqual(result.observation.requests.map(r => [r.url, r.method, r.body]), [[BASE + "/api/topup", "POST", "amount_cents=2500"]]);
    }
  });

  test("wallet malformed environment keys never fall back to the saved key", t => {
    const run = world(t);
    for (const args of [["topup", "25"], ["logs"], ["logs", "--json"]]) {
      const json = args.includes("--json");
      const message = "OPSFY_API_KEY is not an opsfy key (opsfy_sk_ and 64 hex characters) · fix OPSFY_API_KEY or unset it, then run the same command again";
      check(run(args, [], { environment: " " }), 2,
        json ? JSON.stringify({ ok: false, error: "api_key_env_set", message }) + "\n" : "",
        json ? "" : "api_key_env_set: " + message + "\n");
    }
  });

  test("wallet interrupted response bodies fail once without exposing transport text", t => {
    const run = world(t);
    for (const args of [["topup", "25"], ["logs"], ["logs", "--json"]]) {
      const reply = args[0] === "topup" ? creation() : page();
      const result = run(args, [{ ...reply, interrupt: true }]);
      const json = args.includes("--json"), message = args[0] === "topup" ? unavailable : logsUnavailable;
      check(result, 1,
        json ? JSON.stringify({ ok: false, error: "balance_unavailable", message: message.trimEnd() }) + "\n" : "",
        json ? "" : (args[0] === "topup" ? "topup_unavailable: " : "balance_unavailable: ") + message);
      assert.equal(result.observation.requests.length, 1);
      assert.equal(result.observation.aborted, 1);
    }
  });

  test("wallet later interrupted history bodies discard all buffered output", t => {
    const run = world(t), first = Array.from({ length: 50 }, (_, i) => row(i));
    for (const args of [["logs"], ["logs", "--json"]]) {
      const result = run(args, [page(first, "100", 125000), { ...page([row(51)], null, 127500), interrupt: true }]);
      const json = args.includes("--json");
      check(result, 1,
        json ? JSON.stringify({ ok: false, error: "balance_unavailable", message: logsUnavailable.trimEnd() }) + "\n" : "",
        json ? "" : "balance_unavailable: " + logsUnavailable);
      assert.equal(result.observation.requests.length, 2);
      assert.equal(result.observation.aborted, 1);
    }
  });

  test("wallet session IDs remain unique across nonadjacent history pages", t => {
    const run = world(t);
    const first = Array.from({ length: 50 }, (_, i) => row(i));
    const second = Array.from({ length: 50 }, (_, i) => row(i + 50));
    for (const args of [["logs"], ["logs", "--json"]]) {
      const result = run(args, [page(first, "200", 250000), page(second, "100", 250000), page([{ ...row(0), at: row(100).at }])]);
      const json = args.includes("--json");
      check(result, 1,
        json ? JSON.stringify({ ok: false, error: "balance_unavailable", message: logsUnavailable.trimEnd() }) + "\n" : "",
        json ? "" : "balance_unavailable: " + logsUnavailable);
      assert.equal(result.observation.requests.length, 3);
    }
  });

  test("wallet history retains the first balance and server order in text and JSON", t => {
    const run = world(t);
    const first = Array.from({ length: 50 }, (_, i) => row(i));
    const last = { ...row(50), at: "2026-09-30T00:00:00.000Z" };
    const replies = [page(first, "100", 9007199254740900), page([last], null, 0)];
    const expected = "balance $9007199254.7409 USD\n" +
      Array.from({ length: 50 }, (_, i) => `+010000-01-01T00:00:${String(59 - i).padStart(2, "0")}Z · top-up session-${i} · +$25.00\n`).join("") +
      "2026-09-30T00:00:00Z · top-up session-50 · +$25.00\n";
    check(run(["logs"], replies, { environment: "other" }), 0, expected, "");
    const result = run(["logs", "--json"], replies, { environment: "other" });
    check(result, 0, JSON.stringify({ ok: true, currency: "usd", balance_microusd: 9007199254740900,
      entries: [...first, last] }) + "\n", "");
    assert.deepEqual(result.observation.requests.map(r => r.url), [BASE + "/api/history", BASE + "/api/history?before=" + encodeURIComponent(page(first, 100).body.next_before)]);
  });

  function paidStatus(balance) {
    return { status: 200, body: {
      ok: true, status: "paid", id: "0123456789abcdef0123456789abcdef", amount_cents: 2500,
      currency: "usd", url: PAGE, expires_at: NOW / 1000 + 3600, ...balance,
    } };
  }

  test("wallet paid status and wait preserve exact balances and normalize legacy cents", t => {
    const run = world(t);
    const cases = [
      [{ balance_microusd: 10000000 }, 10000000, "$10.00"],
      [{ balance_microusd: 9990400 }, 9990400, "$9.9904"],
      [{ balance_microusd: 9990399 }, 9990399, "$9.990399"],
      [{ balance_microusd: 19990400 }, 19990400, "$19.9904"],
      [{ balance_microusd: 0 }, 0, "$0.00"],
      [{ balance_microusd: 1 }, 1, "$0.000001"],
      [{ balance_microusd: 100 }, 100, "$0.0001"],
      [{ balance_microusd: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, "$9007199254.740991"],
      [{ balance_cents: 0 }, 0, "$0.00"],
      [{ balance_cents: 1999 }, 19990000, "$19.99"],
      [{ balance_cents: 900719925474 }, 9007199254740000, "$9007199254.74"],
    ];
    for (const action of ["status", "wait"]) {
      for (const [balance, microusd, formatted] of cases) {
        const reply = paidStatus(balance), id = reply.body.id;
        for (const json of [false, true]) {
          const result = run(["topup", action, id, ...(json ? ["--json"] : [])], [reply]);
          const expected = json ? JSON.stringify({
            ok: true, status: "paid", id, amount_cents: 2500,
            currency: "usd", url: PAGE, expires_at: reply.body.expires_at, balance_microusd: microusd,
          }) + "\n" : "top-up " + id + " · paid · +$25.00 · balance " + formatted + " USD\n";
          check(result, 0, expected, "");
          assert.deepEqual(result.observation.requests.map(r => [r.url, r.method, r.balanceUnit]),
            [[BASE + "/api/topup/status?id=" + id, "GET", "microusd"]]);
        }
      }
    }
  });

  test("wallet rejects ambiguous, missing, invalid and overflowing paid balances", t => {
    const run = world(t);
    const invalid = [
      {},
      { balance_cents: 1999, balance_microusd: 19990000 },
      { balance_microusd: 19990400, extra: true },
      { balance_microusd: -1 },
      { balance_microusd: 0.5 },
      { balance_microusd: "19990400" },
      { balance_microusd: null },
      { balance_microusd: Number.MAX_SAFE_INTEGER + 1 },
      { balance_cents: -1 },
      { balance_cents: 0.5 },
      { balance_cents: "1999" },
      { balance_cents: null },
      { balance_cents: 900719925475 },
      { balance_cents: Number.MAX_SAFE_INTEGER },
      ...["open", "cancelled", "expired"].map(status => ({ status, balance_microusd: 19990400 })),
    ];
    for (const action of ["status", "wait"]) {
      for (const balance of invalid) {
        const reply = paidStatus(balance);
        for (const json of [false, true]) {
          const result = run(["topup", action, reply.body.id, ...(json ? ["--json"] : [])], [reply]);
          check(result, 1,
            json ? JSON.stringify({ ok: false, error: "balance_unavailable", message: storage.trimEnd() }) + "\n" : "",
            json ? "" : "balance_unavailable: " + storage);
          assert.equal(result.observation.requests.length, 1);
        }
      }
    }
  });

  test("wallet terminal topup negotiates exact balances on every status poll", t => {
    const run = world(t), paid = paidStatus({ balance_microusd: 19990400 });
    const open = paidStatus({ status: "open" });
    const result = run(["topup", "25"], [creation(), open, paid], { terminal: true });
    check(result, 0,
      "top-up 0123456789abcdef0123456789abcdef · open · $25.00 · pay at " + PAGE + " until 2026-09-30T13:00:00Z\n" +
      "waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts\n" +
      "top-up 0123456789abcdef0123456789abcdef · paid · +$25.00 · balance $19.9904 USD\n", "");
    assert.deepEqual(result.observation.requests.map(r => [r.url, r.method, r.balanceUnit]), [
      [BASE + "/api/topup", "POST", null],
      [BASE + "/api/topup/status?id=" + paid.body.id, "GET", "microusd"],
      [BASE + "/api/topup/status?id=" + paid.body.id, "GET", "microusd"],
    ]);
  });

  test("call server refusals match the approved messages in plain text and JSON", t => {
    const run = world(t);
    const update = "opsfy.ai could not read this CLI's request · run npm i -g @opsfy/cli@latest, then read https://opsfy.ai/SKILL.md again";
    const cases = [
      [400, "invalid_question", {}, "opsfy.ai refused the question · check its limits with opsfy info tavily, change it, then run the call again"],
      [400, "invalid_input", { allowed_inputs: ["question"] }, "the inputs do not match tavily's; it takes: question · run opsfy info tavily for each input's type and limits"],
      [402, "insufficient_balance", { price_microusd: 9600, balance_microusd: 5000 },
        "a tavily search needs a hold of $0.0096 and the balance is $0.0050; nothing was charged · ask the person to add money, then run opsfy topup 10 --json"],
      [402, "insufficient_balance", { price_microusd: 12001, balance_microusd: 1234 },
        "a tavily search needs a hold of $0.012001 and the balance is $0.001234; nothing was charged · ask the person to add money, then run opsfy topup 10 --json"],
      [502, "search_failed", {}, "Tavily answered with an error; nothing was charged · run the same call again"],
      [429, "rate_limited", {}, "too many calls (10 a minute for each account, or Tavily's own limit) · wait 60 seconds, then run the call again"],
      [503, "configuration_unavailable", {}, "opsfy.ai cannot make calls right now · wait 60 seconds, then run the call again"],
      [503, "storage_unavailable", {}, "opsfy.ai could not read or update the balance · wait 60 seconds, then run opsfy logs --json before calling again"],
      [400, "tool_not_open", {}, 'this tool is listed but not open yet; open now: tavily · run opsfy find "<job>" for another'],
      ...[[405, "method_not_allowed"], [400, "invalid_request"], [415, "unsupported_media_type"], [413, "body_too_large"]]
        .map(([status, error]) => [status, error, {}, update]),
    ];
    for (const [status, serverError, fields, message] of cases) {
      const error = message === update ? "update_needed" : serverError;
      for (const json of [false, true]) {
        const result = run(["call", "tavily", "what is opsfy", ...(json ? ["--json"] : [])],
          [{ status, body: { ok: false, error: serverError, ...fields } }]);
        check(result, 1, json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
        assert.equal(result.observation.requests.length, 1);
        assert.equal(result.observation.requests[0].body, '{"tool":"tavily","question":"what is opsfy"}');
      }
    }
  });

  test("unconfirmed calls mention possible charges and the JSON logs command", t => {
    const run = world(t);
    const message = "no confirmation came back, so it may have been charged · run opsfy logs --json and look for it before calling again";
    for (const reply of [{ network: true }, { status: 200, body: { ok: true } }, { status: 200, body: {}, interrupt: true }]) {
      for (const json of [false, true]) {
        const result = run(["call", "tavily", "what is opsfy", ...(json ? ["--json"] : [])], [reply]);
        check(result, 1,
          json ? JSON.stringify({ ok: false, error: "call_unavailable", message }) + "\n" : "",
          json ? "" : `call_unavailable: ${message}\n`);
        assert.equal(result.observation.requests.length, 1);
      }
    }
  });

  test("paid call summaries include the full id and charge while JSON is unchanged", t => {
    const run = world(t), body = {
      ok: true, tool: "tavily", call_id: "0123456789abcdef0123456789abcdef",
      results: [{ title: "Example", url: "https://example.invalid/", content: "An answer" }],
      price_microusd: 9600, balance_microusd: 29990400,
    };
    check(run(["call", "tavily", "what is opsfy"], [{ status: 200, body }]), 0,
      "1. Example\n   https://example.invalid/\n   An answer\n" +
      "tavily search · call 0123456789abcdef0123456789abcdef · charged $0.0096 · balance $29.9904 USD\n", "");
    check(run(["call", "tavily", "what is opsfy", "--json"], [{ status: 200, body }]), 0, JSON.stringify(body) + "\n", "");
  });

  test("logs retain full ids, UTC seconds, statuses and amounts without changing JSON", t => {
    const run = world(t), entries = [
      { kind: "call", id: "0123456789abcdef0123456789abcdef", at: "2026-10-12T07:44:10.987Z", tool: "tavily", status: "charged", price_microusd: 9600 },
      { kind: "call", id: "fedcba9876543210fedcba9876543210", at: "2026-10-12T07:44:10.321Z", tool: "tavily", status: "failed", price_microusd: 0 },
      { kind: "topup", id: "3f9c2b7e14d84a6f9e0b5c7d2a1e8f64", at: "2026-10-02T09:23:05.000Z", amount_microusd: 10000000 },
    ];
    const replies = [page(entries, null, 29980800)];
    check(run(["logs"], replies), 0,
      "balance $29.9808 USD\n" +
      "2026-10-12T07:44:10Z · call 0123456789abcdef0123456789abcdef · tavily search · charged $0.0096\n" +
      "2026-10-12T07:44:10Z · call fedcba9876543210fedcba9876543210 · tavily search · failed · $0 charged\n" +
      "2026-10-02T09:23:05Z · top-up 3f9c2b7e14d84a6f9e0b5c7d2a1e8f64 · +$10.00\n", "");
    check(run(["logs", "--json"], replies), 0,
      JSON.stringify({ ok: true, currency: "usd", balance_microusd: 29980800, entries }) + "\n", "");
    check(run(["logs"], [page()]), 0, "balance $0.00 USD\n", "");
  });

  test("topup amount refusals give the approved words in plain text and JSON", t => {
    const run = world(t), message = "a top-up is $10, $25, $50, $100, $250 or $500; none was started · ask the person which amount, then run opsfy topup <amount> --json";
    check(run(["topup", "7"], []), 2, "", "invalid_amount: " + message + "\n");
    check(run(["topup", "7", "--json"], []), 2,
      JSON.stringify({ ok: false, error: "invalid_amount", message }) + "\n", "");
  });

  test("topup creation JSON keeps its fields and never opens the browser", t => {
    const run = world(t), reply = creation();
    for (const terminal of [false, true]) {
      const result = run(["topup", "25", "--json"], [reply], { terminal, opened: true });
      check(result, 0, JSON.stringify({ ok: true, status: "open", id: reply.body.id, amount_cents: 2500,
        currency: "usd", url: PAGE, expires_at: reply.body.expires_at }) + "\n", "");
      assert.deepEqual(result.observation.opened, []);
      assert.equal(result.observation.requests.length, 1);
    }
  });

  test("terminal topup reports an opened payment page with a stubbed browser", t => {
    const run = world(t), paid = paidStatus({ balance_microusd: 39980800 }), id = paid.body.id;
    const result = run(["topup", "25"], [creation(), paid], { terminal: true, opened: true });
    check(result, 0,
      `top-up ${id} · open · $25.00 · pay at ${PAGE} until 2026-09-30T13:00:00Z\n` +
      "opened the payment page in the browser · waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts\n" +
      `top-up ${id} · paid · +$25.00 · balance $39.9808 USD\n`, "");
    assert.deepEqual(result.observation.opened, [PAGE]);
    assert.equal(result.observation.requests.length, 2);
  });

  test("topup status and wait print one approved outcome and preserve JSON and exit codes", t => {
    const run = world(t), id = creation().body.id;
    for (const [status, exit] of [["cancelled", 3], ["expired", 4], ["open", 5]]) {
      const reply = paidStatus({ status });
      const message = status === "open" ?
        `top-up ${id} · open · $25.00 · not paid yet; pay at ${PAGE} until 2026-09-30T13:00:00Z · run opsfy topup wait ${id} --json to wait again` :
        `top-up ${id} · ${status} · $25.00 · nothing was charged · ask the person whether to try again, then run opsfy topup 25 --json`;
      for (const action of ["status", "wait"]) {
        for (const json of [false, true]) {
          const result = run(["topup", action, id, ...(json ? ["--json"] : [])],
            [{ ...reply, advance: action === "wait" && status === "open" ? 600000 : 0 }]);
          check(result, exit, json ? JSON.stringify(reply.body) + "\n" : message + "\n", "");
          assert.equal(result.observation.requests.length, 1);
        }
      }
    }
  });

  test("terminal topup wait prints the approved waiting line before its outcome", t => {
    const run = world(t), paid = paidStatus({ balance_microusd: 10000000 }), id = paid.body.id;
    const result = run(["topup", "wait", id], [paid], { terminal: true });
    check(result, 0,
      "waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts\n" +
      `top-up ${id} · paid · +$25.00 · balance $10.00 USD\n`, "");
    assert.deepEqual(result.observation.opened, []);
  });

  test("topup start server refusals use the approved messages before an id exists", t => {
    const run = world(t);
    const update = "opsfy.ai could not read this CLI's request · run npm i -g @opsfy/cli@latest, then read https://opsfy.ai/SKILL.md again";
    const cases = [
      [400, "invalid_amount", "invalid_amount", "a top-up is $10, $25, $50, $100, $250 or $500; none was started · ask the person which amount, then run opsfy topup <amount> --json"],
      [503, "configuration_unavailable", "topup_unavailable", unavailable.trimEnd()],
      [503, "stripe_unavailable", "topup_unavailable", unavailable.trimEnd()],
      [503, "storage_unavailable", "balance_unavailable", "opsfy.ai could not start the top-up; nothing was charged · wait 60 seconds, then run the same command again"],
      ...[[405, "method_not_allowed"], [400, "invalid_request"], [415, "unsupported_media_type"], [413, "body_too_large"]]
        .map(([status, error]) => [status, error, "update_needed", update]),
    ];
    for (const [status, serverError, error, message] of cases) {
      for (const json of [false, true]) {
        const reply = { status, body: { ok: false, error: serverError }, headers: status === 405 ? { allow: "POST" } : {} };
        const result = run(["topup", "25", ...(json ? ["--json"] : [])], [reply]);
        check(result, 1, json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
        assert.equal(result.observation.requests.length, 1);
      }
    }
  });

  test("topup checking and every waiting path retain the id in refusal messages", t => {
    const run = world(t), id = creation().body.id;
    const cases = [
      [{ status: 503, body: { ok: false, error: "configuration_unavailable" } }, "topup_unavailable",
        `opsfy.ai cannot read top-up ${id} right now; a payment still counts · wait 60 seconds, then run opsfy topup status ${id} --json`],
      [{ status: 404, body: { ok: false, error: "unknown_topup" } }, "unknown_topup",
        `this account has no top-up ${id} · run opsfy topup status <id> --json with an id opsfy topup gave on this account`],
      ...[
        { status: 503, body: { ok: false, error: "storage_unavailable" } },
        { network: true },
        { deadline: true },
        { ...paidStatus({ status: "open" }), interrupt: true },
        { ...paidStatus({ status: "open" }), headers: { "cache-control": "public" } },
        { status: 200, body: { ok: true } },
        paidStatus({ balance_microusd: 1, id: "f".repeat(32) }),
      ].map(reply => [reply, "balance_unavailable", storage.trimEnd()]),
    ];
    for (const [reply, error, message] of cases) {
      for (const action of ["status", "wait", "start"]) {
        for (const json of action === "start" ? [false] : [false, true]) {
          const starting = action === "start";
          const args = starting ? ["topup", "25"] : ["topup", action, id];
          const result = run([...args, ...(json ? ["--json"] : [])], starting ? [creation(), reply] : [reply],
            { terminal: starting, fastDeadlines: !!reply.deadline });
          const prefix = starting ? `top-up ${id} · open · $25.00 · pay at ${PAGE} until 2026-09-30T13:00:00Z\n` +
            "waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts\n" : "";
          check(result, 1, json ? JSON.stringify({ ok: false, error, message }) + "\n" : prefix, json ? "" : `${error}: ${message}\n`);
          assert.equal(result.observation.requests.length, starting ? 2 : 1);
        }
      }
    }
  });

  test("terminal waiting names its topup when the payment identity changes", t => {
    const run = world(t), id = creation().body.id;
    const result = run(["topup", "25"], [creation(), paidStatus({ balance_microusd: 10000000, amount_cents: 1000 })], { terminal: true });
    check(result, 1,
      `top-up ${id} · open · $25.00 · pay at ${PAGE} until 2026-09-30T13:00:00Z\n` +
      "waiting for the payment, up to 10 minutes · Ctrl-C stops waiting; a payment still counts\n",
      "balance_unavailable: " + storage);
  });

  test("stopping topup wait preserves the id, exit code and JSON fields", t => {
    const run = world(t), id = creation().body.id;
    const message = `stopped waiting for top-up ${id}; a payment still counts · run opsfy topup status ${id} --json`;
    for (const json of [false, true]) {
      const result = run(["topup", "wait", id, ...(json ? ["--json"] : [])], [{ signal: "SIGINT" }]);
      check(result, 130, json ? JSON.stringify({ ok: false, error: "stopped_waiting", message, id }) + "\n" : "",
        json ? "" : "stopped_waiting: " + message + "\n");
    }
  });

  test("the amount question and re-ask keep their words and cancellation has its own line", t => {
    const run = world(t), question = "Top up $10, $25, $50, $100, $250 or $500 USD:\n";
    const result = run(["topup"], [], { terminal: true, answers: ["7\r", "\x03"] });
    check(result, 1, question + question,
      "choose $10, $25, $50, $100, $250 or $500 USD\n" +
      "cancelled: stopped before an amount was chosen; no top-up was started and nothing was charged · run opsfy topup <amount> --json\n");
    assert.deepEqual(result.observation.requests, []);
    assert.deepEqual(result.observation.opened, []);
  });

  test("area four usage and unknown commands keep their streams and leave a saved account untouched", t => {
    const run = world(t);
    const cases = [
      [["find"], "usage", 'no words given · run opsfy find "<job>" --json'],
      [["find", "the", "and"], "usage", 'no words given · run opsfy find "<job>" --json'],
      ...[["info"], ["info", "tavily", "magpie"]].map(args => [args, "usage",
        'opsfy info takes one tool name · run opsfy info <tool> --json; opsfy find "<job>" --json gives the names']),
      [["call"], "usage", 'no tool named · run opsfy call <tool> "<input>" --json; opsfy find "<job>" --json gives the names'],
      [["install"], "usage", "no app named · run opsfy install <app> --json; opsfy list --json shows the apps"],
      [["ask"], "usage", 'no tool named · run opsfy ask "<tool>" --json'],
      [["frobnicate"], "unknown_command", "opsfy has no command frobnicate · run opsfy --help for the commands"],
    ];
    for (const [args, error, message] of cases) {
      for (const json of [false, true]) {
        const result = run([...args, ...(json ? ["--json"] : [])], []);
        check(result, 2, json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
        assert.deepEqual(result.observation.requests, []);
      }
    }
  });

  test("ask length refusals report the existing character count in plain text and JSON without a request", t => {
    const run = world(t);
    for (const [name, length] of [["x".repeat(121), 121], ["💡".repeat(61), 122]]) {
      const message = `the name has ${length} characters; the most is 120 · shorten it, then run opsfy ask again`;
      for (const json of [false, true]) {
        const result = run(["ask", name, ...(json ? ["--json"] : [])], []);
        check(result, 2, json ? JSON.stringify({ ok: false, error: "too_long", message }) + "\n" : `too_long: ${message}\n`, "");
        assert.deepEqual(result.observation.requests, []);
      }
    }
  });
}
