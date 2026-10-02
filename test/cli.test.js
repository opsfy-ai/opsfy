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
const GET = "dry-run: GET https://opsfy.ai/tools.json\n";
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
  const expected = "opsfy 0.4.0 · one key for all your tools · https://opsfy.ai\n\n  opsfy list                  the tools: free (install now), paid (not open yet), coming soon\n  opsfy install <app>         install a free app on this Mac, from its upstream source\n  opsfy ask <tool>            ask for a tool; it shows on the wall at opsfy.ai\n  opsfy login                 log in with your email and a code\n  opsfy key                   check your key; shows only its last four characters\n  opsfy key rotate            replace your key with a new one\n  opsfy logout                log out; your key stops working\n  opsfy topup [amount]        add money to your balance on a Stripe page\n  opsfy topup wait <id>       wait until a top-up is paid, cancelled or expired\n  opsfy topup status <id>     a top-up's state now\n  opsfy call <tool> ...       call a paid tool off your balance (not open yet)\n  opsfy logs [--json]         your balance and paid top-ups\n\n  --json                      one JSON answer for an agent, for each topup command\n\nMac today; Windows and Linux next. opsfy never runs as root.\n";
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    check(w.run(args, { OPSFY_CATALOG: path.join(w.root, "absent") }), 0, expected, "");
  }
  for (const alias of ["--version", "-v", "version"]) {
    check(w.run([alias]), 0, "0.4.0\n", "");
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("unknown commands and missing arguments use stderr and exit 2 without requests", (t) => {
  const w = world(t);
  const cases = [
    [["unknown"], "unknown command: unknown\nrun opsfy --help\n"],
    [["install"], "usage: opsfy install <app>\n"],
    [["ask"], "usage: opsfy ask <tool>\n"],
    [["call"], "usage: opsfy call <tool> ...\n"],
    [["login", "--email"], "usage: opsfy login [--email you@example.com] [--code 123456]\n"],
    [["login", "someone@somewhere.test"], "usage: opsfy login [--email you@example.com] [--code 123456]\n"],
    [["login", "--email", "a@b.co", "extra"], "usage: opsfy login [--email you@example.com] [--code 123456]\n"],
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
  assert.equal(groups[0].split("\n")[0], "Free · install now · opsfy install <app>");
  assert.equal(groups[1].split("\n")[0], "Paid · not open yet");
  assert.equal(groups[2].split("\n")[0], "Coming soon");
  assert.deepEqual(groups.map((group) => group.split("\n").length - 1), [6, 20, 5]);
  assert.ok(groups[0].startsWith("Free · install now · opsfy install <app>\n  openwork         OpenWork           Your skills and MCPs in one place, for every agent\n"));
  check(w.run(["list", "--json"]), 0, JSON.stringify(bundled, null, 2) + "\n", "");
});

test("a local catalogue controls column widths and slug matches precede name matches", (t) => {
  const w = world(t);
  const filename = w.catalog([
    tool({ slug: "abc", name: "XYZ", install: { kind: "cask", cask: "first" } }),
    tool({ slug: "xyz", name: "B", install: { kind: "cask", cask: "second" } }),
  ]);
  const extra = { OPSFY_CATALOG: filename };
  check(w.run(["list"], extra), 0,
    "Free · install now · opsfy install <app>\n  abc  XYZ  A test app\n  xyz  B    A test app\n\n" +
    "Paid · not open yet\n\nComing soon\n", "");
  check(w.eligible(["install", "XYZ"], extra), 0);
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "second"] }]);
});

test("cask output stays ordered around inherited child output and preserves its environment", (t) => {
  const w = world(t);
  const result = w.eligible(["install", "OpenWork"], { FAKE_BREW_OUTPUT: "from the child" });
  check(result, 0, OPENWORK + "installing with Homebrew: brew install --cask openwork\n" +
    "from the child\nok · installed · OpenWork\n",
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
    "installing with Homebrew: brew install --cask unsloth\nok · installed · Unsloth Desktop\n",
  "");
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "unsloth"] }]);
});

