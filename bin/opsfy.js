#!/usr/bin/env node
"use strict";

const { version } = require("../package.json");
const { load, find, BUCKETS, HEADINGS } = require("../lib/catalog.js");
const { install } = require("../lib/install.js");
const { ENDPOINTS, validateBase, request } = require("../lib/api.js");
const { out } = require("../lib/output.js");
const { Answer } = require("../lib/answer.js");
const { tools } = require("../lib/tool-inputs.js");

function help(answer) {
  const lines = [
    `opsfy ${version} · one key and one balance for tools · the agents' guide: https://opsfy.ai/SKILL.md`,
    "",
    "  opsfy list                     the library: pay as you go, one-command install, self-serve",
    "  opsfy find <words>             find a tool for a job",
    "  opsfy info <tool>              read its inputs and price",
    "  opsfy install <app>            install a free app on this Mac, from its upstream source",
    "  opsfy ask <tool>               ask for a tool; it shows on the wall at opsfy.ai",
    "  opsfy login --email <email>    send a login code to the email; then add --code <code>",
    "  opsfy key                      the account's email and the key's last four characters",
    "  opsfy key rotate               replace your key with a new one",
    "  opsfy logout                   log out; your key stops working",
    "  opsfy logout --all             stop every key on this account; then log in again",
    "  opsfy topup <amount>           start a top-up of $10, $25, $50, $100, $250 or $500; the person pays on a Stripe page",
    "  opsfy topup wait <id>          wait until a top-up is paid, cancelled or expired",
    "  opsfy topup status <id>        whether a top-up is open, paid, cancelled or expired",
    '  opsfy call <tool> "<input>"    call a tool; each call is paid from the balance',
    "    --input <name>=<value>       set an input; repeat for more inputs",
    "    --input-file <path|->        read a JSON object from a file or standard input",
    "  opsfy logs                     the balance, then each top-up and call with its id, time and amount",
    "",
    "  --json                         one line of JSON on every command; use it always",
    "",
    "opsfy install works on a Mac today, Windows and Linux next, and never as root; the other commands work anywhere",
  ];
  if (answer.json) answer.success({ help: lines.join("\n") });
  else lines.forEach((line) => out(line));
}

function refusal(tool, argument, answer, catalog) {
  if (!tool) {
    answer.failure("not_in_catalogue", `${argument} is not in opsfy's library · run opsfy find "<job>" --json for one that is, or opsfy ask ${argument} --json to ask for it`,
      { tool: argument }, out);
  } else if (tool.bucket === "paid") {
    if (tool.call) {
      const main = (Object.hasOwn(tools, tool.slug) && tools[tool.slug].main_input) || "input";
      answer.failure("use_call", `${tool.name} is pay as you go: it is called, not installed · run opsfy call ${tool.slug} "<${main}>" --json`,
        { tool: tool.slug, name: tool.name, command: `opsfy call ${tool.slug}` }, out);
    } else {
      const open = catalog.tools.filter(entry => entry.bucket === "paid" && entry.call).map(entry => entry.slug).join(", ") || "none";
      answer.failure("paid_not_open", `${tool.name} is listed but not open yet; open now: ${open} · run opsfy find "<job>" --json for another`,
        { tool: tool.slug, name: tool.name }, out);
    }
  } else if (tool.bucket === "soon") {
    answer.failure("not_installable", `${tool.name} is self-serve, so opsfy cannot install or call it · ask the person to get it at ${tool.url}`,
      { tool: tool.slug, name: tool.name, url: tool.url }, out);
  } else {
    return false;
  }
  return true;
}

function list(catalog) {
  const slugWidth = catalog.tools.reduce((width, tool) => Math.max(width, tool.slug.length + 2), 2);
  BUCKETS.forEach((bucket, index) => {
    if (index) out();
    out(HEADINGS[bucket]);
    for (const tool of catalog.tools) {
      if (tool.bucket === bucket) {
        let suffix = "";
        if (bucket === "paid" && !tool.call) suffix = " · not open yet";
        else if (bucket === "paid" && catalog.prices === "shown" && Object.hasOwn(tool.call, "price_microusd")) {
          const n = BigInt(tool.call.price_microusd);
          const price = "$" + n / 1000000n + "." + String(n % 1000000n).padStart(6, "0").slice(0, n % 100n === 0n ? 4 : 6);
          suffix = ` · ${price} a ${tool.call.unit}`;
        }
        out(`  ${tool.slug.padEnd(slugWidth)}${tool.line}${suffix}`);
      }
    }
    if (bucket === "paid" && catalog.prices === "login_required") out("  the price shows after login: run opsfy login --email <email> --json");
  });
}

