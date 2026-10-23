"use strict";

const fs = require("node:fs");
if (process.env.NODE_TEST_CONTEXT === "child-v8") {
  // Keep Node's test reports flowing through the inherited descriptor even
  // when the sandbox cannot use its default socket-backed stdout stream.
  Object.defineProperty(process, "stdout", {
    value: fs.createWriteStream(null, { fd: 1, autoClose: false }),
  });
}
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

Date.now = () => 1790596800000;
const ENTRY = path.resolve(__dirname, "../bin/opsfy.js");
const BUNDLED = path.resolve(__dirname, "../catalog.json");
const bundled = require("../catalog.json");
const GET = "OPSFY_DRY_RUN=1: would send GET https://opsfy.ai/tools.json\n";
const OPENWORK = "OpenWork · MIT · from the upstream release · github.com/different-ai/openwork\n";
const GSTACK = "gstack · MIT · from the upstream repo · github.com/garrytan/gstack\n";

function recordScript(name) {
  return [
    "#!/bin/sh",
    `printf 'CALL=%s\\n' '${name}' >> "$FAKE_LOG"`,
    "for arg; do printf 'ARG=%s\\n' \"$arg\" >> \"$FAKE_LOG\"; done",
    "printf 'MARKER=%s\\n' \"$FAKE_MARKER\" >> \"$FAKE_LOG\"",
  ];
}

const setupScript = [
  ...recordScript("setup"),
  "printf 'CWD=%s\\n' \"$(pwd)\" >> \"$FAKE_LOG\"",
  "exit \"${FAKE_SETUP_EXIT:-0}\"",
].join("\n") + "\n";

const fakeScripts = {
  brew: [
    ...recordScript("brew"),
    "printf 'BREW_ENV=%s,%s\\n' \"$HOMEBREW_NO_AUTO_UPDATE\" \"$HOMEBREW_NO_ENV_HINTS\" >> \"$FAKE_LOG\"",
    "if [ -n \"$FAKE_BREW_OUTPUT\" ]; then printf '%s\\n' \"$FAKE_BREW_OUTPUT\"; fi",
    "if [ \"$FAKE_SIGNAL\" = brew ]; then kill -TERM \"$$\"; fi",
    "exit \"${FAKE_BREW_EXIT:-0}\"",
  ].join("\n") + "\n",
  git: [
    ...recordScript("git"),
    "if [ \"${FAKE_GIT_EXIT:-0}\" != 0 ]; then exit \"$FAKE_GIT_EXIT\"; fi",
    "if [ \"$1\" = clone ]; then",
    "  for target; do :; done",
    "  /bin/mkdir -p \"$target\" || exit 1",
    "  printf '%s' \"$FAKE_SETUP_SCRIPT\" > \"$target/setup\"",
    "  /bin/chmod 755 \"$target/setup\" || exit 1",
    "fi",
    "exit 0",
  ].join("\n") + "\n",
  bun: [...recordScript("bun"), "exit 0"].join("\n") + "\n",
  claude: [...recordScript("claude"), "exit 0"].join("\n") + "\n",
};

function world(t, fakes = ["brew", "git", "bun", "claude"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opsfy cli test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.txt");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const name of fakes) {
    fs.writeFileSync(path.join(bin, name), fakeScripts[name], { mode: 0o755 });
  }

  return {
    root, home, bin, log,
    run(args, extra = {}, prelude = "") {
      const env = {
        HOME: home,
        OPSFY_HOME: path.join(home, ".opsfy"),
        PATH: bin,
        TMPDIR: root,
        NODE_OPTIONS: process.env.WLC_NODE_OPTIONS,
        WLC_READ_ROOT: process.env.WLC_READ_ROOT,
        FAKE_LOG: log,
        FAKE_MARKER: "inherited-by-installers",
        FAKE_SETUP_SCRIPT: setupScript,
        OPSFY_CATALOG: BUNDLED,
        OPSFY_API_BASE: "http://127.0.0.1:9",
        OPSFY_NO_COUNT: "1",
        OPSFY_PLATFORM: "darwin",
        ...extra,
      };
      env.KSC_LEGACY_COMMAND = args[0] || "";
      env.KSC_LEGACY_EXPECTED = JSON.stringify(env.KSC_EXPECT_PULLED === "1" && env.OPSFY_DRY_RUN !== "1"
        ? [[env.OPSFY_API_BASE.replace(/\/+$/, "") + "/api/pulled", "GET"]] : []);
      const nodeArgs = [
        "-e",
        `Date.now = () => 1790596800000; Math.random = () => 0.3141592653589793;
        require("node:crypto").randomBytes = n => Buffer.alloc(n, 73);
        globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          const allowed = JSON.parse(process.env.KSC_LEGACY_EXPECTED || "[]");
          if (!allowed.some(([url, method]) => request.url === url && request.method === method)) {
            throw new Error("unexpected fetch in test");
          }
          const atURL = response => {
            Object.defineProperty(response, "url", {value:request.url});
            const clone = response.clone.bind(response);
            response.clone = () => atURL(clone());
            return response;
          };
          return atURL(new Response('{"pulled":[]}', {status:200,
            headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}));
        };\n` +
        prelude + "\nprocess.argv = " + JSON.stringify([process.execPath, ENTRY, ...args]) +
          ";\nrequire(" + JSON.stringify(ENTRY) + ");",
      ];
      const stdoutFile = path.join(root, "stdout.txt");
      const stderrFile = path.join(root, "stderr.txt");
      const stdoutFd = fs.openSync(stdoutFile, "w");
      const stderrFd = fs.openSync(stderrFile, "w");
      let result;
      try {
        result = spawnSync(process.execPath, nodeArgs, {
          cwd: root, env, timeout: 15000, stdio: ["ignore", stdoutFd, stderrFd],
        });
      } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
      }
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const stderr = fs.readFileSync(stderrFile, "utf8");
      assert.ok(!stderr.includes("unexpected fetch in test"), stderr);
      return { ...result, stdout: fs.readFileSync(stdoutFile, "utf8"), stderr };
    },
    eligible(args, extra = {}, prelude = "") {
      return this.run(args, { ...extra, KSC_EXPECT_PULLED: "1" }, prelude);
    },
    calls() {
      const calls = [];
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (line.startsWith("CALL=")) calls.push({ command: line.slice(5), args: [] });
        else if (line.startsWith("ARG=")) calls[calls.length - 1].args.push(line.slice(4));
        else if (line.startsWith("CWD=")) calls[calls.length - 1].cwd = line.slice(4);
      }
      return calls;
    },
    reset() { fs.writeFileSync(log, ""); },
    catalog(tools, name = "custom.json") {
      const filename = path.join(root, name);
      fs.writeFileSync(filename, JSON.stringify({ tools }));
      return filename;
    },
  };
}

function tool(overrides = {}) {
  return {
    slug: "demo", name: "Demo", line: "A test app", url: "https://opsfy.ai/demo/",
    bucket: "free", install: { kind: "cask", cask: "demo" }, ...overrides,
  };
}

function check(result, status, stdout, stderr) {
  assert.equal(result.status, status, result.stderr);
  if (stdout !== undefined) assert.equal(result.stdout, stdout);
  if (stderr !== undefined) assert.equal(result.stderr, stderr);
}

function noInstall(w, result) {
  assert.deepEqual(w.calls(), []);
  assert.ok(!result.stderr.includes("/api/install"));
}

test("help and version aliases work without loading a catalogue or creating a cache", (t) => {
  const w = world(t);
  const expected = "opsfy 0.8.0 · one key and one balance for tools · the agents' guide: https://opsfy.ai/SKILL.md\n\n  opsfy list                     the library: pay as you go, one-command install, self-serve\n  opsfy find <words>             find a tool for a job\n  opsfy info <tool>              read its inputs and price\n  opsfy install <app>            install a free app on this Mac, from its upstream source\n  opsfy ask <tool>               ask for a tool; it shows on the wall at opsfy.ai\n  opsfy login --email <email>    send a login code to the email; then add --code <code>\n  opsfy key                      the account's email and the key's last four characters\n  opsfy key rotate               replace your key with a new one\n  opsfy logout                   log out; your key stops working\n  opsfy logout --all             stop every key on this account; then log in again\n  opsfy topup <amount>           start a top-up of $10, $25, $50, $100, $250 or $500; the person pays on a Stripe page\n  opsfy topup wait <id>          wait until a top-up is paid, cancelled or expired\n  opsfy topup status <id>        whether a top-up is open, paid, cancelled or expired\n  opsfy call <tool> \"<input>\"    call a tool; each call is paid from the balance\n    --input <name>=<value>       set an input; repeat for more inputs\n    --input-file <path|->        read a JSON object from a file or standard input\n  opsfy jobs                     this account's jobs; recover an id after a lost answer\n  opsfy job status <id>          check a job once\n  opsfy job wait <id>            wait up to 10 minutes; the job keeps running\n  opsfy job stop <id>            request a stop where the tool permits it\n  opsfy job result <id>          read the result while the company keeps it\n  opsfy logs                     the balance, then each top-up and call with its id, time and amount\n\n  --json                         one line of JSON on every command; use it always\n\nopsfy install works on a Mac today, Windows and Linux next, and never as root; the other commands work anywhere\n";
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    check(w.run(args, { OPSFY_CATALOG: path.join(w.root, "absent") }), 0, expected, "");
  }
  for (const alias of ["--version", "-v", "version"]) {
    check(w.run([alias]), 0, "0.8.0\n", "");
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("unknown commands and missing arguments use stderr and exit 2 without requests", (t) => {
  const w = world(t);
  const cases = [
    [["unknown"], "unknown_command: opsfy has no command unknown · run opsfy --help for the commands\n"],
    [["install"], "usage: no app named · run opsfy install <app> --json; opsfy list --json shows the apps\n"],
    [["ask"], "usage: no tool named · run opsfy ask \"<tool>\" --json\n"],
    [["call"], "usage: no tool named · run opsfy call <tool> \"<input>\" --json; opsfy find \"<job>\" --json gives the names\n"],
    [["login", "--email"], "usage: opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json\n"],
    [["login", "someone@somewhere.test"], "usage: opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json\n"],
    [["login", "--email", "a@b.co", "extra"], "usage: opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json\n"],
  ];
  for (const [args, stderr] of cases) check(w.run(args), 2, "", stderr);
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("the bundled list keeps bucket order and JSON preserves all catalogue fields", (t) => {
  const w = world(t);
  const result = w.run(["list"]);
  check(result, 0, undefined, "");
  const groups = result.stdout.trimEnd().split("\n\n");
  assert.equal(groups.length, 3);
  assert.equal(groups[0].split("\n")[0], "One-command install · opsfy install <app> --json");
  assert.equal(groups[1].split("\n")[0], "Pay as you go · opsfy call <tool> \"<input>\" --json");
  assert.equal(groups[2].split("\n")[0], "Self-serve · not in opsfy: the person gets each from its maker's site");
  assert.deepEqual(groups.map((group) => group.split("\n").length - 1), [6, 12, 23]);
  assert.ok(groups[0].startsWith("One-command install · opsfy install <app> --json\n  openwork            Your skills and MCPs in one place, for every agent\n"));
  assert.ok(groups[1].endsWith("\n  the price shows after login: run opsfy login --email <email> --json"));
  check(w.run(["list", "--json"]), 0, JSON.stringify({ ok: true, ...bundled, prices: "login_required" }) + "\n", "");
});

test("a local catalogue controls column widths and slug matches precede name matches", (t) => {
  const w = world(t);
  const filename = w.catalog([
    tool({ slug: "abc", name: "XYZ", install: { kind: "cask", cask: "first" } }),
    tool({ slug: "xyz", name: "B", install: { kind: "cask", cask: "second" } }),
  ]);
  const extra = { OPSFY_CATALOG: filename };
  check(w.run(["list"], extra), 0,
    "One-command install · opsfy install <app> --json\n  abc  A test app\n  xyz  A test app\n\n" +
    "Pay as you go · opsfy call <tool> \"<input>\" --json\n\nSelf-serve · not in opsfy: the person gets each from its maker's site\n", "");
  check(w.eligible(["install", "XYZ"], extra), 0);
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "second"] }]);
});