test("a failed cask preserves the child status in its message", (t) => {
  const w = world(t);
  check(w.eligible(["install", "openwork"], { FAKE_BREW_EXIT: "3" }), 1,
    OPENWORK + "installing with Homebrew: brew install --cask openwork\nfailed · Homebrew exited 3\n",
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
  const expected = OPENWORK + "needs Homebrew. Install it from https://brew.sh, then run this again.\nstopped · nothing changed\n";
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
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nok · installed · gstack · ~/.claude/skills/gstack\n",
    "");
  assert.deepEqual(w.calls(), [
    { command: "git", args: ["clone", "--single-branch", "--depth", "1", "https://github.com/garrytan/gstack.git", target] },
    { command: "setup", args: [], cwd: fs.realpathSync(target) },
  ]);
  assert.equal(fs.readFileSync(w.log, "utf8").match(/MARKER=inherited-by-installers/g).length, 2);
  w.reset();
  const again = w.eligible(["install", "gstack"]);
  check(again, 0, GSTACK + "already installed · gstack · ~/.claude/skills/gstack\n", "");
  noInstall(w, again);
});

test("a failed clone does not attempt setup", (t) => {
  const w = world(t);
  check(w.eligible(["install", "gstack"], { FAKE_GIT_EXIT: "7" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nfailed · git exited 7\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git"]);
});

test("a failed setup reports failure after the successful clone", (t) => {
  const w = world(t);
  check(w.eligible(["install", "gstack"], { FAKE_SETUP_EXIT: "4" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nfailed · setup exited 4\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git", "setup"]);
});

test("a git recipe without setup or needs requires only Git and clones without setup", (t) => {
  const w = world(t, ["git"]);
  const filename = w.catalog([tool({ install: { kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/share/demo" } })]);
  check(w.eligible(["install", "demo"], { OPSFY_CATALOG: filename }), 0,
    "Demo · free · from the upstream repo · opsfy.ai/demo\ncloning into ~/.local/share/demo\n" +
    "ok · installed · Demo · ~/.local/share/demo\n",
    "");
  assert.deepEqual(w.calls(), [{ command: "git", args: ["clone", "--single-branch", "--depth", "1",
    "https://github.com/example/demo", path.join(w.home, ".local/share/demo")] }]);
});

test("missing prerequisites are deduplicated, ordered and never probed", (t) => {
  const w = world(t, []);
  const result = w.eligible(["install", "gstack"]);
  check(result, 2, GSTACK + "needs Git, Bun and Claude Code. Missing: Git (xcode-select --install), " +
    "Bun (brew install oven-sh/bun/bun), Claude Code (npm i -g @anthropic-ai/claude-code)\nstopped · nothing changed\n", "");
  noInstall(w, result);
  for (const name of ["git", "claude"]) fs.writeFileSync(path.join(w.bin, name), fakeScripts[name], { mode: 0o755 });
  check(w.eligible(["install", "gstack"]), 2, GSTACK +
    "needs Git, Bun and Claude Code. Missing: Bun (brew install oven-sh/bun/bun)\nstopped · nothing changed\n", "");
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
    check(result, 2, "Demo cannot be installed by this version of opsfy. Update it: npm i -g @opsfy/cli\n", "");
    noInstall(w, result);
  }
});

test("unknown, paid and coming-soon installs print their exact refusal without counting", (t) => {
  const w = world(t);
  const cases = [
    ["missing", "missing is not in the catalogue. Ask for it: opsfy ask missing\n"],
    ["elevenlabs", "ElevenLabs is a paid tool. Paid tools are not open yet.\n"],
    ["magpie", "Magpie is coming soon.\n"],
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
    check(w.run(["list"], { OPSFY_CATALOG: filename }), 1, "", `opsfy: bad catalogue file: ${filename}\n`);
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
    0, JSON.stringify(cached, null, 2) + "\n", "");
  check(w.run(["list", "--json"], { OPSFY_HOME: customHome }),
    0, JSON.stringify(bundled, null, 2) + "\n", "");
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
    }), 0, JSON.stringify(bundled, null, 2) + "\n", GET);
    assert.equal(fs.readFileSync(filename, "utf8"), content);
  }
});

test("the catalogue URL seam prints a GET without a trailing space and creates no home files", (t) => {
  const w = world(t);
  const result = w.run(["list"], {
    OPSFY_CATALOG: undefined, OPSFY_CATALOG_URL: "https://opsfy.ai/review.json",
    OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai",
  });
  check(result, 0, undefined, "dry-run: GET https://opsfy.ai/review.json\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("ask joins and encodes words, accepts 120 characters, and refuses 121 unsent", (t) => {
  const w = world(t);
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai" };
  check(w.run(["ask", "Google", "Sheets", "&", "more"], extra), 0,
    "ok · asked for Google Sheets & more · on the wall at https://opsfy.ai\n",
    "dry-run: POST https://opsfy.ai/api/tool tool=Google%20Sheets%20%26%20more\n");
  check(w.run(["ask", "x".repeat(120)], extra), 0);
  check(w.run(["ask", "x".repeat(121)], extra), 2, "keep it under 120 characters\n", "");
  assert.deepEqual(fs.readdirSync(w.home), []);
  assert.deepEqual(w.calls(), []);
});

test("login validates addresses and posts only the encoded waitlist field", (t) => {
  const w = world(t);
  check(w.run(["login"]), 2, "", "run opsfy login --email you@example.com to log in\n");
  check(w.run(["login", "--email", "a+b@c.co", "--code", "123456"], { OPSFY_DRY_RUN: "1" }),
    2, "", "dry-run · login, logout and key do not run in a dry run\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
  for (const address of ["nope", "@b.co", "a b@c.co", "a@b", "a@b@c.co"]) {
    check(w.run(["login", "--email", address]), 2, "", "enter a valid email address\n");
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
    "Code sent to a+b@c.co. It works for 10 minutes.\n", "");
  const directory = path.join(w.home, ".opsfy");
  assert.equal(fs.existsSync(path.join(directory, "key")), false);
  check(w.run(["login", "--code", "123-456", "--email", " A+B@C.CO "], {}, reply), 0,
    "ok · logged in as a+b@c.co · your key is saved in ~/.opsfy/\n", "");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["account", "key"]);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "key")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "account"), "utf8")).email, "a+b@c.co");
  assert.deepEqual(w.calls(), []);
});

test("call uses the part before the first dot and logs makes no request", (t) => {
  const w = world(t);
  const cases = [
    ["elevenlabs.speak", "ElevenLabs is a paid tool. Paid tools are not open yet.\n"],
    ["OpenWork.run", "OpenWork is a free app: opsfy install openwork\n"],
    ["qoder.run", "Qoder is coming soon.\n"],
    ["missing.run", "missing.run is not in the catalogue. Ask for it: opsfy ask missing.run\n"],
  ];
  for (const [name, output] of cases) check(w.run(["call", name, "payload"]), 2, output, "");
  check(w.run(["logs"]), 2, "", "you are not logged in on this computer · run opsfy login to log in\n");
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), [".opsfy"]);
});

