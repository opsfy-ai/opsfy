#!/usr/bin/env node
"use strict";

const { version } = require("../package.json");
const { load, find, BUCKETS, HEADINGS } = require("../lib/catalog.js");
const { install } = require("../lib/install.js");
const { ENDPOINTS, validateBase, request } = require("../lib/api.js");
const { out, err } = require("../lib/output.js");
const { Answer } = require("../lib/answer.js");

function help(answer) {
  const lines = [
    `opsfy ${version} · one key for all your tools · https://opsfy.ai`,
    "",
    "  opsfy list                  the library: pay as you go, one-command install, self-serve",
    "  opsfy install <app>         install a free app on this Mac, from its upstream source",
    "  opsfy ask <tool>            ask for a tool; it shows on the wall at opsfy.ai",
    "  opsfy login                 log in with your email and a code",
    "  opsfy key                   check your key; shows only its last four characters",
    "  opsfy key rotate            replace your key with a new one",
    "  opsfy logout                log out; your key stops working",
    "  opsfy topup [amount]        add money to your balance on a Stripe page",
    "  opsfy topup wait <id>       wait until a top-up is paid, cancelled or expired",
    "  opsfy topup status <id>     a top-up's state now",
    "  opsfy call <tool> ...       call a paid tool off your balance (not open yet)",
    "  opsfy logs                  your balance and paid top-ups",
    "",
    "  --json                      one JSON answer for an agent, on every command",
    "",
    "Mac today; Windows and Linux next. opsfy never runs as root.",
  ];
  if (answer.json) answer.success({ help: lines.join("\n") });
  else lines.forEach((line) => out(line));
}

function refusal(tool, argument, answer) {
  if (!tool) {
    answer.failure("not_in_catalogue", `${argument} is not in the catalogue. Ask for it: opsfy ask ${argument}`,
      { tool: argument }, out);
  } else if (tool.bucket === "paid") {
    answer.failure("paid_not_open", `${tool.name} is a paid tool. Paid tools are not open yet.`,
      { tool: tool.slug, name: tool.name }, out);
  } else if (tool.bucket === "soon") {
    answer.failure("not_installable", `${tool.name} is self-serve: get it at ${tool.url}`,
      { tool: tool.slug, name: tool.name, url: tool.url }, out);
  } else {
    return false;
  }
  return true;
}

function list(catalog) {
  const slugWidth = catalog.tools.reduce((width, tool) => Math.max(width, tool.slug.length + 2), 2);
  const nameWidth = catalog.tools.reduce((width, tool) => Math.max(width, tool.name.length + 2), 2);
  BUCKETS.forEach((bucket, index) => {
    if (index) out();
    out(HEADINGS[bucket]);
    for (const tool of catalog.tools) {
      if (tool.bucket === bucket) {
        out(`  ${tool.slug.padEnd(slugWidth)}${tool.name.padEnd(nameWidth)}${tool.line}`);
      }
    }
  });
}

async function post(url, fields, success, answer) {
  try {
    await request("POST", url, fields);
    answer.success({ status: process.env.OPSFY_DRY_RUN === "1" ? "dry_run" : "asked", tool: fields.tool }, success);
    return 0;
  } catch (error) {
    answer.failure("unreachable", `could not reach opsfy.ai: ${error.message}. Join at https://opsfy.ai`, {}, out);
    return 1;
  }
}

async function main(argv, answer) {
  const [command, ...args] = argv;
  if (["login", "logout", "key"].includes(command)) {
    return require("../lib/auth.js").run(command, args, answer);
  }

  if (["topup", "logs"].includes(command)) {
    return require("../lib/wallet.js").run(command, args, answer);
  }

  try {
    validateBase();
  } catch (error) {
    answer.failure("bad_api_base", error.message);
    return 2;
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help(answer);
      return 0;

    case "--version":
    case "-v":
    case "version":
      answer.success({ version }, version);
      return 0;

    case "list": {
      const catalog = await load();
      if (answer.json) answer.success(catalog);
      else list(catalog);
      return 0;
    }

    case "install": {
      if (!args.length) {
        answer.failure("usage", "usage: opsfy install <app>");
        return 2;
      }
      const tool = find(await load(), args[0]);
      if (refusal(tool, args[0], answer)) return 2;
      return install(tool, answer);
    }

    case "ask": {
      if (!args.length) {
        answer.failure("usage", "usage: opsfy ask <tool>");
        return 2;
      }
      const name = args.join(" ");
      if (name.length > 120) {
        answer.failure("too_long", "keep it under 120 characters", {}, out);
        return 2;
      }
      return post(ENDPOINTS.tool, { tool: name }, `ok · asked for ${name} · on the wall at https://opsfy.ai`, answer);
    }

    case "call": {
      if (!args.length) {
        answer.failure("usage", "usage: opsfy call <tool> ...");
        return 2;
      }
      const tool = find(await load(), args[0].split(".")[0]);
      if (!refusal(tool, args[0], answer)) {
        answer.failure("use_install", `${tool.name} is a free app: opsfy install ${tool.slug}`,
          { tool: tool.slug, name: tool.name, command: `opsfy install ${tool.slug}` }, out);
      }
      return 2;
    }

    default:
      if (answer.json) answer.failure("unknown_command", `unknown command: ${command} · run opsfy --help`);
      else {
        err(`unknown command: ${command}`);
        err("run opsfy --help");
      }
      return 2;
  }
}

const argv = process.argv.slice(2);
const answer = new Answer(argv.includes("--json"));
main(argv.filter(value => value !== "--json"), answer).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  answer.failure("internal", `opsfy: ${error.message}`);
  process.exitCode = 1;
});
