#!/usr/bin/env node
"use strict";

const { version } = require("../package.json");
const { load, find, BUCKETS, HEADINGS } = require("../lib/catalog.js");
const { install } = require("../lib/install.js");
const { ENDPOINTS, validateBase, request } = require("../lib/api.js");
const { out, err } = require("../lib/output.js");

function help() {
  [
    `opsfy ${version} · one key for all your tools · https://opsfy.ai`,
    "",
    "  opsfy list                  the tools: free (install now), paid (not open yet), coming soon",
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
    "  opsfy logs [--json]         your balance and paid top-ups",
    "",
    "  --json                      one JSON answer for an agent, for each topup command",
    "",
    "Mac today; Windows and Linux next. opsfy never runs as root.",
  ].forEach((line) => out(line));
}

function refusal(tool, argument) {
  if (!tool) {
    out(`${argument} is not in the catalogue. Ask for it: opsfy ask ${argument}`);
  } else if (tool.bucket === "paid") {
    out(`${tool.name} is a paid tool. Paid tools are not open yet.`);
  } else if (tool.bucket === "soon") {
    out(`${tool.name} is coming soon.`);
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

async function post(url, fields, success) {
  try {
    await request("POST", url, fields);
    out(success);
    return 0;
  } catch (error) {
    out(`could not reach opsfy.ai: ${error.message}. Join at https://opsfy.ai`);
    return 1;
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (["login", "logout", "key"].includes(command)) {
    return require("../lib/auth.js").run(command, args);
  }

  if (["topup", "logs"].includes(command)) {
    return require("../lib/wallet.js").run(command, args);
  }

  try {
    validateBase();
  } catch (error) {
    err(error.message);
    return 2;
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      return 0;

    case "--version":
    case "-v":
    case "version":
      out(version);
      return 0;

    case "list": {
      const catalog = await load();
      if (args.includes("--json")) out(JSON.stringify(catalog, null, 2));
      else list(catalog);
      return 0;
    }

    case "install": {
      if (!args.length) {
        err("usage: opsfy install <app>");
        return 2;
      }
      const tool = find(await load(), args[0]);
      if (refusal(tool, args[0])) return 2;
      return install(tool);
    }

    case "ask": {
      if (!args.length) {
        err("usage: opsfy ask <tool>");
        return 2;
      }
      const name = args.join(" ");
      if (name.length > 120) {
        out("keep it under 120 characters");
        return 2;
      }
      return post(ENDPOINTS.tool, { tool: name }, `ok · asked for ${name} · on the wall at https://opsfy.ai`);
    }

    case "call": {
      if (!args.length) {
        err("usage: opsfy call <tool> ...");
        return 2;
      }
      const tool = find(await load(), args[0].split(".")[0]);
      if (!refusal(tool, args[0])) out(`${tool.name} is a free app: opsfy install ${tool.slug}`);
      return 2;
    }

    default:
      err(`unknown command: ${command}`);
      err("run opsfy --help");
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  err(`opsfy: ${error.message}`);
  process.exitCode = 1;
});