test("geteuid root is refused before either recipe branch, including OPSFY_DRY_RUN", (t) => {
  const w = world(t);
  for (const slug of ["openwork", "gstack"]) {
    for (const dryRun of [undefined, "1"]) {
      const result = w.run(["install", slug], { OPSFY_DRY_RUN: dryRun, OPSFY_NO_COUNT: "1" },
        "process.geteuid = () => 0;");
      check(result, 2, "opsfy never runs as root. Run it as your own user.\nstopped · nothing changed\n", "");
      noInstall(w, result);
    }
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("signal deaths and processes that cannot start report status 1", (t) => {
  const w = world(t);
  const expected = OPENWORK + "installing with Homebrew: brew install --cask openwork\nfailed · Homebrew exited 1\n";
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
  check(result, 0, OPENWORK + "dry-run · would run · brew install --cask openwork\n" +
    "dry-run · nothing was installed and nothing was sent\n", "dry-run: GET http://127.0.0.1:9/api/pulled\n");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN previews a git clone and setup without creating the target or counting", (t) => {
  const w = world(t);
  const result = w.run(["install", "gstack"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" });
  check(result, 0, GSTACK +
    "dry-run · would clone · https://github.com/garrytan/gstack.git into ~/.claude/skills/gstack\n" +
    "dry-run · would run · ~/.claude/skills/gstack/setup\n" +
    "dry-run · nothing was installed and nothing was sent\n", "dry-run: GET http://127.0.0.1:9/api/pulled\n");
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
    "dry-run · would clone · https://github.com/example/demo into ~/.local/share/demo\n" +
    "dry-run · nothing was installed and nothing was sent\n", "dry-run: GET http://127.0.0.1:9/api/pulled\n");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN preserves platform, recipe and prerequisite refusals", (t) => {
  const w = world(t, []);
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" };
  const cases = [
    [["install", "openwork"], { OPSFY_PLATFORM: "linux" },
      "Mac today; Windows and Linux next. Nothing was changed.\n"],
    [["install", "demo"], { OPSFY_CATALOG: w.catalog([tool({ install: undefined })]) },
      "Demo cannot be installed by this version of opsfy. Update it: npm i -g @opsfy/cli\n"],
    [["install", "openwork"], {}, OPENWORK +
      "needs Homebrew. Install it from https://brew.sh, then run this again.\nstopped · nothing changed\n"],
    [["install", "gstack"], {}, GSTACK +
      "needs Git, Bun and Claude Code. Missing: Git (xcode-select --install), " +
      "Bun (brew install oven-sh/bun/bun), Claude Code (npm i -g @anthropic-ai/claude-code)\nstopped · nothing changed\n"],
  ];
  for (const [args, overrides, expected] of cases) {
    const result = w.run(args, { ...extra, ...overrides });
    const gets = !overrides.OPSFY_PLATFORM && !overrides.OPSFY_CATALOG;
    check(result, 2, expected, gets ? "dry-run: GET http://127.0.0.1:9/api/pulled\n" : "");
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
        `dry-run: POST ${base.replace(/\/+$/, "")}/api/install tool=${slug}&ok=${ok ? "1" : "0"}\n`);
    }
  }
});

test("OPSFY_API_BASE moves catalogue, ask and login endpoints and trims trailing slashes", (t) => {
  const w = world(t);
  const extra = { OPSFY_API_BASE: "https://staging.opsfy.ai///", OPSFY_DRY_RUN: "1" };
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined }), 0,
    JSON.stringify(bundled, null, 2) + "\n", "dry-run: GET https://staging.opsfy.ai/tools.json\n");
  check(w.run(["ask", "Sheets"], extra), 0,
    "ok · asked for Sheets · on the wall at https://opsfy.ai\n",
    "dry-run: POST https://staging.opsfy.ai/api/tool tool=Sheets\n");
  check(w.run(["login", "--email", "a+b@c.co"], extra), 2, "",
    "dry-run · login, logout and key do not run in a dry run\n");
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
      "ok · asked for x · on the wall at https://opsfy.ai\n",
      `dry-run: POST ${expected}/api/tool tool=x\n`);
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
      `OPSFY_API_BASE must be https, or http on localhost: ${base}\n`);
  }
  for (const args of commands) {
    check(w.run(args, {
      OPSFY_API_BASE: "http://evil.example", OPSFY_CATALOG: path.join(w.root, "absent"),
      OPSFY_NO_COUNT: "1", OPSFY_DRY_RUN: "1",
    }), 2, "", ["login", "logout", "key", "logs"].includes(args[0])
      ? "OPSFY_API_BASE must be https, or http on localhost, with no username, password, query or fragment\n"
      : "OPSFY_API_BASE must be https, or http on localhost: http://evil.example\n");
  }
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_CATALOG beats OPSFY_CATALOG_URL, which beats OPSFY_API_BASE", (t) => {
  const w = world(t);
  const custom = [tool()];
  const extra = {
    OPSFY_CATALOG: w.catalog(custom), OPSFY_CATALOG_URL: "https://catalog.example.test/review.json",
    OPSFY_API_BASE: "https://staging.opsfy.ai", OPSFY_DRY_RUN: "1",
  };
  check(w.run(["list", "--json"], extra), 0, JSON.stringify({ tools: custom }, null, 2) + "\n", "");
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined }), 0,
    JSON.stringify(bundled, null, 2) + "\n", "dry-run: GET https://catalog.example.test/review.json\n");
  check(w.run(["list", "--json"], { ...extra, OPSFY_CATALOG: undefined, OPSFY_CATALOG_URL: undefined }), 0,
    JSON.stringify(bundled, null, 2) + "\n", "dry-run: GET https://staging.opsfy.ai/tools.json\n");
  assert.deepEqual(fs.readdirSync(w.home), []);
});

require("./wallet.test.js");
