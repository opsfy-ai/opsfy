"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { count } = require("./api.js");
const { out } = require("./output.js");

const PREREQUISITES = ["git", "bun", "claude"];
const NAMES = { git: "Git", bun: "Bun", claude: "Claude Code" };
const HINTS = {
  git: "Git (xcode-select --install)",
  bun: "Bun (brew install oven-sh/bun/bun)",
  claude: "Claude Code (npm i -g @anthropic-ai/claude-code)",
};

function matches(value, pattern) {
  return typeof value === "string" && value.match(pattern)?.[0] === value;
}

function validRecipe(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return false;
  if (recipe.kind === "cask") {
    return matches(recipe.cask, /^[a-z0-9][a-z0-9@+._-]*$/);
  }
  if (recipe.kind !== "git") return false;
  return matches(recipe.repo, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/) &&
    matches(recipe.dir, /^~\/[A-Za-z0-9_./-]+$/) && !recipe.dir.split("/").includes("..") &&
    (!Object.hasOwn(recipe, "setup") || recipe.setup === "./setup") &&
    (!Object.hasOwn(recipe, "needs") ||
      (Array.isArray(recipe.needs) && recipe.needs.every((name) => PREREQUISITES.includes(name))));
}

function onPath(name) {
  if (process.env.PATH === undefined) return false;
  return process.env.PATH.split(path.delimiter).some((directory) => {
    const filename = path.join(directory, name);
    try {
      fs.accessSync(filename, fs.constants.X_OK);
      return fs.statSync(filename).isFile();
    } catch {
      return false;
    }
  });
}

function joinedNames(names) {
  if (names.length < 2) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, { stdio: "inherit", env: process.env, ...options });
  return child.status === null ? 1 : child.status;
}

async function install(tool) {
  if ((process.env.OPSFY_PLATFORM || process.platform) !== "darwin") {
    out("Mac today; Windows and Linux next. Nothing was changed.");
    return 2;
  }

  const recipe = tool.install;
  if (!validRecipe(recipe)) {
    out(`${tool.name} cannot be installed by this version of opsfy. Update it: npm i -g opsfy`);
    return 2;
  }

  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    out("stopped · nothing changed");
    return 2;
  }

  const source = recipe.kind === "cask" ? "release" : "repo";
  const url = tool.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  out(`${tool.name} · ${tool.licence ?? "free"} · from the upstream ${source} · ${url}`);

  if (recipe.kind === "cask") {
    if (!onPath("brew")) {
      out("needs Homebrew. Install it from https://brew.sh, then run this again.");
      out("stopped · nothing changed");
      return 2;
    }

    out(`installing with Homebrew: brew install --cask ${recipe.cask}`);
    const code = run("brew", ["install", "--cask", recipe.cask], {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
    });
    out(code === 0 ? `ok · installed · ${tool.name}` : `failed · Homebrew exited ${code}`);
    await count(tool.slug, code === 0);
    return code === 0 ? 0 : 1;
  }

  const required = new Set(["git", ...(recipe.needs || [])]);
  const needed = PREREQUISITES.filter((name) => required.has(name));
  const missing = needed.filter((name) => !onPath(name));
  if (missing.length) {
    out(`needs ${joinedNames(needed.map((name) => NAMES[name]))}. Missing: ${missing.map((name) => HINTS[name]).join(", ")}`);
    out("stopped · nothing changed");
    return 2;
  }

  const directory = path.join(os.homedir(), recipe.dir.slice(2));
  if (fs.existsSync(directory)) {
    out(`already installed · ${tool.name} · ${recipe.dir}`);
    return 0;
  }

  out(`cloning into ${recipe.dir}${recipe.setup ? " and running its setup" : ""}`);
  const cloneCode = run("git", ["clone", "--single-branch", "--depth", "1", recipe.repo, directory]);
  if (cloneCode !== 0) {
    out(`failed · git exited ${cloneCode}`);
    await count(tool.slug, false);
    return 1;
  }

  if (recipe.setup) {
    const setupCode = run(path.join(directory, "setup"), [], { cwd: directory });
    if (setupCode !== 0) {
      out(`failed · setup exited ${setupCode}`);
      await count(tool.slug, false);
      return 1;
    }
  }

  out(`ok · installed · ${tool.name} · ${recipe.dir}`);
  await count(tool.slug, true);
  return 0;
}

module.exports = { install, validRecipe };
