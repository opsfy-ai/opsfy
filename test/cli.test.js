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
  const log = path.join(root, "calls.log");
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
        PATH: bin,
        TMPDIR: root,
        FAKE_LOG: log,
        FAKE_MARKER: "inherited-by-installers",
        FAKE_SETUP_SCRIPT: setupScript,
        OPSFY_CATALOG: BUNDLED,
        OPSFY_NO_COUNT: "1",
        OPSFY_PLATFORM: "darwin",
        ...extra,
      };
      const nodeArgs = [
        "-e",
        'globalThis.fetch = async () => { process.stderr.write("unexpected fetch in test\\n"); throw new Error("unexpected fetch in test"); };\n' +
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
  const expected = [
    "opsfy 0.2.0 · one key for all your tools · https://opsfy.ai",
    "",
    "  opsfy list                  the tools: free (install now), paid (waitlist), coming soon",
    "  opsfy install <app>         install a free app on this Mac, from its upstream source",
    "  opsfy ask <tool>            ask for a tool; it shows on the wall at opsfy.ai",
    "  opsfy login                 get your key (paid tools open by waitlist)",
    "  opsfy call <tool> ...       call a paid tool off your balance",
    "  opsfy logs                  your calls, priced",
    "",
    "Mac today; Windows and Linux next. opsfy never runs as root.",
    "",
  ].join("\n");
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    check(w.run(args, { OPSFY_CATALOG: path.join(w.root, "absent") }), 0, expected, "");
  }
  for (const alias of ["--version", "-v", "version"]) {
    check(w.run([alias]), 0, "0.2.0\n", "");
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
    [["login", "--email"], "usage: opsfy login [--email you@example.com]\n"],
    [["login", "someone@somewhere.test"], "usage: opsfy login [--email you@example.com]\n"],
    [["login", "--email", "a@b.co", "extra"], "usage: opsfy login [--email you@example.com]\n"],
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
  assert.equal(groups[1].split("\n")[0], "Paid · by waitlist · opsfy login --email you@example.com");
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
    "Paid · by waitlist · opsfy login --email you@example.com\n\nComing soon\n", "");
  check(w.run(["install", "XYZ"], extra), 0);
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "second"] }]);
});

test("cask output stays ordered around inherited child output and preserves its environment", (t) => {
  const w = world(t);
  const result = w.run(["install", "OpenWork"], { FAKE_BREW_OUTPUT: "from the child" });
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
  const result = w.run(["install", "uNsLoTh DeSkToP"]);
  check(result, 0, "Unsloth Desktop · free · from the upstream release · unsloth.ai/docs/desktop\n" +
    "installing with Homebrew: brew install --cask unsloth\nok · installed · Unsloth Desktop\n",
  "");
  assert.deepEqual(w.calls(), [{ command: "brew", args: ["install", "--cask", "unsloth"] }]);
});

test("a failed cask preserves the child status in its message", (t) => {
  const w = world(t);
  check(w.run(["install", "openwork"], { FAKE_BREW_EXIT: "3" }), 1,
    OPENWORK + "installing with Homebrew: brew install --cask openwork\nfailed · Homebrew exited 3\n",
    "");
  assert.equal(w.calls().length, 1);
});