async function post(url, fields, success, answer) {
  try {
    await request("POST", url, fields);
    answer.success({ status: process.env.OPSFY_DRY_RUN === "1" ? "dry_run" : "asked", tool: fields.tool }, success);
    return 0;
  } catch (error) {
    answer.failure("unreachable", `opsfy.ai could not be reached (${error.message}) · wait 60 seconds, then run the same command again`, {}, out);
    return 1;
  }
}

async function main(argv, answer) {
  const [command, ...args] = argv;
  if (["login", "logout", "key"].includes(command)) {
    return require("../lib/auth.js").run(command, args, answer);
  }

  if (command === "logs" || (command === "call" &&
      (Object.hasOwn(tools, (args[0] || "").toLowerCase()) || /^tavily(?:\.|$)/i.test(args[0] || "")))) {
    return require("../lib/call.js").run(command, args, answer);
  }

  if (command === "topup") {
    return require("../lib/wallet.js").run(command, args, answer);
  }

  try {
    validateBase();
  } catch (error) {
    answer.failure("bad_api_base", error.message);
    return 2;
  }

  switch (command) {
    case "find":
    case "info":
      return require("../lib/browse.js").run(command, args, answer);
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
      const source = await load();
      const catalog = { ...source, tools: source.tools.map(tool => {
        if (!tool.call) return tool;
        const call = { ...tool.call };
        delete call.price_microusd;
        return { ...tool, call };
      }) };
      delete catalog.prices;
      if (catalog.tools.some(tool => tool.bucket === "paid" && tool.call)) {
        const result = await require("../lib/prices.js").load();
        catalog.prices = result.state;
        if (result.state === "shown") {
          for (const tool of catalog.tools) {
            if (tool.bucket === "paid" && tool.call && Object.hasOwn(result.prices, tool.slug)) {
              tool.call.price_microusd = result.prices[tool.slug];
            }
          }
        }
      }
      if (answer.json) answer.success(catalog);
      else list(catalog);
      return 0;
    }

    case "install": {
      if (!args.length) {
        answer.failure("usage", "no app named · run opsfy install <app> --json; opsfy list --json shows the apps");
        return 2;
      }
      const catalog = await load();
      const tool = find(catalog, args[0]);
      if (refusal(tool, args[0], answer, catalog)) return 2;
      return install(tool, answer);
    }

    case "ask": {
      if (!args.length) {
        answer.failure("usage", 'no tool named · run opsfy ask "<tool>" --json');
        return 2;
      }
      const name = args.join(" ");
      if (name.length > 120) {
        answer.failure("too_long", `the name has ${name.length} characters; the most is 120 · shorten it, then run opsfy ask again`, {}, out);
        return 2;
      }
      return post(ENDPOINTS.tool, { tool: name }, process.env.OPSFY_DRY_RUN === "1"
        ? `OPSFY_DRY_RUN=1 is set, so ask did not send ${name} · unset OPSFY_DRY_RUN to send it`
        : `ask · asked for ${name} · it shows on the wall at https://opsfy.ai`, answer);
    }

    case "call": {
      if (!args.length) {
        answer.failure("usage", 'no tool named · run opsfy call <tool> "<input>" --json; opsfy find "<job>" --json gives the names');
        return 2;
      }
      const catalog = await load();
      const tool = find(catalog, args[0].split(".")[0]);
      if (tool?.bucket === "paid" && tool.call) {
        const browse = require("../lib/browse.js");
        let descriptor = Object.hasOwn(tools, tool.slug) ? tools[tool.slug] : null;
        if (!descriptor) {
          try { descriptor = await browse.getMetadata(tool.slug); } catch { return browse.infoFailure(answer); }
        }
        return require("../lib/call.js").run(command, [args[0].includes(".") ? args[0] : tool.slug, ...args.slice(1)], answer, descriptor);
      }
      if (!refusal(tool, args[0], answer, catalog)) {
        answer.failure("use_install", `${tool.name} is a free app: it is installed, not called · run opsfy install ${tool.slug} --json`,
          { tool: tool.slug, name: tool.name, command: `opsfy install ${tool.slug}` }, out);
      }
      return 2;
    }

    default:
      answer.failure("unknown_command", `opsfy has no command ${command} · run opsfy --help for the commands`);
      return 2;
  }
}

const argv = process.argv.slice(2);
const answer = new Answer(argv.includes("--json"));
main(argv.filter(value => value !== "--json"), answer).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  answer.failure("internal", error.code === "bad_catalogue" ? error.message :
    `opsfy stopped on an unexpected error (${error.message}) · run the same command again; if it fails again, ask the person to email support@opsfy.ai`);
  process.exitCode = 1;
});