test("list strips catalogue prices and skips the lookup when no paid tool is open", (t) => {
  const w = world(t);
  const entries = [
    tool({ call: { unit: "run", price_microusd: 4321, later: true } }),
    tool({ slug: "later", bucket: "paid" }),
    tool({ slug: "self", bucket: "soon", call: { unit: "run", price_microusd: 4321 } }),
  ];
  const filename = w.catalog(entries), original = fs.readFileSync(filename, "utf8");
  const requested = path.join(w.root, "price-request.txt");
  const prelude = `let discoveryAnswered = false;
  globalThis.fetch = async (url, options) => {
    if (!discoveryAnswered && url === process.env.OPSFY_API_BASE + "/api/tools" &&
        options?.method === "GET" && options.redirect === "error" &&
        options.headers?.accept === "application/json" &&
        options.headers?.authorization === "Bearer " + process.env.OPSFY_API_KEY) {
      discoveryAnswered = true;
      const response = new Response(JSON.stringify({ ok: true, tools: [] }), {
        status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    require("node:fs").appendFileSync(${JSON.stringify(requested)}, JSON.stringify({ url, method: options?.method }) + "\\n");
    throw new Error("unexpected price request");
  };`;
  const extra = { OPSFY_CATALOG: filename, OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64) };
  check(w.run(["list"], extra, prelude), 0,
    "One-command install · opsfy install <app> --json\n  demo   A test app\n\n" +
    "Pay as you go · opsfy call <tool> \"<input>\" --json\n  later  A test app · not open yet\n\n" +
    "Self-serve · not in opsfy: the person gets each from its maker's site\n  self   A test app\n", "");
  const clean = [
    { ...entries[0], call: { unit: "run", later: true } }, entries[1],
    { ...entries[2], call: { unit: "run" } },
  ];
  check(w.run(["list", "--json"], extra, prelude), 0, JSON.stringify({ ok: true, tools: clean }) + "\n", "");
  assert.equal(fs.existsSync(requested), false);
  assert.equal(fs.readFileSync(filename, "utf8"), original);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("list shows only authenticated prices for the open tools named in the response", (t) => {
  const w = world(t);
  const entries = [
    tool({ slug: "searcher", bucket: "paid", call: { unit: "search", price_microusd: 4321 } }),
    tool({ slug: "constructor", bucket: "paid", call: { unit: "run", price_microusd: 4321 } }),
    tool({ slug: "closed", bucket: "paid" }),
    tool({ slug: "free", call: { unit: "run", price_microusd: 4321 } }),
  ];
  const filename = w.catalog(entries), original = fs.readFileSync(filename, "utf8");
  const requested = path.join(w.root, "price-request.txt");
  const prelude = `globalThis.fetch = async (url, options) => {
    const assert = require("node:assert/strict");
    assert.equal(url, "http://127.0.0.1:9/api/prices");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.headers.authorization === "Bearer " + process.env.OPSFY_API_KEY);
    require("node:fs").appendFileSync(${JSON.stringify(requested)}, "requested\\n");
    const response = new Response(JSON.stringify({ok: true, prices: {searcher: 12345, closed: 70000, free: 70000}}), {
      status: 200, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
    });
    Object.defineProperty(response, "url", {value: url});
    return response;
  };`;
  const extra = { OPSFY_CATALOG: filename, OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64) };
  check(w.run(["list"], extra, prelude), 0,
    "One-command install · opsfy install <app> --json\n  free         A test app\n\n" +
    "Pay as you go · opsfy call <tool> \"<input>\" --json\n  searcher     A test app · $0.012345 a search\n" +
    "  constructor  A test app\n  closed       A test app · not open yet\n\n" +
    "Self-serve · not in opsfy: the person gets each from its maker's site\n", "");
  const clean = [
    { ...entries[0], call: { unit: "search", price_microusd: 12345 } },
    { ...entries[1], call: { unit: "run" } }, entries[2], { ...entries[3], call: { unit: "run" } },
  ];
  check(w.run(["list", "--json"], extra, prelude), 0,
    JSON.stringify({ ok: true, tools: clean, prices: "shown" }) + "\n", "");
  assert.equal(fs.readFileSync(requested, "utf8"), "requested\nrequested\n");
  assert.equal(fs.readFileSync(filename, "utf8"), original);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("a pending login suppresses list prices without changing the saved files", (t) => {
  const w = world(t), directory = path.join(w.home, ".opsfy");
  const key = "opsfy_sk_" + "a".repeat(64), email = "pending@example.test";
  const fingerprint = require("node:crypto").createHash("sha256").update(key).digest("hex");
  const files = {
    key: key + "\n",
    account: JSON.stringify({ email, key_fingerprint: fingerprint }) + "\n",
    pending: JSON.stringify({ email, candidates: [key] }) + "\n",
  };
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  const requested = path.join(w.root, "price-request.txt");
  const prelude = `globalThis.fetch = async () => {
    require("node:fs").writeFileSync(${JSON.stringify(requested)}, "requested");
    throw new Error("unexpected price request");
  };`;
  const plain = w.run(["list"], {}, prelude);
  check(plain, 0, undefined, "");
  assert.ok(plain.stdout.includes("\n  the price shows after login: run opsfy login --email <email> --json\n"));
  assert.ok(!plain.stdout.includes("$"));
  check(w.run(["list", "--json"], {}, prelude), 0,
    JSON.stringify({ ok: true, ...bundled, prices: "login_required" }) + "\n", "");
  assert.equal(fs.existsSync(requested), false);
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(files).sort());
  for (const [name, content] of Object.entries(files)) assert.ok(fs.readFileSync(path.join(directory, name), "utf8") === content);
});

test("catalogue calls require a plain object and a nonempty unit without controls", () => {
  const { validates } = require("../lib/catalog.js");
  const custom = Object.assign(Object.create({}), { unit: "search" });
  for (const call of [null, [], {}, new Date(), custom, { unit: "" }, { unit: 4 },
    { unit: "se\u001barch" }, { unit: "se\u0085arch" }, { unit: "se\u200barch" }]) {
    assert.equal(validates({ tools: [tool({ call })] }), false);
  }
  for (const call of [{ unit: "search" }, { unit: "search", later: true }, Object.assign(Object.create(null), { unit: "search" })]) {
    assert.equal(validates({ tools: [tool({ call })] }), true);
  }
});

test("cask output stays ordered around inherited child output and preserves its environment", (t) => {
  const w = world(t);
  const result = w.eligible(["install", "OpenWork"], { FAKE_BREW_OUTPUT: "from the child" });
  check(result, 0, OPENWORK + "installing with Homebrew: brew install --cask openwork\n" +
    "from the child\n" + "install · installed · OpenWork" + "\n",
  "");
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "openwork"] }]);
  const log = fs.readFileSync(w.log, "utf8");
  assert.ok(log.includes("BREW_ENV=1,1\n"));
  assert.ok(log.includes("MARKER=inherited-by-installers\n"));
});

test("a case-insensitive name uses the catalogue's cask and the free licence fallback", (t) => {
  const w = world(t);
  const result = w.eligible(["install", "uNsLoTh DeSkToP"]);
  check(result, 0, "Unsloth Desktop · free · from the upstream release · unsloth.ai/docs/desktop\n" +
    "installing with Homebrew: brew install --cask unsloth\ninstall · installed · Unsloth Desktop\n",
  "");
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "unsloth"] }]);
});

test("a failed cask preserves the child status in its message", (t) => {
  const w = world(t);
  check(w.eligible(["install", "openwork"], { FAKE_BREW_EXIT: "3" }), 1,
    OPENWORK + "installing with Homebrew: brew install --cask openwork\n" +
    "install_failed: brew install --cask openwork stopped with exit code 3 · read Homebrew's message above, then run opsfy install openwork --json again" + "\n",
    "");
  assert.equal(w.calls().length, 1);
});

test("install counts can be disabled for both success and failure", (t) => {
  const w = world(t);
  for (const code of ["0", "8"]) {
    check(w.eligible(["install", "openwork"], { OPSFY_NO_COUNT: "1", FAKE_BREW_EXIT: code }),
      code === "0" ? 0 : 1, undefined, "");
  }
  assert.equal(w.calls().length, 2);
});

test("missing, nonexecutable and directory-shaped prerequisites never run", (t) => {
  const w = world(t, []);
  const expected = OPENWORK + "needs_homebrew: OpenWork installs with Homebrew, which is not on this Mac; nothing was changed · ask the person to install Homebrew from https://brew.sh, then run opsfy install openwork --json again\n";
  const brew = path.join(w.bin, "brew");
  for (const kind of ["absent", "file", "directory"]) {
    if (kind === "file") fs.writeFileSync(brew, fakeScripts.brew, { mode: 0o600 });
    if (kind === "directory") { fs.unlinkSync(brew); fs.mkdirSync(brew); }
    const result = w.eligible(["install", "openwork"]);
    check(result, 2, expected, "");
    noInstall(w, result);
  }
});

test("executable symlinks qualify for Homebrew and all git prerequisites without probes", (t) => {
  const w = world(t);
  for (const name of ["brew", "git", "bun", "claude"]) {
    const target = path.join(w.root, name + "-target");
    fs.renameSync(path.join(w.bin, name), target);
    fs.symlinkSync(target, path.join(w.bin, name));
  }
  check(w.eligible(["install", "openwork"]), 0);
  check(w.eligible(["install", "gstack"]), 0);
  assert.deepEqual(w.calls().map((call) => call.command), ["brew", "git", "setup"]);
});

test("git installs clone once, run setup in the target, and do nothing on a second install", (t) => {
  const w = world(t);
  const target = path.join(w.home, ".claude/skills/gstack");
  check(w.eligible(["install", "gstack"]), 0,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\n" +
    "install · installed · gstack · ~/.claude/skills/gstack" + "\n",
    "");
  assert.deepEqual(w.calls(), [
    { command: "git", args: ["clone", "--single-branch", "--depth", "1", "https://github.com/garrytan/gstack.git", target] },
    { command: "setup", args: [], cwd: fs.realpathSync(target) },
  ]);
  assert.equal(fs.readFileSync(w.log, "utf8").match(/MARKER=inherited-by-installers/g).length, 2);
  w.reset();
  const again = w.eligible(["install", "gstack"]);
  check(again, 0, GSTACK + "install · already installed · gstack · ~/.claude/skills/gstack\n", "");
  noInstall(w, again);
});