test("install counts can be disabled for both success and failure", (t) => {
  const w = world(t);
  for (const code of ["0", "8"]) {
    check(w.run(["install", "openwork"], { OPSFY_NO_COUNT: "1", FAKE_BREW_EXIT: code }),
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
    const result = w.run(["install", "openwork"]);
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
  check(w.run(["install", "openwork"]), 0);
  check(w.run(["install", "gstack"]), 0);
  assert.deepEqual(w.calls().map((call) => call.command), ["brew", "git", "setup"]);
});

test("git installs clone once, run setup in the target, and do nothing on a second install", (t) => {
  const w = world(t);
  const target = path.join(w.home, ".claude/skills/gstack");
  check(w.run(["install", "gstack"]), 0,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nok · installed · gstack · ~/.claude/skills/gstack\n",
    "");
  assert.deepEqual(w.calls(), [
    { command: "git", args: ["clone", "--single-branch", "--depth", "1", "https://github.com/garrytan/gstack.git", target] },
    { command: "setup", args: [], cwd: fs.realpathSync(target) },
  ]);
  assert.equal(fs.readFileSync(w.log, "utf8").match(/MARKER=inherited-by-installers/g).length, 2);
  w.reset();
  const again = w.run(["install", "gstack"]);
  check(again, 0, GSTACK + "already installed · gstack · ~/.claude/skills/gstack\n", "");
  noInstall(w, again);
});

test("a failed clone does not attempt setup", (t) => {
  const w = world(t);
  check(w.run(["install", "gstack"], { FAKE_GIT_EXIT: "7" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nfailed · git exited 7\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git"]);
});

test("a failed setup reports failure after the successful clone", (t) => {
  const w = world(t);
  check(w.run(["install", "gstack"], { FAKE_SETUP_EXIT: "4" }), 1,
    GSTACK + "cloning into ~/.claude/skills/gstack and running its setup\nfailed · setup exited 4\n",
    "");
  assert.deepEqual(w.calls().map((call) => call.command), ["git", "setup"]);
});

test("a git recipe without setup or needs requires only Git and clones without setup", (t) => {
  const w = world(t, ["git"]);
  const filename = w.catalog([tool({ install: { kind: "git", repo: "https://github.com/example/demo", dir: "~/.local/share/demo" } })]);
  check(w.run(["install", "demo"], { OPSFY_CATALOG: filename }), 0,
    "Demo · free · from the upstream repo · opsfy.ai/demo\ncloning into ~/.local/share/demo\n" +
    "ok · installed · Demo · ~/.local/share/demo\n",
    "");
  assert.deepEqual(w.calls(), [{ command: "git", args: ["clone", "--single-branch", "--depth", "1",
    "https://github.com/example/demo", path.join(w.home, ".local/share/demo")] }]);
});

test("missing prerequisites are deduplicated, ordered and never probed", (t) => {
  const w = world(t, []);
  const result = w.run(["install", "gstack"]);
  check(result, 2, GSTACK + "needs Git, Bun and Claude Code. Missing: Git (xcode-select --install), " +
    "Bun (brew install oven-sh/bun/bun), Claude Code (npm i -g @anthropic-ai/claude-code)\nstopped · nothing changed\n", "");
  noInstall(w, result);
  for (const name of ["git", "claude"]) fs.writeFileSync(path.join(w.bin, name), fakeScripts[name], { mode: 0o755 });
  check(w.run(["install", "gstack"]), 2, GSTACK +
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
    check(result, 2, "Demo cannot be installed by this version of opsfy. Update it: npm i -g opsfy\n", "");
    noInstall(w, result);
  }
});

test("unknown, paid and coming-soon installs print their exact refusal without counting", (t) => {
  const w = world(t);
  const cases = [
    ["missing", "missing is not in the catalogue. Ask for it: opsfy ask missing\n"],
    ["elevenlabs", "ElevenLabs is a paid tool. Paid tools open by waitlist: opsfy login --email you@example.com\n"],
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
  const extra = { OPSFY_DRY_RUN: "1", OPSFY_API_BASE: "https://opsfy.ai" };
  check(w.run(["login"], extra), 0, "Keys open with the paid tools, by waitlist. Join it: opsfy login --email you@example.com\n", "");
  check(w.run(["login", "--email", "a+b@c.co"], extra), 0, "ok · a+b@c.co is on the waitlist\n",
    "dry-run: POST https://opsfy.ai/api/key email=a%2Bb%40c.co\n");
  for (const address of ["nope", "@b.co", "a b@c.co", "a@b", "a@b@c.co"]) {
    check(w.run(["login", "--email", address], extra), 2, `that is not an email address: ${address}\n`, "");
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("call uses the part before the first dot and logs makes no request", (t) => {
  const w = world(t);
  const cases = [
    ["elevenlabs.speak", "ElevenLabs is a paid tool. Paid tools open by waitlist: opsfy login --email you@example.com\n"],
    ["OpenWork.run", "OpenWork is a free app: opsfy install openwork\n"],
    ["qoder.run", "Qoder is coming soon.\n"],
    ["missing.run", "missing.run is not in the catalogue. Ask for it: opsfy ask missing.run\n"],
  ];
  for (const [name, output] of cases) check(w.run(["call", name, "payload"]), 2, output, "");
  check(w.run(["logs"]), 0, "No key yet. Keys open with the paid tools, by waitlist.\n", "");
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("geteuid root is refused before either recipe branch, including OPSFY_DRY_RUN", (t) => {
  const w = world(t);
  for (const slug of ["openwork", "gstack"]) {
    for (const dryRun of [undefined, "1"]) {
      const result = w.run(["install", slug], { OPSFY_DRY_RUN: dryRun, OPSFY_NO_COUNT: "0" },
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
  check(w.run(["install", "openwork"], { FAKE_SIGNAL: "brew" }), 1, expected, "");
  assert.equal(w.calls().length, 1);
  w.reset();
  fs.writeFileSync(path.join(w.bin, "brew"), "#!/no-such-opsfy-interpreter\n", { mode: 0o755 });
  check(w.run(["install", "openwork"]), 1, expected, "");
  assert.deepEqual(w.calls(), []);
});

test("OPSFY_DRY_RUN previews a cask without installers, home changes or install counts", (t) => {
  const w = world(t);
  const result = w.run(["install", "openwork"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" });
  check(result, 0, OPENWORK + "dry-run · would run · brew install --cask openwork\n" +
    "dry-run · nothing was installed and nothing was sent\n", "");
  noInstall(w, result);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("OPSFY_DRY_RUN previews a git clone and setup without creating the target or counting", (t) => {
  const w = world(t);
  const result = w.run(["install", "gstack"], { OPSFY_DRY_RUN: "1", OPSFY_NO_COUNT: "0" });
  check(result, 0, GSTACK +
    "dry-run · would clone · https://github.com/garrytan/gstack.git into ~/.claude/skills/gstack\n" +
    "dry-run · would run · ~/.claude/skills/gstack/setup\n" +
    "dry-run · nothing was installed and nothing was sent\n", "");
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
    "dry-run · nothing was installed and nothing was sent\n", "");
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
      "Demo cannot be installed by this version of opsfy. Update it: npm i -g opsfy\n"],
    [["install", "openwork"], {}, OPENWORK +
      "needs Homebrew. Install it from https://brew.sh, then run this again.\nstopped · nothing changed\n"],
    [["install", "gstack"], {}, GSTACK +
      "needs Git, Bun and Claude Code. Missing: Git (xcode-select --install), " +
      "Bun (brew install oven-sh/bun/bun), Claude Code (npm i -g @anthropic-ai/claude-code)\nstopped · nothing changed\n"],
  ];
  for (const [args, overrides, expected] of cases) {
    const result = w.run(args, { ...extra, ...overrides });
    check(result, 2, expected, "");
    noInstall(w, result);
  }
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test("install counts send each slug and outcome once to OPSFY_API_BASE through stubbed fetch", (t) => {
  const cases = [
    ["openwork", {}, true],
    ["openwork", { FAKE_BREW_EXIT: "3" }, false],
    ["gstack", {}, true],
    ["gstack", { FAKE_GIT_EXIT: "7" }, false],
    ["gstack", { FAKE_SETUP_EXIT: "4" }, false],
  ];
  for (const [base, endpoint] of [
    [undefined, "https://opsfy.ai/api/install"],
    ["https://staging.opsfy.ai///", "https://staging.opsfy.ai/api/install"],
  ]) {
    for (const [slug, extra, ok] of cases) {
      const w = world(t);
      const requests = path.join(w.root, "requests.json");
      const prelude = `
        const sent = [];
        globalThis.fetch = async (url, options) => {
          sent.push({ url: String(url), method: options.method, body: options.body });
          return { ok: true };
        };
        process.on("exit", () => {
          require("node:fs").writeFileSync(process.env.FAKE_FETCH_LOG, JSON.stringify(sent));
        });
      `;
      const result = w.run(["install", slug], {
        OPSFY_NO_COUNT: "0", OPSFY_API_BASE: base, FAKE_FETCH_LOG: requests, ...extra,
      }, prelude);
      check(result, ok ? 0 : 1, undefined, "");
      assert.deepEqual(JSON.parse(fs.readFileSync(requests, "utf8")), [{
        url: endpoint, method: "POST", body: `tool=${slug}&ok=${ok ? "1" : "0"}`,
      }]);
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
  check(w.run(["login", "--email", "a+b@c.co"], extra), 0,
    "ok · a+b@c.co is on the waitlist\n",
    "dry-run: POST https://staging.opsfy.ai/api/key email=a%2Bb%40c.co\n");
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
      OPSFY_NO_COUNT: "0",
    }), 2, "", "OPSFY_API_BASE must be https, or http on localhost: http://evil.example\n");
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
