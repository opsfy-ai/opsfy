"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { ENDPOINTS, request, count } = require("./api.js");
const { out } = require("./output.js");
const { Answer } = require("./answer.js");
const { version } = require("../package.json");

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

function run(command, args, json, options = {}) {
  const child = spawnSync(command, args, { stdio: json ? [0, 2, 2] : "inherit", env: process.env, ...options });
  return child.status === null ? 1 : child.status;
}

async function install(tool, answer = new Answer()) {
  const fields = { tool: tool.slug, name: tool.name };
  const progress = message => { if (!answer.json) out(message); };
  const success = (status, extra, message) => answer.success({ status, ...fields, ...extra }, message);
  const failure = (code, message, extra = {}) => answer.failure(code, message, { ...fields, ...extra }, out);
  const platform = process.env.OPSFY_PLATFORM || process.platform;
  if (platform !== "darwin") {
    failure("unsupported_platform", `opsfy install works only on a Mac today, and this computer runs ${platform}; nothing was changed · ask the person to install ${tool.name} from ${tool.url}`);
    return 2;
  }

  const recipe = tool.install;
  if (!validRecipe(recipe)) {
    failure("update_needed", `this opsfy (${version}) cannot install ${tool.name} · run npm i -g @opsfy/cli@latest, then run opsfy install ${tool.slug} --json again`);
    return 2;
  }

  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    failure("runs_as_root", "opsfy install never runs as root; nothing was changed · run it again as the person's own user, without sudo");
    return 2;
  }

  let list;
  try {
    list = await request("GET", ENDPOINTS.pulled);
  } catch {
    failure("safety_check_unavailable", `opsfy.ai could not be reached to check that ${tool.name} is safe to install; nothing was changed · wait 60 seconds, then run opsfy install ${tool.slug} --json again`);
    return 2;
  }
  if (list.pulled.includes(tool.slug)) {
    failure("pulled", `opsfy has stopped installs of ${tool.name} while it is checked; nothing was changed · run opsfy find "<job>" --json for another`);
    return 2;
  }

  const source = recipe.kind === "cask" ? "release" : "repo";
  const url = tool.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  progress(`${tool.name} · ${tool.licence ?? "free"} · from the upstream ${source} · ${url}`);

  if (recipe.kind === "cask") {
    if (!onPath("brew")) {
      failure("needs_homebrew", `${tool.name} installs with Homebrew, which is not on this Mac; nothing was changed · ask the person to install Homebrew from https://brew.sh, then run opsfy install ${tool.slug} --json again`);
      return 2;
    }

    if (process.env.OPSFY_DRY_RUN === "1") {
      success("dry_run", { would_run: [`brew install --cask ${recipe.cask}`] }, `OPSFY_DRY_RUN=1 is set, so install did not run; it would run: brew install --cask ${recipe.cask} · unset OPSFY_DRY_RUN to install`);
      return 0;
    }

    progress(`installing with Homebrew: brew install --cask ${recipe.cask}`);
    const code = run("brew", ["install", "--cask", recipe.cask], answer.json, {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
    });
    if (code === 0) success("installed", { via: "homebrew" }, `install · installed · ${tool.name}`);
    else failure("install_failed", `brew install --cask ${recipe.cask} stopped with exit code ${code} · read Homebrew's message above, then run opsfy install ${tool.slug} --json again`, { step: "homebrew", exit_code: code });
    await count(tool.slug, code === 0);
    return code === 0 ? 0 : 1;
  }

  const required = new Set(["git", ...(recipe.needs || [])]);
  const needed = PREREQUISITES.filter((name) => required.has(name));
  const missing = needed.filter((name) => !onPath(name));
  if (missing.length) {
    failure("missing_tools", `${tool.name} needs ${joinedNames(needed.map((name) => NAMES[name]))}, and this Mac lacks ${joinedNames(missing.map((name) => NAMES[name]))}; nothing was changed · ask the person to install ${joinedNames(missing.map((name) => HINTS[name]))}, then run opsfy install ${tool.slug} --json again`, { missing });
    return 2;
  }

  const directory = path.join(os.homedir(), recipe.dir.slice(2));
  if (fs.existsSync(directory)) {
    success("already_installed", { dir: recipe.dir }, `install · already installed · ${tool.name} · ${recipe.dir}`);
    return 0;
  }

  if (process.env.OPSFY_DRY_RUN === "1") {
    const wouldRun = [
      `git clone --single-branch --depth 1 ${recipe.repo} ${recipe.dir}`,
      ...(recipe.setup ? [`${recipe.dir}/setup`] : []),
    ];
    success("dry_run", { would_run: wouldRun }, `OPSFY_DRY_RUN=1 is set, so install did not run; it would run: ${wouldRun.join(", then ")} · unset OPSFY_DRY_RUN to install`);
    return 0;
  }

  progress(`cloning into ${recipe.dir}${recipe.setup ? " and running its setup" : ""}`);
  const cloneCode = run("git", ["clone", "--single-branch", "--depth", "1", recipe.repo, directory], answer.json);
  if (cloneCode !== 0) {
    failure("install_failed", `git clone stopped with exit code ${cloneCode}; nothing was installed · read git's message above, then run opsfy install ${tool.slug} --json again`, { step: "git", exit_code: cloneCode });
    await count(tool.slug, false);
    return 1;
  }

  if (recipe.setup) {
    const setupCode = run(path.join(directory, "setup"), [], answer.json, { cwd: directory });
    if (setupCode !== 0) {
      failure("install_failed", `${recipe.dir}/setup stopped with exit code ${setupCode}; the files are cloned in ${recipe.dir} · read the setup's message above, fix what it reports, then run ${recipe.dir}/setup`, { step: "setup", exit_code: setupCode });
      await count(tool.slug, false);
      return 1;
    }
  }

  success("installed", { via: "git", dir: recipe.dir }, `install · installed · ${tool.name} · ${recipe.dir}`);
  await count(tool.slug, true);
  return 0;
}

module.exports = { install, validRecipe };