test("a failed clone does not attempt setup", (t) => {
  const w = world(t);
  check(w.eligible(["install", "gstack"], { FAKE_GIT_EXIT: "7" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\n" +
    "install_failed: git clone stopped with exit code 7; nothing was installed · read git's message above, then run opsfy install gstack --json again" + "\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git"]);
});

test("a failed setup reports failure after the successful clone", (t) => {
  const w = world(t);
  check(w.eligible(["install", "gstack"], { FAKE_SETUP_EXIT: "4" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\n" +
    "install_failed: ~/.claude/skills/gstack/setup stopped with exit code 4; the files are cloned in ~/.claude/skills/gstack · read the setup's message above, fix what it reports, then run ~/.claude/skills/gstack/setup" + "\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git", "setup"]);
});

test("a git recipe without setup or needs requires only Git and clones without setup", (t) => {
  const w = world(t, ["git"]);
  const filename = w.catalog([tool({ install: { kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/share/demo" } })]);
  check(w.eligible(["install", "demo"], { OPSFY_CATALOG: filename }), 0,
    "Demo · free · from the upstream repo · opsfy.ai/demo\ncloning into ~/.local/share/demo\n" +
    "install · installed · Demo · ~/.local/share/demo\n",
    "");
  assert.deepEqual(w.calls(), [{ command: "git", args: ["clone", "--single-branch", "--depth", "1",
    "https://github.com/example/demo", path.join(w.home, ".local/share/demo")] }]);
});

test("missing prerequisites are deduplicated, ordered and never probed", (t) => {
  const w = world(t, []);
  const result = w.eligible(["install", "gstack"]);
  check(result, 2, GSTACK + "missing_tools: gstack needs Git, Bun and Claude Code, and this Mac lacks Git, Bun and Claude Code; nothing was changed · ask the person to install Git (xcode-select --install), Bun (brew install oven-sh/bun/bun) and Claude Code (npm i -g @anthropic-ai/claude-code), then run opsfy install gstack --json again\n", "");
  noInstall(w, result);
  for (const name of ["git", "claude"]) fs.writeFileSync(path.join(w.bin, name), fakeScripts[name], { mode: 0o755 });
  check(w.eligible(["install", "gstack"]), 2, GSTACK +
    "missing_tools: gstack needs Git, Bun and Claude Code, and this Mac lacks Bun; nothing was changed · ask the person to install Bun (brew install oven-sh/bun/bun), then run opsfy install gstack --json again\n", "");
  assert.deepEqual(w.calls(), []);
});

test("malformed recipes still list but are refused before any installer or count", (t) => {
  const w = world(t);
  const git = { kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/demo" };
  const recipes = [
    undefined, null, [], "brew install demo", { kind: "command" }, { kind: "cask" },
    ...["--force", "a;echo injected", "../demo", "a\nb", "demo\n", "a b"].map((cask) => ({ kind: "cask", cask })),
    { ...git, repo: "https://example.com/demo" }, { ...git, repo: git.repo + ";x" },
    { ...git, dir: "/tmp/demo" }, { ...git, dir: "~/a/../demo" },
    { ...git, setup: "./other" }, { ...git, setup: null },
    { ...git, needs: ["other"] }, { ...git, needs: "git" },
  ];
  for (const install of recipes) {
    const filename = w.catalog([tool({ install })]);
    check(w.run(["list"], { OPSFY_CATALOG: filename }), 0);
    const result = w.run(["install", "demo"], { OPSFY_CATALOG: filename });
    check(result, 2, "update_needed: this opsfy (0.8.0) cannot install Demo · run npm i -g @opsfy/cli@latest, then run opsfy install demo --json again\n", "");
    noInstall(w, result);
  }
});

test("install refusals retain their JSON fields and use the checked platform and full tool URL", (t) => {
  const w = world(t, []);
  const cases = [
    ["openwork", "OpenWork", { OPSFY_PLATFORM: "linux" }, "", "unsupported_platform",
      "opsfy install works only on a Mac today, and this computer runs linux; nothing was changed · ask the person to install OpenWork from https://github.com/different-ai/openwork", {}],
    ["demo", "Demo", { OPSFY_CATALOG: w.catalog([tool({ install: undefined })]) }, "", "update_needed",
      "this opsfy (0.8.0) cannot install Demo · run npm i -g @opsfy/cli@latest, then run opsfy install demo --json again", {}],
    ["openwork", "OpenWork", {}, "process.geteuid = () => 0;", "runs_as_root",
      "opsfy install never runs as root; nothing was changed · run it again as the person's own user, without sudo", {}],
    ["openwork", "OpenWork", {}, "", "needs_homebrew",
      "OpenWork installs with Homebrew, which is not on this Mac; nothing was changed · ask the person to install Homebrew from https://brew.sh, then run opsfy install openwork --json again", {}],
    ["gstack", "gstack", {}, "", "missing_tools",
      "gstack needs Git, Bun and Claude Code, and this Mac lacks Git, Bun and Claude Code; nothing was changed · ask the person to install Git (xcode-select --install), Bun (brew install oven-sh/bun/bun) and Claude Code (npm i -g @anthropic-ai/claude-code), then run opsfy install gstack --json again",
      { missing: ["git", "bun", "claude"] }],
  ];
  for (const [slug, name, extra, prelude, error, message, fields] of cases) {
    const result = w.eligible(["install", slug, "--json"], extra, prelude);
    check(result, 2, JSON.stringify({ ok: false, error, message, tool: slug, name, ...fields }) + "\n", "");
    noInstall(w, result);
  }
  const result = w.run(["install", "demo"], {
    OPSFY_PLATFORM: undefined, OPSFY_CATALOG: w.catalog([tool()]),
  }, 'Object.defineProperty(process, "platform", { value: "win32" });');
  check(result, 2, "unsupported_platform: opsfy install works only on a Mac today, and this computer runs win32; nothing was changed · ask the person to install Demo from https://opsfy.ai/demo/\n", "");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("unavailable safety checks and pulled apps print one refusal in plain text and JSON", (t) => {
  const w = world(t);
  const cases = [
    ["safety_check_unavailable",
      "opsfy.ai could not be reached to check that OpenWork is safe to install; nothing was changed · wait 60 seconds, then run opsfy install openwork --json again",
      'throw new Error("offline fixture");'],
    ["pulled",
      'opsfy has stopped installs of OpenWork while it is checked; nothing was changed · run opsfy find "<job>" --json for another',
      'return new Response(JSON.stringify({ pulled: ["openwork"] }), { status: 200 });'],
  ];
  for (const [error, message, reply] of cases) {
    for (const json of [false, true]) {
      const result = w.run(["install", "openwork", ...(json ? ["--json"] : [])], {}, `
        globalThis.fetch = async (url, options) => {
          require("node:assert/strict").equal(url, "http://127.0.0.1:9/api/pulled");
          require("node:assert/strict").equal(options.method, "GET");
          ${reply}
        };
      `);
      check(result, 2, json
        ? JSON.stringify({ ok: false, error, message, tool: "openwork", name: "OpenWork" }) + "\n"
        : `${error}: ${message}\n`, "");
      noInstall(w, result);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("missing tool names and hints join two missing tools with and in plain text and JSON", (t) => {
  const w = world(t, ["claude"]);
  const message = "gstack needs Git, Bun and Claude Code, and this Mac lacks Git and Bun; nothing was changed · ask the person to install Git (xcode-select --install) and Bun (brew install oven-sh/bun/bun), then run opsfy install gstack --json again";
  for (const json of [false, true]) {
    const result = w.eligible(["install", "gstack", ...(json ? ["--json"] : [])]);
    check(result, 2, json
      ? JSON.stringify({ ok: false, error: "missing_tools", message, tool: "gstack", name: "gstack", missing: ["git", "bun"] }) + "\n"
      : GSTACK + `missing_tools: ${message}\n`, "");
    noInstall(w, result);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("installer outcomes preserve JSON success fields and failure steps and exit codes", (t) => {
  const cases = [
    ["openwork", "OpenWork", {}, { via: "homebrew" }],
    ["gstack", "gstack", {}, { via: "git", dir: "~/.claude/skills/gstack" }],
    ["openwork", "OpenWork", { FAKE_BREW_EXIT: "3" }, { step: "homebrew", exit_code: 3 },
      "brew install --cask openwork stopped with exit code 3 · read Homebrew's message above, then run opsfy install openwork --json again"],
    ["gstack", "gstack", { FAKE_GIT_EXIT: "7" }, { step: "git", exit_code: 7 },
      "git clone stopped with exit code 7; nothing was installed · read git's message above, then run opsfy install gstack --json again"],
    ["gstack", "gstack", { FAKE_SETUP_EXIT: "4" }, { step: "setup", exit_code: 4 },
      "~/.claude/skills/gstack/setup stopped with exit code 4; the files are cloned in ~/.claude/skills/gstack · read the setup's message above, fix what it reports, then run ~/.claude/skills/gstack/setup"],
  ];
  for (const [slug, name, extra, fields, message] of cases) {
    const w = world(t);
    const result = w.eligible(["install", slug, "--json"], extra);
    check(result, message ? 1 : 0, JSON.stringify(message
      ? { ok: false, error: "install_failed", message, tool: slug, name, ...fields }
      : { ok: true, status: "installed", tool: slug, name, ...fields }) + "\n", "");
    if (slug === "gstack" && !message) {
      w.reset();
      const again = w.eligible(["install", slug, "--json"]);
      check(again, 0, JSON.stringify({ ok: true, status: "already_installed", tool: slug, name, dir: "~/.claude/skills/gstack" }) + "\n", "");
      noInstall(w, again);
    }
  }
});

test("unknown, paid and coming-soon installs print their exact refusal without counting", (t) => {
  const w = world(t);
  const cases = [
    ["missing", "not_in_catalogue: missing is not in opsfy's library · run opsfy find \"<job>\" --json for one that is, or opsfy ask missing --json to ask for it\n"],
    ["elevenlabs", "paid_not_open: ElevenLabs is listed but not open yet; open now: tavily · run opsfy find \"<job>\" --json for another\n"],
    ["magpie", "not_installable: Magpie is self-serve, so opsfy cannot install or call it · ask the person to get it at https://usemagpie.app/\n"],
  ];
  for (const [name, output] of cases) {
    const result = w.run(["install", name]);
    check(result, 2, output, "");
    noInstall(w, result);
  }
});

test("invalid or missing catalogue overrides fail without fetching or creating a cache", (t) => {
  const w = world(t);
  const filename = path.join(w.root, "invalid.json");
  const variants = ["{broken", "null", "[]", '{"tools":"no"}', ...["slug", "name", "line", "url"].map((field) => {
    const entry = tool();
    entry[field] += "\x1b";
    return JSON.stringify({ tools: [entry] });
  })];
  for (const content of [undefined, ...variants]) {
    if (content !== undefined) fs.writeFileSync(filename, content);
    check(w.run(["list"], { OPSFY_CATALOG: filename }), 1, "", `internal: OPSFY_CATALOG names a file that is not an opsfy catalogue (${filename}) · fix the file or unset OPSFY_CATALOG, then run the same command again\n`);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("a fresh cache is used without fetching while a file override takes priority", (t) => {
  const w = world(t);
  const customHome = path.join(w.root, "cache-home");
  const directory = path.join(customHome, "cache");
  fs.mkdirSync(directory, { recursive: true });
  const cached = { tools: [tool({ slug: "cached" })] };
  fs.writeFileSync(path.join(directory, "tools.json"), JSON.stringify(cached));
  check(w.run(["list", "--json"], { OPSFY_HOME: customHome, OPSFY_CATALOG: undefined }),
    0, JSON.stringify({ ok: true, ...cached }) + "\n", "");
  check(w.run(["list", "--json"], { OPSFY_HOME: customHome }),
    0, JSON.stringify({ ok: true, ...bundled, prices: "login_required" }) + "\n", "");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("a stale cache is used after the dry-run refresh and is not rewritten", (t) => {
  const w = world(t);
  const directory = path.join(w.home, ".opsfy/cache");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "tools.json");
  const content = JSON.stringify({ tools: [tool({ slug: "old" })] });
  fs.writeFileSync(filename, content);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(filename, old, old);
  const mtime = fs.statSync(filename).mtimeMs;
  const result = w.run(["list", "--json"], {
    OPSFY_CATALOG: undefined, OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai",
  });
  check(result, 0, undefined, GET);
  assert.equal(JSON.parse(result.stdout).tools[0].slug, "old");
  assert.equal(fs.readFileSync(filename, "utf8"), content);
  assert.equal(fs.statSync(filename).mtimeMs, mtime);
});

test("invalid caches fall back to the embedded catalogue and remain untouched", (t) => {
  const w = world(t);
  const directory = path.join(w.home, ".opsfy/cache");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "tools.json");
  for (const content of ["{broken", '{"tools":false}', JSON.stringify({ tools: [tool({ name: "Bad\x1b]title\x07" })] })]) {
    fs.writeFileSync(filename, content);
    check(w.run(["list", "--json"], {
      OPSFY_CATALOG: undefined, OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai",
    }), 0, JSON.stringify({ ok: true, ...bundled, prices: "unavailable" }) + "\n", GET);
    assert.equal(fs.readFileSync(filename, "utf8"), content);
  }
});

test("the catalogue URL seam prints a GET without a trailing space and creates no home files", (t) => {
  const w = world(t);
  const result = w.run(["list"], {
    OPSFY_CATALOG: undefined, OPSFY_CATALOG_URL: "https://opsfy.ai/review.json",
    OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai",
  });
  check(result, 0, undefined, "OPSFY_DRY_RUN=1: would send GET https://opsfy.ai/review.json\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("ask joins and encodes words, accepts 120 characters, and refuses 121 unsent", (t) => {
  const w = world(t);
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai" };
  check(w.run(["ask", "Google", "Sheets", "&", "more"], extra), 0,
    "OPSFY_DRY_RUN=1 is set, so ask did not send Google Sheets & more · unset OPSFY_DRY_RUN to send it\n",
    "OPSFY_DRY_RUN=1: would send POST https://opsfy.ai/api/tool tool=Google%20Sheets%20%26%20more\n");
  check(w.run(["ask", "x".repeat(120)], extra), 0);
  check(w.run(["ask", "x".repeat(121)], extra), 2, "too_long: the name has 121 characters; the most is 120 · shorten it, then run opsfy ask again\n", "");
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("login validates addresses and posts only the encoded waitlist field", (t) => {
  const w = world(t);
  check(w.run(["login"]), 2, "", "email_needed: no email given · ask the person for their email, then run opsfy login --email <email> --json\n");
  check(w.run(["login", "--email", "a+b@c.co", "--code", "123456"], { OPSFY_DRY_RUN: "1" }),
    2, "", "dry_run: OPSFY_DRY_RUN=1 is set, so login does not run · unset OPSFY_DRY_RUN to run it\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
  for (const address of ["nope", "@b.co", "a b@c.co", "a@b", "a@b@c.co"]) {
    check(w.run(["login", "--email", address]), 2, "", "invalid_email: that is not a valid email address · ask the person for their email again, then run opsfy login --email <email> --json\n");
  }
  const reply = `
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const fields = [...new URLSearchParams(await request.text())];
      const verify = request.url.endsWith("/api/login");
      const expected = verify
        ? [["email", "a+b@c.co"], ["code", "123456"], ["key_fingerprint",
          require("node:crypto").createHash("sha256").update("opsfy_sk_" + "49".repeat(32)).digest("hex")]]
        : [["email", "a+b@c.co"]];
      if (request.url !== "http://127.0.0.1:9/api/" + (verify ? "login" : "login-code") ||
          request.method !== "POST" || request.headers.has("authorization") ||
          request.headers.get("content-type") !== "application/x-www-form-urlencoded" ||
          JSON.stringify(fields) !== JSON.stringify(expected)) throw new Error("auth request contract differed");
      const body = verify ? {ok:true, email:"a+b@c.co", key_fingerprint:expected[2][1]} : {ok:true, expires_in:600};
      const response = new Response(JSON.stringify(body), {status:verify ? 200 : 202,
        headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}});
      Object.defineProperty(response, "url", {value:request.url});
      return response;
    };
  `;
  check(w.run(["login", "--email", " A+B@C.CO "], {}, reply), 0,
    "login · code sent to a+b@c.co; it works for 10 minutes and 5 tries · ask the person for the 6-digit code, then run opsfy login --email a+b@c.co --code <code> --json\n", "");
  const directory = path.join(w.home, ".opsfy");
  assert.equal(fs.existsSync(path.join(directory, "key")), false);
  check(w.run(["login", "--code", "123-456", "--email", " A+B@C.CO "], {}, reply), 0,
    "login · logged in as a+b@c.co · the key is saved in ~/.opsfy/\n", "");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["account", "key"]);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "key")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "account"), "utf8")).email, "a+b@c.co");
  assert.deepEqual(w.calls(), []);
});

test("call uses the part before the first dot and logs makes no request", (t) => {
  const w = world(t);
  const cases = [
    ["elevenlabs.speak", "paid_not_open: ElevenLabs is listed but not open yet; open now: tavily · run opsfy find \"<job>\" --json for another\n"],
    ["OpenWork.run", "use_install: OpenWork is a free app: it is installed, not called · run opsfy install openwork --json\n"],
    ["qoder.run", "not_installable: Qoder is self-serve, so opsfy cannot install or call it · ask the person to get it at https://qoder.com/\n"],
    ["missing.run", "not_in_catalogue: missing.run is not in opsfy's library · run opsfy find \"<job>\" --json for one that is, or opsfy ask missing.run --json to ask for it\n"],
  ];
  for (const [name, output] of cases) check(w.run(["call", name, "payload"]), 2, output, "");
  check(w.run(["logs"]), 2, "", "not_logged_in: no key on this computer, and OPSFY_API_KEY is not set · ask the person for their email, then run opsfy login --email <email> --json\n");
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), [".opsfy"]);
});

test("geteuid root is refused before either recipe branch, including OPSFY_DRY_RUN", (t) => {
  const w = world(t);
  for (const slug of ["openwork", "gstack"]) {
    for (const dryRun of [undefined, "1"]) {
      const result = w.run(["install", slug], { OPSFY_DRY_RUN: dryRun, OPSFY_NO_COUNT: "1" },
        "process.geteuid = () => 0;");
      check(result, 2, "runs_as_root: opsfy install never runs as root; nothing was changed · run it again as the person's own user, without sudo" + "\n", "");
      noInstall(w, result);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("signal deaths and processes that cannot start report status 1", (t) => {
  const w = world(t);
  const expected = OPENWORK + "installing with Homebrew: brew install --cask openwork\ninstall_failed: brew install --cask openwork stopped with exit code 1 · read Homebrew's message above, then run opsfy install openwork --json again\n";
  check(w.eligible(["install", "openwork"], { FAKE_SIGNAL: "brew" }), 1, expected, "");
  assert.equal(w.calls().length, 1);
  w.reset();
  fs.writeFileSync(path.join(w.bin, "brew"), "#!/no-such-opsfy-interpreter\n", { mode: 0o755 });
  check(w.eligible(["install", "openwork"]), 1, expected, "");
  assert.deepEqual(w.calls(), []);
});

test("OPSFY_DRY_RUN previews a cask without installers, home changes or install counts", (t) => {
  const w = world(t);
  const result = w.run(["install", "openwork"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" });
  check(result, 0, OPENWORK + "OPSFY_DRY_RUN=1 is set, so install did not run; it would run: brew install --cask openwork · unset OPSFY_DRY_RUN to install\n",
    "OPSFY_DRY_RUN=1: would send GET http://127.0.0.1:9/api/pulled\n");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN previews a git clone and setup without creating the target or counting", (t) => {
  const w = world(t);
  const result = w.run(["install", "gstack"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" });
  check(result, 0, GSTACK +
    "OPSFY_DRY_RUN=1 is set, so install did not run; it would run: git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack, then ~/.claude/skills/gstack/setup · unset OPSFY_DRY_RUN to install\n",
    "OPSFY_DRY_RUN=1: would send GET http://127.0.0.1:9/api/pulled\n");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN does not promise setup when the git recipe has none", (t) => {
  const w = world(t, ["git"]);
  const filename = w.catalog([tool({ install: {
    kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/share/demo",
  } })]);
  const result = w.run(["install", "demo"], {
    OPSFY_CATALOG: filename, OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0",
  });
  check(result, 0, "Demo · free · from the upstream repo · opsfy.ai/demo\n" +
    "OPSFY_DRY_RUN=1 is set, so install did not run; it would run: git clone --single-branch --depth 1 https://github.com/example/demo ~/.local/share/demo · unset OPSFY_DRY_RUN to install\n",
    "OPSFY_DRY_RUN=1: would send GET http://127.0.0.1:9/api/pulled\n");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN preserves platform, recipe and prerequisite refusals", (t) => {
  const w = world(t, []);
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" };
  const cases = [
    [["install", "openwork"], { OPSFY_PLATFORM: "linux" },
      "unsupported_platform: opsfy install works only on a Mac today, and this computer runs linux; nothing was changed · ask the person to install OpenWork from https://github.com/different-ai/openwork\n"],
    [["install", "demo"], { OPSFY_CATALOG: w.catalog([tool({ install: undefined })]) },
      "update_needed: this opsfy (0.8.0) cannot install Demo · run npm i -g @opsfy/cli@latest, then run opsfy install demo --json again\n"],
    [["install", "openwork"], {}, OPENWORK +
      "needs_homebrew: OpenWork installs with Homebrew, which is not on this Mac; nothing was changed · ask the person to install Homebrew from https://brew.sh, then run opsfy install openwork --json again\n"],
    [["install", "gstack"], {}, GSTACK +
      "missing_tools: gstack needs Git, Bun and Claude Code, and this Mac lacks Git, Bun and Claude Code; nothing was changed · ask the person to install Git (xcode-select --install), Bun (brew install oven-sh/bun/bun) and Claude Code (npm i -g @anthropic-ai/claude-code), then run opsfy install gstack --json again\n"],
  ];
  for (const [args, overrides, expected] of cases) {
    const result = w.run(args, { ...extra, ...overrides });
    const gets = !overrides.OPSFY_PLATFORM && !overrides.OPSFY_CATALOG;
    check(result, 2, expected, gets ? "OPSFY_DRY_RUN=1: would send GET http://127.0.0.1:9/api/pulled\n" : "");
    noInstall(w, result);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("dry-run installs preserve JSON commands with and without a repo setup", (t) => {
  const w = world(t);
  const cases = [
    ["openwork", "OpenWork", {}, ["brew install --cask openwork"]],
    ["gstack", "gstack", {}, ["git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack", "~/.claude/skills/gstack/setup"]],
    ["demo", "Demo", { OPSFY_CATALOG: w.catalog([tool({ install: {
      kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/share/demo",
    } })]) }, ["git clone --single-branch --depth 1 https://github.com/example/demo ~/.local/share/demo"]],
  ];
  for (const [slug, name, extra, would_run] of cases) {
    const result = w.run(["install", slug, "--json"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0", ...extra });
    check(result, 0, JSON.stringify({ ok: true, status: "dry_run", tool: slug, name, would_run }) + "\n",
      "OPSFY_DRY_RUN=1: would send GET http://127.0.0.1:9/api/pulled\n");
    noInstall(w, result);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("install counts send each slug and outcome once using a dry count at the seam", (t) => {
  const cases = [
    ["openwork", {}, true], ["openwork", { FAKE_BREW_EXIT: "3" }, false],
    ["gstack", {}, true], ["gstack", { FAKE_GIT_EXIT: "7" }, false],
    ["gstack", { FAKE_SETUP_EXIT: "4" }, false],
  ];
  for (const base of ["http://127.0.0.1:9", "http://localhost:9///"]) {
    for (const [slug, extra, ok] of cases) {
      const w = world(t);
      const prelude = `
        const api = require(${JSON.stringify(path.resolve(__dirname, "../lib/api.js"))});
        const originalCount = api.count;
        api.count = async (...args) => {
          process.env.OPSFY_DRY_RUN = "1";
          process.env.OPSFY_NO_COUNT = "0";
          try { await originalCount(...args); }
          finally { delete process.env.OPSFY_DRY_RUN; process.env.OPSFY_NO_COUNT = "1"; }
        };
      `;
      const result = w.eligible(["install", slug], { OPSFY_API_BASE: base, ...extra }, prelude);
      check(result, ok ? 0 : 1, undefined,
        `OPSFY_DRY_RUN=1: would send POST ${base.replace(/\/+$/, "")}/api/install tool=${slug}&ok=${ok ? "1" : "0"}\n`);
    }
  }
});

test("OPSFY_API_BASE moves catalogue, ask and login endpoints and trims trailing slashes", (t) => {
  const w = world(t);
  const extra = { OPSFY_API_BASE: "https://staging.opsfy.ai///", OPSFY_DRY_RUN: "1" };
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined }), 0,
    JSON.stringify({ ok: true, ...bundled, prices: "unavailable" }) + "\n", "OPSFY_DRY_RUN=1: would send GET https://staging.opsfy.ai/tools.json\n");
  check(w.run(["ask", "Sheets"], extra), 0,
    "OPSFY_DRY_RUN=1 is set, so ask did not send Sheets · unset OPSFY_DRY_RUN to send it\n",
    "OPSFY_DRY_RUN=1: would send POST https://staging.opsfy.ai/api/tool tool=Sheets\n");
  check(w.run(["login", "--email", "a+b@c.co"], extra), 2, "",
    "dry_run: OPSFY_DRY_RUN=1 is set, so login does not run · unset OPSFY_DRY_RUN to run it\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("OPSFY_API_BASE defaults when unset or empty and accepts HTTPS and exact loopback hosts", (t) => {
  const w = world(t);
  const cases = [
    [undefined, "https://opsfy.ai"],
    ["", "https://opsfy.ai"],
    ["https://example.test:8443/service///", "https://example.test:8443/service"],
    ["http://localhost", "http://localhost"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.0.0.1:8787///", "http://127.0.0.1:8787"],
    ["http://[::1]", "http://[::1]"],
    ["http://[::1]:8787/", "http://[::1]:8787"],
  ];
  for (const [base, expected] of cases) {
    check(w.run(["ask", "x"], { OPSFY_API_BASE: base, OPSFY_DRY_RUN: "1" }), 0,
      "OPSFY_DRY_RUN=1 is set, so ask did not send x · unset OPSFY_DRY_RUN to send it\n",
      `OPSFY_DRY_RUN=1: would send POST ${expected}/api/tool tool=x\n`);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_API_BASE rejects unsafe and malformed URLs before dispatching every command", (t) => {
  const w = world(t);
  const refused = [
    "http://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example",
    "http://localhost@evil.example", "http://[::1]@evil.example", "ftp://opsfy.ai",
    "file:///tmp/demo", "not-a-url", "https://", "https:opsfy.ai", "//opsfy.ai", "http://localhost:bad",
  ];
  const commands = [
    [], ["help"], ["--help"], ["-h"], ["--version"], ["-v"], ["version"],
    ["list"], ["install", "openwork"], ["ask", "x"], ["login"],
    ["login", "--email", "a@b.co"], ["call", "openwork"], ["logs"], ["unknown"],
  ];
  for (const base of refused) {
    check(w.run(["ask", "x"], { OPSFY_API_BASE: base, OPSFY_DRY_RUN: "1" }), 2, "",
      "bad_api_base: OPSFY_API_BASE must be https (or http on localhost) with no username, password, query or fragment · unset OPSFY_API_BASE to use https://opsfy.ai\n");
  }
  for (const args of commands) {
    check(w.run(args, {
      OPSFY_API_BASE: "http://evil.example", OPSFY_CATALOG: path.join(w.root, "absent"),
      OPSFY_NO_COUNT: "1", OPSFY_DRY_RUN: "1",
    }), 2, "", "bad_api_base: OPSFY_API_BASE must be https (or http on localhost) with no username, password, query or fragment · unset OPSFY_API_BASE to use https://opsfy.ai\n");
  }
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("list, find, info, install and ask reject credentials, queries, fragments and whitespace in the API base", (t) => {
  const w = world(t);
  const message = "OPSFY_API_BASE must be https (or http on localhost) with no username, password, query or fragment · unset OPSFY_API_BASE to use https://opsfy.ai";
  const refused = [
    "https://user@example.com", "https://:password@example.com", "http://user:password@localhost",
    "https://example.com/?key=value", "https://example.com/?", "https://example.com/#part", "https://example.com/#",
    " https://example.com", "https://example.com/ ", "https://exam\tple.com",
  ];
  for (const base of refused) {
    for (const args of [["list"], ["find", "web"], ["info", "tavily"], ["install", "openwork"], ["ask", "x"]]) {
      for (const json of [false, true]) {
        const result = w.run([...args, ...(json ? ["--json"] : [])], { OPSFY_API_BASE: base });
        check(result, 2, json ? JSON.stringify({ ok: false, error: "bad_api_base", message }) + "\n" : "",
          json ? "" : `bad_api_base: ${message}\n`);
        noInstall(w, result);
      }
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_CATALOG beats OPSFY_CATALOG_URL, which beats OPSFY_API_BASE", (t) => {
  const w = world(t);
  const custom = [tool()];
  const extra = {
    OPSFY_CATALOG: w.catalog(custom), OPSFY_CATALOG_URL: "https://catalog.example.test/review.json",
    OPSFY_API_BASE: "https://staging.opsfy.ai", OPSFY_DRY_RUN: "1",
  };
  check(w.run(["list", "--json"], extra), 0, JSON.stringify({ ok: true, tools: custom }) + "\n", "");
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined }), 0,
    JSON.stringify({ ok: true, ...bundled, prices: "unavailable" }) + "\n", "OPSFY_DRY_RUN=1: would send GET https://catalog.example.test/review.json\n");
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined, OPSFY_CATALOG_URL: undefined }), 0,
    JSON.stringify({ ok: true, ...bundled, prices: "unavailable" }) + "\n", "OPSFY_DRY_RUN=1: would send GET https://staging.opsfy.ai/tools.json\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

require("./wallet.test.js");

function capturedInstall(w, args = ["install", "openwork"], extra = {}, prelude = "") {
  const filename = path.join(w.root, "install-counts.json");
  fs.writeFileSync(filename, "[]");
  const result = w.eligible(args, { OPSFY_NO_COUNT: "0", ...extra }, `
    const countFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const base = process.env.OPSFY_API_BASE.replace(/\\/+$/, "");
      if (request.url === base + "/api/install" && request.method === "POST") {
        const fs = require("node:fs"), filename = ${JSON.stringify(filename)};
        const counts = JSON.parse(fs.readFileSync(filename, "utf8"));
        counts.push(await request.text());
        fs.writeFileSync(filename, JSON.stringify(counts));
        return new Response("", { status: Number(process.env.INSTALL_COUNT_STATUS || "200") });
      }
      return countFetch(input, init);
    };
    ${prelude}
  `);
  return { result, counts: JSON.parse(fs.readFileSync(filename, "utf8")) };
}

test("counted installs create one private id and reuse it without changing install results", (t) => {
  const w = world(t), directory = path.join(w.home, ".opsfy"), filename = path.join(directory, "id");
  const id = "49".repeat(16);
  let before;
  for (const [exit, status] of [["0", "200"], ["3", "200"], ["0", "503"]]) {
    const { result, counts } = capturedInstall(w, undefined, { FAKE_BREW_EXIT: exit, INSTALL_COUNT_STATUS: status });
    check(result, exit === "0" ? 0 : 1, OPENWORK + "installing with Homebrew: brew install --cask openwork\n" +
      (exit === "0" ? "install · installed · OpenWork\n" : "install_failed: brew install --cask openwork stopped with exit code 3 · read Homebrew's message above, then run opsfy install openwork --json again\n"), "");
    assert.deepEqual(counts, [`tool=openwork&ok=${exit === "0" ? "1" : "0"}&install_id=${id}`]);
    assert.equal(fs.readFileSync(filename, "utf8"), id + "\n");
    const current = fs.statSync(filename);
    assert.equal(current.size, 33);
    assert.equal(current.mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(directory), ["id"]);
    if (before) {
      assert.equal(current.ino, before.ino);
      assert.equal(current.mtimeMs, before.mtimeMs);
    }
    before = current;
  }
});

test("install ids use every random byte at call time and rotate after deleting only id", (t) => {
  const w = world(t), directory = path.join(w.root, "count-home"), filename = path.join(directory, "id");
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "notes.txt"), "keep me\n");
  for (const seed of [11, 19]) {
    const bytes = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + seed) & 255));
    const { result, counts } = capturedInstall(w, undefined, { OPSFY_HOME: "count-home" }, `
      require(${JSON.stringify(path.resolve(__dirname, "../lib/install-id.js"))});
      require("node:crypto").randomBytes = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + ${seed}) & 255));
    `);
    check(result, 0, undefined, "");
    assert.deepEqual(counts, ["tool=openwork&ok=1&install_id=" + bytes.toString("hex")]);
    assert.equal(fs.readFileSync(filename, "utf8"), bytes.toString("hex") + "\n");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["id", "notes.txt"]);
    assert.equal(fs.readFileSync(path.join(directory, "notes.txt"), "utf8"), "keep me\n");
    fs.unlinkSync(filename);
  }
});

test("existing install ids are used or omitted without repairing files or following links", (t) => {
  const valid = "ab".repeat(16) + "\n";
  for (const content of [valid, "AB".repeat(16) + "\n", "gg".repeat(16) + "\n", valid + "\n", "symlink", "directory"]) {
    const w = world(t), directory = path.join(w.home, ".opsfy"), filename = path.join(directory, "id");
    fs.mkdirSync(directory, { mode: 0o755 });
    const target = path.join(w.root, "target");
    fs.writeFileSync(target, valid);
    if (content === "symlink") fs.symlinkSync(target, filename);
    else if (content === "directory") fs.mkdirSync(filename);
    else fs.writeFileSync(filename, content, { mode: 0o644 });
    const before = fs.lstatSync(filename);
    const { result, counts } = capturedInstall(w);
    check(result, 0, undefined, "");
    assert.deepEqual(counts, ["tool=openwork&ok=1" + (content === valid ? "&install_id=" + valid.trim() : "")]);
    const after = fs.lstatSync(filename);
    for (const field of ["ino", "size", "mtimeMs", "mode"]) assert.equal(after[field], before[field]);
    if (content === "symlink") assert.equal(fs.readlinkSync(filename), target);
    else if (content !== "directory") assert.equal(fs.readFileSync(filename, "utf8"), content);
    assert.equal(fs.readFileSync(target, "utf8"), valid);
    assert.deepEqual(fs.readdirSync(directory), ["id"]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  }
});

test("short install-id writes finish before publication", (t) => {
  const w = world(t);
  const { result, counts } = capturedInstall(w, undefined, {}, `
    const idfs = require("node:fs"), open = idfs.openSync, close = idfs.closeSync, write = idfs.writeSync;
    let temporaryFd;
    idfs.openSync = function (filename, ...args) {
      const fd = open.call(this, filename, ...args);
      if (require("node:path").basename(filename).startsWith(".id-")) temporaryFd = fd;
      return fd;
    };
    idfs.closeSync = function (fd) {
      if (fd === temporaryFd) temporaryFd = undefined;
      return close.call(this, fd);
    };
    idfs.writeSync = function (...args) {
      if (args[0] === temporaryFd) args[3] = Math.min(args[3], 7);
      return write.apply(this, args);
    };
  `);
  check(result, 0, undefined, "");
  const directory = path.join(w.home, ".opsfy"), id = "49".repeat(16);
  assert.deepEqual(counts, ["tool=openwork&ok=1&install_id=" + id]);
  assert.equal(fs.readFileSync(path.join(directory, "id"), "utf8"), id + "\n");
  assert.deepEqual(fs.readdirSync(directory), ["id"]);
});

test("install-id write, sync, close and link failures keep plain counts and clean up", (t) => {
  for (const operation of ["writeSync", "zeroWrite", "fsyncSync", "closeSync", "linkSync"]) {
    const w = world(t);
    const { result, counts } = capturedInstall(w, undefined, {}, `
      const idfs = require("node:fs"), open = idfs.openSync;
      let temporaryFd, failed = false;
      idfs.openSync = function (filename, ...args) {
        const fd = open.call(this, filename, ...args);
        if (require("node:path").basename(filename).startsWith(".id-")) temporaryFd = fd;
        return fd;
      };
      const operation = ${JSON.stringify(operation)}, name = operation === "zeroWrite" ? "writeSync" : operation;
      const original = idfs[name];
      idfs[name] = function (...args) {
        if (!failed && ((name === "linkSync" && require("node:path").basename(args[0]).startsWith(".id-")) || args[0] === temporaryFd)) {
          failed = true;
          if (operation === "zeroWrite") return 0;
          if (name === "closeSync") { original.apply(this, args); temporaryFd = undefined; }
          throw Object.assign(new Error("injected id failure"), { code: "EIO" });
        }
        return original.apply(this, args);
      };
    `);
    check(result, 0, undefined, "");
    assert.deepEqual(counts, ["tool=openwork&ok=1"], operation);
    assert.deepEqual(fs.readdirSync(path.join(w.home, ".opsfy")), [], operation);
  }
});

test("failed temporary-id cleanup is silent and later counts reuse only id", (t) => {
  const w = world(t), directory = path.join(w.home, ".opsfy");
  const { result, counts } = capturedInstall(w, undefined, {}, `
    const idfs = require("node:fs"), unlink = idfs.unlinkSync;
    idfs.unlinkSync = function (filename, ...args) {
      if (require("node:path").basename(filename).startsWith(".id-")) {
        throw Object.assign(new Error("injected cleanup failure"), { code: "EACCES" });
      }
      return unlink.call(this, filename, ...args);
    };
  `);
  check(result, 0, undefined, "");
  assert.deepEqual(counts, ["tool=openwork&ok=1&install_id=" + "49".repeat(16)]);
  const entries = fs.readdirSync(directory).sort();
  assert.equal(entries.length, 2);
  assert.ok(entries[0].startsWith(".id-"));
  assert.equal(entries[1], "id");
  const again = capturedInstall(w);
  check(again.result, 0, undefined, "");
  assert.deepEqual(again.counts, counts);
  assert.deepEqual(fs.readdirSync(directory).sort(), entries);
});

test("opt-out and dry counts never inspect an absent, valid or invalid install id", (t) => {
  for (const content of [null, "ab".repeat(16) + "\n", "gg".repeat(16) + "\n"]) {
    for (const dry of [false, true]) {
      const w = world(t), directory = path.join(w.home, ".opsfy"), filename = path.join(directory, "id");
      if (content !== null) {
        fs.mkdirSync(directory);
        fs.writeFileSync(filename, content);
      }
      const touched = path.join(w.root, "id-touched.txt");
      const { result, counts } = capturedInstall(w, undefined, { OPSFY_NO_COUNT: dry ? "0" : "1" }, `
        const idfs = require("node:fs");
        for (const name of ["lstatSync", "openSync", "readFileSync", "mkdirSync"]) {
          const original = idfs[name];
          idfs[name] = function (filename, ...args) {
            if (typeof filename === "string" && (filename === ${JSON.stringify(directory)} ||
                filename.startsWith(${JSON.stringify(directory + path.sep)}))) {
              idfs.writeFileSync(${JSON.stringify(touched)}, name);
            }
            return original.call(this, filename, ...args);
          };
        }
        if (${dry}) {
          const api = require(${JSON.stringify(path.resolve(__dirname, "../lib/api.js"))});
          const count = api.count;
          api.count = async (...args) => {
            process.env.OPSFY_DRY_RUN = "1";
            try { await count(...args); } finally { delete process.env.OPSFY_DRY_RUN; }
          };
        }
      `);
      check(result, 0, undefined, dry ? "OPSFY_DRY_RUN=1: would send POST http://127.0.0.1:9/api/install tool=openwork&ok=1\n" : "");
      assert.deepEqual(counts, []);
      assert.equal(fs.existsSync(touched), false);
      if (content === null) assert.equal(fs.existsSync(directory), false);
      else assert.equal(fs.readFileSync(filename, "utf8"), content);
    }
  }
});

test("global JSON flags are removed before commands and values while similar tokens remain", (t) => {
  const w = world(t);
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai" };
  for (const args of [["--json", "ask", "Sheets"], ["ask", "--json", "Sheets", "--json"]]) {
    check(w.run(args, extra), 0, '{"ok":true,"status":"dry_run","tool":"Sheets"}\n',
      "OPSFY_DRY_RUN=1: would send POST https://opsfy.ai/api/tool tool=Sheets\n");
  }
  for (const token of ["--JSON", "--json=1", "-j"]) {
    const name = "Sheets " + token;
    check(w.run(["ask", "Sheets", token, "--json"], extra), 0,
      JSON.stringify({ ok: true, status: "dry_run", tool: name }) + "\n",
      "OPSFY_DRY_RUN=1: would send POST https://opsfy.ai/api/tool tool=" + encodeURIComponent(name) + "\n");
  }
  check(w.run(["login", "--email", "--json"]), 2,
    JSON.stringify({ ok: false, error: "usage", message: "opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json" }) + "\n", "");
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("JSON keeps ok first and completes UTF-8 output after short writes and pipe interruptions", (t) => {
  const w = world(t), filename = w.catalog([]);
  fs.writeFileSync(filename, JSON.stringify({ "0": "metadata", ok: false, note: "é🛠\ntext", tools: [] }));
  const result = w.run(["list", "--json"], { OPSFY_CATALOG: filename }, `
    const outputFS = require("node:fs"), originalWrite = outputFS.writeSync;
    let attempts = 0;
    outputFS.writeSync = function (fd, buffer, offset, length, position) {
      if (fd === 1) {
        attempts++;
        if (attempts === 1 || attempts === 2 || attempts === 4) {
          throw Object.assign(new Error("injected pipe interruption"), { code: attempts === 1 ? "EINTR" : "EAGAIN" });
        }
        if (attempts === 3) return 0;
        return originalWrite.call(this, fd, buffer, offset, Math.min(length, 3), position);
      }
      return originalWrite.apply(this, arguments);
    };
  `);
  check(result, 0, '{"ok":true,"0":"metadata","note":"é🛠\\ntext","tools":[]}\n', "");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("plain failures lead with their code once and JSON retains its fields", () => {
  const { Answer } = require("../lib/answer.js");
  const printed = [], answer = new Answer();
  for (const message of ["opsfy logs [--json]", "usage: opsfy logs [--json]"]) {
    answer.failure("usage", message, {}, value => printed.push(value));
  }
  answer.failure("invalid_amount", "choose $10", {}, value => printed.push(value));
  assert.deepEqual(printed, ["usage: opsfy logs [--json]", "usage: opsfy logs [--json]", "invalid_amount: choose $10"]);
  const structured = new Answer(true), values = [];
  structured.write = value => values.push(value);
  structured.failure("invalid_amount", "choose $10", { amount: 7 }, () => assert.fail("plain output in JSON mode"));
  assert.deepEqual(values, [{ ok: false, error: "invalid_amount", message: "choose $10", amount: 7 }]);
});

test("JSON help aliases keep the complete plain guide without its final newline", t => {
  const w = world(t), extra = { OPSFY_CATALOG: path.join(w.root, "absent") };
  const help = w.run(["--help"], extra).stdout.slice(0, -1);
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    check(w.run([...args, "--json"], extra), 0, JSON.stringify({ ok: true, help }) + "\n", "");
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("library refusals preserve their fields and stdout in plain text and JSON", t => {
  const w = world(t);
  const cases = [
    ...["info", "install", "call"].map(command => [[command, "Missing Tool"], "not_in_catalogue",
      'Missing Tool is not in opsfy\'s library · run opsfy find "<job>" --json for one that is, or opsfy ask Missing Tool --json to ask for it',
      { tool: "Missing Tool" }]),
    ...["install", "call"].map(command => [[command, "Magpie"], "not_installable",
      "Magpie is self-serve, so opsfy cannot install or call it · ask the person to get it at https://usemagpie.app/",
      { tool: "magpie", name: "Magpie", url: "https://usemagpie.app/" }]),
    [["call", "OpenWork"], "use_install", "OpenWork is a free app: it is installed, not called · run opsfy install openwork --json",
      { tool: "openwork", name: "OpenWork", command: "opsfy install openwork" }],
  ];
  for (const [args, error, message, fields] of cases) {
    for (const json of [false, true]) {
      const result = w.run([...args, ...(json ? ["--json"] : [])]);
      check(result, 2, json ? JSON.stringify({ ok: false, error, message, ...fields }) + "\n" : `${error}: ${message}\n`, "");
      noInstall(w, result);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("installing an open paid tool uses use_call with its known main input or the input fallback", t => {
  const w = world(t);
  const entries = [
    tool({ slug: "tavily", name: "Tavily", bucket: "paid", call: { unit: "search" } }),
    tool({ slug: "fixture", name: "Fixture Tool", bucket: "paid", call: { unit: "render" } }),
    tool({ slug: "constructor", name: "Other Search", bucket: "paid", call: { unit: "search" } }),
    tool({ slug: "named-only", name: "Named Inputs", bucket: "paid", call: { unit: "run" } }),
  ];
  const extra = { OPSFY_CATALOG: w.catalog(entries) };
  const prelude = `const descriptors = require(${JSON.stringify(path.resolve(__dirname, "../lib/tool-inputs.js"))}).tools;
    descriptors.fixture = { main_input: "prompt" };
    descriptors["named-only"] = { main_input: null };`;
  for (const [entry, main] of entries.map((entry, index) => [entry, ["question", "prompt", "input", "input"][index]])) {
    const message = `${entry.name} is pay as you go: it is called, not installed · run opsfy call ${entry.slug} "<${main}>" --json`;
    for (const argument of [entry.slug.toUpperCase(), entry.name]) {
      for (const json of [false, true]) {
        const result = w.run(["install", argument, ...(json ? ["--json"] : [])], extra, prelude);
        check(result, 2, json ? JSON.stringify({ ok: false, error: "use_call", message,
          tool: entry.slug, name: entry.name, command: `opsfy call ${entry.slug}` }) + "\n" : `use_call: ${message}\n`, "");
        noInstall(w, result);
      }
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("paid_not_open reads open paid slugs in catalogue order and says none for an empty list", t => {
  const w = world(t), closed = tool({ slug: "later", name: "Later Tool", bucket: "paid" });
  const otherKinds = [tool({ slug: "free", call: { unit: "run" } }), tool({ slug: "self", bucket: "soon", call: { unit: "run" } })];
  for (const [entries, open] of [
    [[tool({ slug: "zeta", bucket: "paid", call: { unit: "run" } }), closed, ...otherKinds,
      tool({ slug: "alpha", bucket: "paid", call: { unit: "run" } })], "zeta, alpha"],
    [[closed, ...otherKinds], "none"],
  ]) {
    const extra = { OPSFY_CATALOG: w.catalog(entries) };
    const message = `Later Tool is listed but not open yet; open now: ${open} · run opsfy find "<job>" --json for another`;
    for (const command of ["install", "call"]) {
      for (const json of [false, true]) {
        const result = w.run([command, "Later Tool", ...(json ? ["--json"] : [])], extra);
        check(result, 2, json ? JSON.stringify({ ok: false, error: "paid_not_open", message,
          tool: "later", name: "Later Tool" }) + "\n" : `paid_not_open: ${message}\n`, "");
        noInstall(w, result);
      }
    }
  }
});

test("find prints each kind of tool once while preserving ranking and successful JSON actions", t => {
  const w = world(t), extra = { OPSFY_CATALOG: w.catalog([
    tool({ slug: "c-self", name: "Self Tool", bucket: "soon", jobs: "workspace" }),
    tool({ slug: "b-free", name: "Free App", jobs: "workspace" }),
    tool({ slug: "a-closed", name: "Closed Tool", bucket: "paid", jobs: "workspace" }),
    tool({ slug: "z-open", name: "Open Tool", bucket: "paid", call: { unit: "run" }, jobs: "workspace" }),
  ]) };
  check(w.run(["find", "workspace"], extra), 0,
    'Open Tool · Pay as you go · open: run opsfy info z-open --json, then opsfy call z-open "<input>" --json\n' +
    "Closed Tool · Pay as you go · not open yet\n" +
    "Free App · One-command install · run opsfy install b-free --json\n" +
    "Self Tool · Self-serve · the person gets it at https://opsfy.ai/demo/\n", "");
  check(w.run(["find", "workspace", "--json"], extra), 0, JSON.stringify({ ok: true, matches: [
    { slug: "z-open", name: "Open Tool", group: "Pay as you go", action: "open · opsfy call z-open" },
    { slug: "a-closed", name: "Closed Tool", group: "Pay as you go", action: "not open yet" },
    { slug: "b-free", name: "Free App", group: "One-command install", action: "opsfy install b-free" },
    { slug: "c-self", name: "Self Tool", group: "Self-serve", action: "get it at https://opsfy.ai/demo/" },
  ] }) + "\n", "");
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("find with no matches gives the approved next commands in plain text and JSON", t => {
  const w = world(t);
  const message = 'no tool matches those words · run opsfy list --json for the whole library, or opsfy ask "<tool>" --json to ask for one';
  check(w.run(["find", "zzqqxx"]), 0, message + "\n", "");
  check(w.run(["find", "zzqqxx", "--json"]), 0, JSON.stringify({ ok: true, matches: [], message }) + "\n", "");
});

test("info prints the group and next action while keeping closed, free and self-serve JSON unchanged", t => {
  const w = world(t);
  for (const [slug, name, group, line, state, plainAction, action] of [
    ["elevenlabs", "ElevenLabs", "Pay as you go", "Voices, dubbing, voice agents", " · not open yet", "not open yet", "not open yet"],
    ["openwork", "OpenWork", "One-command install", "Your skills and MCPs in one place, for every agent", "",
      "run opsfy install openwork --json", "opsfy install openwork"],
    ["magpie", "Magpie", "Self-serve", "Saves links, screenshots and notes for you", "",
      "the person gets it at https://usemagpie.app/", "get it at https://usemagpie.app/"],
  ]) {
    check(w.run(["info", name]), 0, `${name} · ${group}${state}\n${line}\n${plainAction}\n`, "");
    check(w.run(["info", name, "--json"]), 0, JSON.stringify({ ok: true, tool: { slug, name, group, action, line } }) + "\n", "");
  }
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("info preserves inputs and JSON while showing prices from the balance or the login and retry lines", t => {
  const w = world(t), { legacy_question, ...descriptor } = require("../lib/tool-data.json").tavily;
  const metadata = { route: "tools/tavily", status: 200, body: { ok: true, tool: descriptor } };
  const prefix = 'Tavily · Pay as you go · open\nWeb search for agents\nrun opsfy call tavily "<input>" --json\n' +
    'question: text · required · up to 2,000 characters · What to search for. · example: "what is opsfy"\n';
  for (const [reply, prices, price, last] of [
    [null, "login_required", undefined, "the price shows after login: run opsfy login --email <email> --json"],
    [{ status: 200, body: { ok: true, prices: { tavily: 9600 } } }, "shown", 9600, "$0.0096 a search, from the balance"],
    [{ status: 200, body: { ok: true, prices: { tavily: 12345 } } }, "shown", 12345, "$0.012345 a search, from the balance"],
    [{ network: true }, "unavailable", undefined, "the price could not be read · run the same command again in 60 seconds"],
    [{ status: 200, body: { ok: true, prices: {} } }, "unavailable", undefined, "the price could not be read · run the same command again in 60 seconds"],
    [{ status: 401, body: { ok: false, error: "invalid_key" } }, "login_required", undefined,
      "the price shows after login: run opsfy login --email <email> --json"],
  ]) {
    const extra = reply ? { OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64) } : {};
    const prelude = authPrelude([metadata, ...(reply ? [{ route: "prices", ...reply }] : [])]);
    check(w.run(["info", "tavily"], extra, prelude), 0, prefix + last + "\n", "");
    check(w.run(["info", "tavily", "--json"], extra, prelude), 0, JSON.stringify({ ok: true, tool: {
      slug: "tavily", name: "Tavily", group: "Pay as you go", action: "open · opsfy call tavily", line: "Web search for agents",
      inputs: descriptor.inputs, main_input: "question", results: descriptor.results, unit: "search", prices,
      ...(price === undefined ? {} : { price_microusd: price }),
    } }) + "\n", "");
  }
  assert.deepEqual(w.calls(), []);
});

test("missing metadata gives the same info_unavailable line for info and an open tool call", t => {
  const w = world(t), extra = { OPSFY_CATALOG: w.catalog([
    tool({ slug: "fixture", name: "Fixture Tool", bucket: "paid", call: { unit: "run" } }),
  ]) };
  const message = "opsfy.ai did not send the tool's details · wait 60 seconds, then run the same command again";
  for (const args of [["info", "fixture"], ["call", "fixture", "hello"]]) {
    for (const json of [false, true]) {
      check(w.run([...args, ...(json ? ["--json"] : [])], extra,
        authPrelude([{ route: "tools/fixture", network: true }])), 1,
      json ? JSON.stringify({ ok: false, error: "info_unavailable", message }) + "\n" : "",
      json ? "" : `info_unavailable: ${message}\n`);
    }
  }
  assert.deepEqual(w.calls(), []);
});

test("ask reports success and transport failures without changing successful JSON fields", t => {
  const w = world(t), name = "Some Tool";
  const accepted = authPrelude([{ route: "tool", status: 200, body: { ok: true } }]);
  check(w.run(["ask", name], {}, accepted), 0, "ask · asked for Some Tool · it shows on the wall at https://opsfy.ai\n", "");
  check(w.run(["ask", name, "--json"], {}, accepted), 0, JSON.stringify({ ok: true, status: "asked", tool: name }) + "\n", "");
  for (const [reply, reason] of [[{ network: true }, "network error"], [{ status: 503, body: {} }, "status 503"]]) {
    const message = `opsfy.ai could not be reached (${reason}) · wait 60 seconds, then run the same command again`;
    for (const json of [false, true]) {
      check(w.run(["ask", name, ...(json ? ["--json"] : [])], {}, authPrelude([{ route: "tool", ...reply }])), 1,
        json ? JSON.stringify({ ok: false, error: "unreachable", message }) + "\n" : `unreachable: ${message}\n`, "");
    }
  }
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("internal failures distinguish an invalid catalogue from unexpected errors in plain text and JSON", t => {
  const w = world(t), filename = path.join(w.root, "invalid.json");
  fs.writeFileSync(filename, "not a catalogue");
  const invalid = `OPSFY_CATALOG names a file that is not an opsfy catalogue (${filename}) · fix the file or unset OPSFY_CATALOG, then run the same command again`;
  const unexpected = "opsfy stopped on an unexpected error (fixture failure) · run the same command again; if it fails again, ask the person to email support@opsfy.ai";
  const prelude = `require(${JSON.stringify(path.resolve(__dirname, "../lib/catalog.js"))}).load = async () => { throw new Error("fixture failure"); };`;
  for (const [extra, setup, message] of [[{ OPSFY_CATALOG: filename }, "", invalid], [{}, prelude, unexpected]]) {
    for (const json of [false, true]) {
      check(w.run(["list", ...(json ? ["--json"] : [])], extra, setup), 1,
        json ? JSON.stringify({ ok: false, error: "internal", message }) + "\n" : "", json ? "" : `internal: ${message}\n`);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("call input refusals give the approved line in plain text and JSON", t => {
  const w = world(t), key = "opsfy_sk_" + "a".repeat(64);
  const cases = [
    [[], "usage", 'no question given · run opsfy call tavily "<question>"'],
    [["   "], "usage", 'no question given · run opsfy call tavily "<question>"'],
    [["x".repeat(2001)], "invalid_question", "the question has 2,001 characters; the most is 2,000 · shorten it, then run the call again"],
    [["😀".repeat(2002)], "invalid_question", "the question has 2,002 characters; the most is 2,000 · shorten it, then run the call again"],
    [["what is\nopsfy"], "invalid_question", "the question has a line break or a hidden character at character 8 · remove it, then run the call again"],
    [["😀é\u200btext\n"], "invalid_question", "the question has a line break or a hidden character at character 3 · remove it, then run the call again"],
    [["😀\r\ntext"], "invalid_question", "the question has a line break or a hidden character at character 2 · remove it, then run the call again"],
    [["check " + key], "invalid_question", "the question contains an opsfy key, which is never sent · remove the key, then run the call again"],
    [["--input", "nope=1"], "invalid_input", "the inputs do not match tavily's; it takes: question · run opsfy info tavily for each input's type and limits"],
  ];
  for (const [args, error, message] of cases) {
    for (const json of [false, true]) {
      check(w.run(["call", "tavily", ...args, ...(json ? ["--json"] : [])], { OPSFY_API_KEY: key }), 2,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
  assert.deepEqual(w.calls(), []);
});

test("question length and limit come from code points and the tool descriptor", async () => {
  const { parse, tools } = require("../lib/tool-inputs.js");
  const limited = { ...tools.tavily, inputs: [{ ...tools.tavily.inputs[0], max_length: 3 }] };
  assert.deepEqual(await parse(limited, ["tavily", "😀éa"]), { tool: "tavily", question: "😀éa" });
  await assert.rejects(parse(limited, ["tavily", "😀éab"]), {
    code: "invalid_question", status: 2,
    message: "the question has 4 characters; the most is 3 · shorten it, then run the call again",
  });
  const question = "😀".repeat(2000);
  assert.deepEqual(await parse(tools.tavily, ["tavily", question]), { tool: "tavily", question });
});

test("unreadable file and stdin inputs use the same approved refusal", t => {
  const w = world(t), filename = path.join(w.root, "input.json");
  const message = "the input is not one JSON object of at most 16,384 bytes · fix it, then run the call again";
  for (const bytes of [null, "not json", "[]", '{"question":"a","question":"b"}', Buffer.from([0xff]), " ".repeat(16385)]) {
    if (bytes !== null) fs.writeFileSync(filename, bytes);
    for (const json of [false, true]) {
      check(w.run(["call", "tavily", "--input-file", filename, ...(json ? ["--json"] : [])]), 2,
        json ? JSON.stringify({ ok: false, error: "input_unreadable", message }) + "\n" : "",
        json ? "" : `input_unreadable: ${message}\n`);
    }
  }
  for (const bytes of ["not json", " ".repeat(16385)]) {
    const prelude = `Object.defineProperty(process, "stdin", {
      value: require("node:stream").Readable.from([Buffer.from(${JSON.stringify(bytes)})])
    });`;
    for (const json of [false, true]) {
      check(w.run(["call", "tavily", "--input-file", "-", ...(json ? ["--json"] : [])], {}, prelude), 2,
        json ? JSON.stringify({ ok: false, error: "input_unreadable", message }) + "\n" : "",
        json ? "" : `input_unreadable: ${message}\n`);
    }
  }
  assert.deepEqual(w.calls(), []);
});

test("call, logs and topup dry runs name only the command that did not run", t => {
  const w = world(t);
  for (const args of [["call", "tavily", "what is opsfy"], ["logs"], ["topup", "10"]]) {
    const message = `OPSFY_DRY_RUN=1 is set, so ${args[0]} does not run · unset OPSFY_DRY_RUN to run it`;
    for (const json of [false, true]) {
      check(w.run([...args, ...(json ? ["--json"] : [])], { OPSFY_DRY_RUN: "1" }), 2,
        json ? JSON.stringify({ ok: false, error: "dry_run", message }) + "\n" : "",
        json ? "" : `dry_run: ${message}\n`);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("topup missing amounts and usage refusals give the approved next command", t => {
  const w = world(t), id = "0123456789abcdef0123456789abcdef";
  const cases = [
    [["topup"], "amount_needed", "no amount given; a top-up is $10, $25, $50, $100, $250 or $500 · ask the person which amount, then run opsfy topup <amount> --json"],
    [["topup", "10", "25"], "usage", "more than one amount given · run opsfy topup <amount> --json with one amount"],
    ...["wait", "status"].flatMap(action => [[], ["bad/id"], [id, id]].map(values => [
      ["topup", action, ...values], "usage",
      `the top-up id is missing or malformed · run opsfy topup ${action} <id> --json with the id opsfy topup gave`,
    ])),
  ];
  for (const [args, error, message] of cases) {
    for (const json of [false, true]) {
      check(w.run([...args, ...(json ? ["--json"] : [])]), 2,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "",
        json ? "" : `${error}: ${message}\n`);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("other paid tools use their own main input, name, unit and input list", t => {
  const w = world(t), descriptor = {
    slug: "fixture", name: "Fixture Tool", line: "A fixture tool", unit: "render", main_input: "prompt",
    inputs: [
      { name: "prompt", type: "string", required: true, max_length: 100, description: "Prompt", example: "hello" },
      { name: "count", type: "integer", required: false, minimum: 1, maximum: 5, description: "Count", example: 1 },
    ],
    results: { fields: ["text"], max_results: 1 },
  };
  const setup = `require(${JSON.stringify(path.resolve(__dirname, "../lib/tool-inputs.js"))}).tools.fixture = ${JSON.stringify(descriptor)};`;
  const invalid = "the inputs do not match fixture's; it takes: prompt, count · run opsfy info fixture for each input's type and limits";
  for (const [args, error, message] of [
    [[], "usage", 'no prompt given · run opsfy call fixture "<prompt>"'],
    [["--input", "nope=1"], "invalid_input", invalid],
  ]) {
    for (const json of [false, true]) {
      check(w.run(["call", "fixture", ...args, ...(json ? ["--json"] : [])], {}, setup), 2,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
  for (const [status, error, fields, message] of [
    [400, "invalid_question", {}, "opsfy.ai refused the prompt · check its limits with opsfy info fixture, change it, then run the call again"],
    [400, "invalid_input", { allowed_inputs: ["prompt", "count"] }, invalid],
    [402, "insufficient_balance", { price_microusd: 12345, balance_microusd: 1 },
      "a fixture render needs a hold of $0.012345 and the balance is $0.000001; nothing was charged · ask the person to add money, then run opsfy topup 10 --json"],
    [502, "search_failed", {}, "Fixture Tool answered with an error; nothing was charged · run the same call again"],
    [429, "rate_limited", {}, "too many calls (10 a minute for each account, or Fixture Tool's own limit) · wait 60 seconds, then run the call again"],
  ]) {
    const prelude = setup + `globalThis.fetch = async (url, options) => {
      require("node:assert/strict").equal(url, "http://127.0.0.1:9/api/call");
      require("node:assert/strict").deepEqual(JSON.parse(options.body), {tool: "fixture", inputs: {prompt: "hello"}});
      const response = new Response(${JSON.stringify(JSON.stringify({ ok: false, error, ...fields }))}, {
        status: ${status}, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
      });
      Object.defineProperty(response, "url", {value: url});
      return response;
    };`;
    for (const json of [false, true]) {
      check(w.run(["call", "fixture", "hello", ...(json ? ["--json"] : [])],
        { OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64) }, prelude), 1,
      json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
  assert.deepEqual(w.calls(), []);
});

test("unbounded call refusals name the called tool in the range command", t => {
  const w = world(t), descriptor = {
    slug: "fixture", name: "Fixture Tool", line: "A fixture tool", unit: "render", main_input: "prompt",
    inputs: [
      { name: "prompt", type: "string", required: true, max_length: 100, description: "Prompt", example: "hello" },
      { name: "count", type: "integer", required: false, minimum: 1, maximum: 5, description: "Count", example: 1 },
    ],
    results: { fields: ["text"], max_results: 1 },
  };
  const extra = { OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64), OPSFY_CATALOG: w.catalog([
    tool({ slug: "fixture", name: "Fixture Tool", bucket: "paid", call: { unit: "render" } }),
  ]) };
  const prelude = authPrelude([
    { route: "tools/fixture", status: 200, body: { ok: true, tool: descriptor } },
    { route: "call", status: 400, body: { ok: false, error: "unbounded_call", input: "count" } },
  ]);
  check(w.run(["call", "fixture", "hello"], extra, prelude), 1, "",
    "unbounded_call: the maximum charge needs count, which was not given; nothing was charged · run the call again with --input count=<value> (opsfy info fixture --json lists its range)\n");
});

test("stopping a pending call directs the agent to check logs before calling again", t => {
  const w = world(t);
  const message = "stopped before the answer came back, so it may have been charged · run opsfy logs --json and look for it before calling again";
  const prelude = 'globalThis.fetch = async () => { process.emit("SIGINT"); return new Promise(() => {}); };';
  for (const json of [false, true]) {
    check(w.run(["call", "tavily", "what is opsfy", ...(json ? ["--json"] : [])],
      { OPSFY_API_KEY: "opsfy_sk_" + "a".repeat(64) }, prelude), 130,
    json ? JSON.stringify({ ok: false, error: "stopped_call", message }) + "\n" : "", json ? "" : `stopped_call: ${message}\n`);
    assert.deepEqual(fs.readdirSync(path.join(w.home, ".opsfy")), []);
  }
});

function authPrelude(replies = [], answers) {
  return `
    const authReplies = ${JSON.stringify(replies)}, authRequests = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const reply = authReplies[authRequests.length];
      authRequests.push(new URL(request.url).pathname);
      if (!reply) throw new Error("unexpected auth request");
      if (reply.offline) throw new TypeError("fixture offline", { cause: { code: "ECONNREFUSED", syscall: "connect" } });
      if (reply.network) throw new TypeError("fixture transport detail");
      const response = new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...reply.headers}
      });
      Object.defineProperty(response, "url", { value: request.url });
      return response;
    };
    const authAnswers = ${JSON.stringify(answers ?? null)};
    if (authAnswers) {
      const input = new (require("node:events").EventEmitter)();
      Object.defineProperty(process, "stdin", { value: input });
      input.isTTY = true;
      input.setRawMode = raw => { input.isRaw = raw; };
      input.pause = () => input;
      input.resume = () => {
        setImmediate(() => input.emit("data", Buffer.from(authAnswers.shift())));
        return input;
      };
    }
    process.on("exit", () => {
      const assert = require("node:assert/strict");
      assert.deepEqual(authRequests, authReplies.map(reply => "/api/" + reply.route));
      if (authAnswers) {
        assert.deepEqual(authAnswers, []);
        assert.equal(!!process.stdin.isRaw, false);
      }
    });
  `;
}

function savedAuth(w, email = "saved@example.com", key = "opsfy_sk_" + "a".repeat(64)) {
  const directory = path.join(w.home, ".opsfy");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "key"), key + "\n");
  fs.writeFileSync(path.join(directory, "account"), JSON.stringify(authIdentity(email, key)) + "\n");
  return { directory, email, key };
}

function authIdentity(email, key = "opsfy_sk_" + "49".repeat(32)) {
  return { email, key_fingerprint: require("node:crypto").createHash("sha256").update(key).digest("hex") };
}

test("login and key local refusals preserve literal placeholders in plain text and JSON", t => {
  const cases = [
    [["login"], "email_needed", "no email given · ask the person for their email, then run opsfy login --email <email> --json"],
    [["login", "--email", "not-an-address"], "invalid_email", "that is not a valid email address · ask the person for their email again, then run opsfy login --email <email> --json"],
    [["login", "--email", " Agent@Example.com ", "--code", "12"], "invalid_code", "a code is the 6 digits in the email opsfy.ai sent · ask the person for it, then run opsfy login --email agent@example.com --code <code> --json"],
    [["login", "--code", "123456"], "usage", "opsfy login takes --email <email>, then --email <email> --code <code> · run opsfy login --email <email> --json"],
    [["key", "extra"], "usage", "opsfy key takes nothing, or rotate · run opsfy key --json or opsfy key rotate --json"],
    [["logout", "extra"], "usage", "opsfy logout takes --all or no option · run opsfy logout --json for this key, or opsfy logout --all --json for every key on the account"],
    ...[["key"], ["key", "rotate"], ["logout"], ["call", "tavily", "what is opsfy"], ["logs"], ["topup", "10"]].map(args =>
      [args, "not_logged_in", "no key on this computer, and OPSFY_API_KEY is not set · ask the person for their email, then run opsfy login --email <email> --json"]),
  ];
  for (const [args, error, message] of cases) {
    for (const json of [false, true]) {
      check(world(t).run([...args, ...(json ? ["--json"] : [])], {}, authPrelude()), 2,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
});

test("auth dry runs name login, logout or key and leave the home untouched", t => {
  for (const args of [["login", "--email", "agent@example.com"], ["logout"], ["key"], ["key", "rotate"]]) {
    const message = `OPSFY_DRY_RUN=1 is set, so ${args[0]} does not run · unset OPSFY_DRY_RUN to run it`;
    for (const json of [false, true]) {
      const w = world(t);
      check(w.run([...args, ...(json ? ["--json"] : [])], { OPSFY_DRY_RUN: "1" }, authPrelude()), 2,
        json ? JSON.stringify({ ok: false, error: "dry_run", message }) + "\n" : "", json ? "" : `dry_run: ${message}\n`);
      assert.deepEqual(fs.readdirSync(w.home), []);
    }
  }
});

test("auth environment refusals distinguish login and rotation from every key consumer", t => {
  const set = "OPSFY_API_KEY is set; login and key rotate work only with the saved key · unset OPSFY_API_KEY, then run the same command again";
  const invalid = "OPSFY_API_KEY is not an opsfy key (opsfy_sk_ and 64 hex characters) · fix OPSFY_API_KEY or unset it, then run the same command again";
  const cases = [
    ...[["login", "--email", "saved@example.com"], ["key", "rotate"]].flatMap(args =>
      ["not-a-key", "opsfy_sk_" + "b".repeat(64)].map(key => [args, key, set])),
    ...[["key"], ["logout"], ["call", "tavily", "what is opsfy"], ["logs"], ["topup", "10"]].map(args => [args, "not-a-key", invalid]),
  ];
  for (const [args, key, message] of cases) {
    for (const json of [false, true]) {
      const w = world(t), saved = savedAuth(w);
      check(w.run([...args, ...(json ? ["--json"] : [])], { OPSFY_API_KEY: key }, authPrelude()), 2,
        json ? JSON.stringify({ ok: false, error: "api_key_env_set", message }) + "\n" : "", json ? "" : `api_key_env_set: ${message}\n`);
      assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), saved.key + "\n");
      assert.deepEqual(fs.readdirSync(saved.directory).sort(), ["account", "key"]);
    }
  }
});

test("login site refusals fill only the approved email placeholders", t => {
  const email = "agent@example.com";
  const invalidEmail = "that is not a valid email address · ask the person for their email again, then run opsfy login --email <email> --json";
  const cases = [
    ["login-code", 400, "invalid_email", "invalid_email", invalidEmail],
    ["login", 400, "invalid_email", "invalid_email", invalidEmail],
    ["login", 400, "invalid_code", "invalid_code", "a code is the 6 digits in the email opsfy.ai sent · ask the person for it, then run opsfy login --email agent@example.com --code <code> --json"],
    ["login", 400, "code_invalid", "code_incorrect", "the code does not match the one sent to agent@example.com; each code allows 5 tries · ask the person to check it, then run opsfy login --email agent@example.com --code <code> --json"],
    ["login", 410, "code_expired", "code_expired", "the code sent to agent@example.com is older than 10 minutes · run opsfy login --email agent@example.com --json for a new code, then ask the person for it"],
    ["login", 429, "code_locked", "code_locked", "5 incorrect tries used up the code sent to agent@example.com · run opsfy login --email agent@example.com --json for a new code, then ask the person for it"],
    ["login-code", 503, "send_failed", "server_error", "no clear answer came back from opsfy.ai · wait 60 seconds, then run the same command again", { "retry-after": "60" }],
  ];
  for (const [route, status, remote, error, message, headers] of cases) {
    for (const json of [false, true]) {
      const args = ["login", "--email", email, ...(route === "login" ? ["--code", "123456"] : []), ...(json ? ["--json"] : [])];
      check(world(t).run(args, {}, authPrelude([{ route, status, body: { ok: false, error: remote }, headers }])), 1,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
});

test("login rate refusals add Retry-After to now and print UTC seconds in both output modes", t => {
  for (const [error, prefix] of [
    ["rate_email", "3 codes went to agent@example.com in the last hour, the most allowed"],
    ["rate_ip", "10 codes went out from this network in the last hour, the most allowed"],
  ]) {
    for (const [retry, time] of [["1", "2026-10-12T23:59:46Z"], ["60", "2026-10-13T00:00:45Z"], ["2820", "2026-10-13T00:46:45Z"]]) {
      const message = `${prefix} · run opsfy login --email agent@example.com --json again after ${time}`;
      for (const json of [false, true]) {
        const prelude = 'Date.now = () => Date.parse("2026-10-12T23:59:45.789Z");\n' + authPrelude([
          { route: "login-code", status: 429, body: { ok: false, error }, headers: { "retry-after": retry } },
        ]);
        check(world(t).run(["login", "--email", " Agent@Example.com ", ...(json ? ["--json"] : [])], { TZ: "Asia/Hong_Kong" }, prelude), 1,
          json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
      }
    }
  }
});

test("login rate refusals still require a positive whole Retry-After header", t => {
  const message = "no clear answer came back from opsfy.ai · wait 60 seconds, then run the same command again";
  for (const error of ["rate_email", "rate_ip"]) {
    for (const retry of [null, "0", "-1", "1.5", "Mon, 12 Oct 2026 10:00:00 GMT"]) {
      check(world(t).run(["login", "--email", "agent@example.com", "--json"], {}, authPrelude([
        { route: "login-code", status: 429, body: { ok: false, error }, headers: retry === null ? {} : { "retry-after": retry } },
      ])), 1, JSON.stringify({ ok: false, error: "server_error", message }) + "\n", "");
    }
  }
});

test("login success lines name the command and JSON keeps its existing fields", t => {
  for (const json of [false, true]) {
    const w = world(t), email = "agent@example.com";
    check(w.run(["login", "--email", email, ...(json ? ["--json"] : [])], {}, authPrelude([
      { route: "login-code", status: 202, body: { ok: true, expires_in: 600 } },
    ], json ? [] : undefined)), 0,
    json ? JSON.stringify({ ok: true, status: "code_sent", email, expires_in: 600 }) + "\n"
      : "login · code sent to agent@example.com; it works for 10 minutes and 5 tries · ask the person for the 6-digit code, then run opsfy login --email agent@example.com --code <code> --json\n", "");
    check(w.run(["login", "--email", email, "--code", "123456", ...(json ? ["--json"] : [])], {}, authPrelude([
      { route: "login", status: 200, body: { ok: true, ...authIdentity(email) } },
    ])), 0, json ? JSON.stringify({ ok: true, status: "logged_in", email }) + "\n"
      : "login · logged in as agent@example.com · the key is saved in ~/.opsfy/\n", "");
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, ".opsfy/account"), "utf8")).email, email);
  }
});

test("terminal login keeps short sent text and separate email, code and wrong-code re-asks", t => {
  const w = world(t), email = "agent@example.com";
  check(w.run(["login"], {}, authPrelude([
    { route: "login-code", status: 202, body: { ok: true, expires_in: 600 } },
    { route: "login", status: 400, body: { ok: false, error: "code_invalid" } },
    { route: "login", status: 200, body: { ok: true, ...authIdentity(email) } },
  ], ["not-an-email\r", email + "\r", "12\r", "123456\r", "654321\r"])), 0,
  "Email:\nEmail:\nlogin · code sent to agent@example.com; it works for 10 minutes and 5 tries\nCode:\nCode:\nCode:\nlogin · logged in as agent@example.com · the key is saved in ~/.opsfy/\n",
  "enter a valid email address\nenter the six-digit code from your email\nthe code does not match; each code allows 5 tries · type it again\n");
  assert.deepEqual(fs.readdirSync(path.join(w.home, ".opsfy")).sort(), ["account", "key"]);
});

test("terminal login uses the same re-asks when the site refuses an email or code shape", t => {
  const w = world(t), email = "agent@example.com";
  check(w.run(["login"], {}, authPrelude([
    { route: "login-code", status: 400, body: { ok: false, error: "invalid_email" } },
    { route: "login-code", status: 202, body: { ok: true, expires_in: 600 } },
    { route: "login", status: 400, body: { ok: false, error: "invalid_code" } },
    { route: "login", status: 400, body: { ok: false, error: "invalid_email" } },
    { route: "login", status: 200, body: { ok: true, ...authIdentity(email) } },
  ], [email + "\r", email + "\r", "123456\r", "654321\r", "invalid\r", email + "\r"])), 0,
  "Email:\nEmail:\nlogin · code sent to agent@example.com; it works for 10 minutes and 5 tries\nCode:\nCode:\nEmail:\nEmail:\nlogin · logged in as agent@example.com · the key is saved in ~/.opsfy/\n",
  "enter a valid email address\nenter the six-digit code from your email\nenter a valid email address\nenter a valid email address\n");
});

test("terminal cancellation at either question keeps the saved key and literal email placeholder", t => {
  for (const atCode of [false, true]) {
    const w = world(t), saved = savedAuth(w);
    const replies = atCode ? [{ route: "login-code", status: 202, body: { ok: true, expires_in: 600 } }] : [];
    check(w.run(["login", ...(atCode ? ["--email", saved.email] : [])], {}, authPrelude(replies, ["\x03"])), 1,
      atCode ? "login · code sent to saved@example.com; it works for 10 minutes and 5 tries\nCode:\n" : "Email:\n",
      "cancelled: login stopped before it finished; the key on this computer is unchanged · run opsfy login --email <email> --json\n");
    assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), saved.key + "\n");
    assert.deepEqual(fs.readdirSync(saved.directory).sort(), ["account", "key"]);
  }
});

test("key display names the source and rotation names the command with unchanged JSON fields", t => {
  for (const environment of [false, true]) {
    for (const json of [false, true]) {
      const w = world(t), saved = savedAuth(w);
      const key = environment ? "opsfy_sk_" + "b".repeat(64) : saved.key;
      const email = environment ? "env@example.com" : saved.email;
      check(w.run(["key", ...(json ? ["--json"] : [])], environment ? { OPSFY_API_KEY: key } : {}, authPrelude([
        { route: "session", status: 200, body: { ok: true, ...authIdentity(email, key) } },
      ])), 0, json ? JSON.stringify({ ok: true, status: "logged_in", email, key_ending: key.slice(-4), key_from: environment ? "OPSFY_API_KEY" : "saved_file" }) + "\n"
        : `key · logged in as ${email} · key ending ${key.slice(-4)} · from ${environment ? "OPSFY_API_KEY" : "~/.opsfy/"}\n`, "");
      assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), saved.key + "\n");
    }
  }
  for (const json of [false, true]) {
    const w = world(t), saved = savedAuth(w);
    check(w.run(["key", "rotate", ...(json ? ["--json"] : [])], {}, authPrelude([
      { route: "session", status: 200, body: { ok: true, ...authIdentity(saved.email, saved.key) } },
      { route: "key-rotate", status: 200, body: { ok: true, ...authIdentity(saved.email) } },
    ])), 0, json ? '{"ok":true,"status":"rotated"}\n'
      : "key · rotated · the new key is saved in ~/.opsfy/; the old one no longer works\n", "");
    assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), "opsfy_sk_" + "49".repeat(32) + "\n");
    assert.deepEqual(fs.readdirSync(saved.directory).sort(), ["account", "key"]);
  }
});

test("logout claims local removal only for the matching saved key and carries the environment warning", t => {
  const warning = "OPSFY_API_KEY still holds the old key, which no longer works · unset OPSFY_API_KEY";
  for (const source of ["saved", "same", "other", "environment-only"]) {
    for (const json of [false, true]) {
      const w = world(t), saved = source === "environment-only" ? null : savedAuth(w);
      const extra = source === "saved" ? {} : { OPSFY_API_KEY: source === "same" ? saved.key : "opsfy_sk_" + "b".repeat(64) };
      const matching = source === "saved" || source === "same";
      check(w.run(["logout", ...(json ? ["--json"] : [])], extra, authPrelude([
        { route: "logout", status: 200, body: { ok: true } },
      ])), 0, json ? JSON.stringify({ ok: true, status: "logged_out", ...(source === "saved" ? {} : { warning }) }) + "\n"
        : "logout · logged out · the key no longer works" + (matching ? " and is removed from this computer" : "") + "\n" +
          (source === "saved" ? "" : warning + "\n"), "");
      assert.deepEqual(fs.readdirSync(path.join(w.home, ".opsfy")).sort(), source === "other" ? ["account", "key"] : []);
      if (source === "other") assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), saved.key + "\n");
    }
  }
});

test("key and logout failures give the approved recovery steps and preserve exit codes", t => {
  const cases = [
    [["key"], { route: "session", status: 401, body: { ok: false, error: "invalid_key" } }, "key_not_working",
      "opsfy.ai no longer accepts this key · ask the person for their email, then run opsfy login --email <email> --json"],
    [["logout"], { route: "logout", status: 401, body: { ok: false, error: "invalid_key" } }, "key_removed",
      "the key had already stopped working, so it is removed from this computer · to log in again, run opsfy login --email <email> --json"],
    [["logout"], { route: "logout", offline: true }, "offline",
      "opsfy.ai could not be reached, so the key still works · run opsfy logout --json again once online"],
    [["key"], { route: "session", network: true }, "server_error",
      "no clear answer came back from opsfy.ai · wait 60 seconds, then run the same command again"],
  ];
  for (const [args, reply, error, message] of cases) {
    for (const json of [false, true]) {
      const w = world(t), saved = savedAuth(w);
      check(w.run([...args, ...(json ? ["--json"] : [])], {}, authPrelude([reply])), 1,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
      assert.deepEqual(fs.readdirSync(saved.directory).sort(), error === "key_removed" ? [] : ["account", "key"]);
      if (error !== "key_removed") assert.equal(fs.readFileSync(path.join(saved.directory, "key"), "utf8"), saved.key + "\n");
    }
  }
});

test("other account and unfinished login refusals name the stored email", t => {
  for (const json of [false, true]) {
    const w = world(t);
    savedAuth(w);
    const other = "this computer is logged in as saved@example.com; opsfy keeps one email at a time · ask the person whether to log out, then run opsfy logout --json and log in with the new email";
    check(w.run(["login", "--email", "new@example.com", ...(json ? ["--json"] : [])], {}, authPrelude()), 2,
      json ? JSON.stringify({ ok: false, error: "other_account", message: other }) + "\n" : "", json ? "" : `other_account: ${other}\n`);
    const pendingWorld = world(t), directory = path.join(pendingWorld.home, ".opsfy");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "pending"), JSON.stringify({ email: "pending@example.com", candidates: ["opsfy_sk_" + "a".repeat(64)] }) + "\n");
    const pending = "an earlier login or key change for pending@example.com did not finish, so the key is not confirmed · run opsfy login --email pending@example.com --json, then ask the person for the new code";
    for (const args of [["key"], ["login", "--email", "new@example.com"], ["login", "--email", "pending@example.com", "--code", "123456"]]) {
      check(pendingWorld.run([...args, ...(json ? ["--json"] : [])], {}, authPrelude()), 2,
        json ? JSON.stringify({ ok: false, error: "login_pending", message: pending }) + "\n" : "", json ? "" : `login_pending: ${pending}\n`);
    }
  }
});

test("auth file, lock and API base refusals carry the approved next steps", t => {
  const cases = [
    ["key_files", 1, "opsfy could not read or write its files in ~/.opsfy/ · run the same command again; if it fails again, ask the person to email support@opsfy.ai", "key", "invalid\n"],
    ["busy", 2, "another opsfy command is using ~/.opsfy/ right now · wait for it to finish, then run the same command again", "auth-lock", process.pid + "\n"],
    ["stale_lock", 1, "an earlier opsfy command stopped without releasing ~/.opsfy/auth-lock · if no opsfy command is running, delete that file, then run the same command again", "auth-lock", "invalid\n"],
    ["bad_api_base", 2, "OPSFY_API_BASE must be https (or http on localhost) with no username, password, query or fragment · unset OPSFY_API_BASE to use https://opsfy.ai"],
  ];
  for (const [error, status, message, filename, content] of cases) {
    for (const json of [false, true]) {
      const w = world(t);
      if (filename) {
        const directory = path.join(w.home, ".opsfy");
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, filename), content);
      }
      check(w.run(["key", ...(json ? ["--json"] : [])], error === "bad_api_base" ? { OPSFY_API_BASE: "ftp://example.com" } : {}, authPrelude()), status,
        json ? JSON.stringify({ ok: false, error, message }) + "\n" : "", json ? "" : `${error}: ${message}\n`);
    }
  }
});
