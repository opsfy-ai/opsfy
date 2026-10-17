# opsfy

One key and one balance for tools. The agents' guide: https://opsfy.ai/SKILL.md

## For agents

Read https://opsfy.ai/SKILL.md first and save it as a skill named opsfy: it has every command, JSON answer and
error code, and it is kept current. When `opsfy --version` is newer than your copy, read it again.

The usual order:

1. Find: `opsfy find "<the job in two or three words>" --json`
2. Read: `opsfy info <tool> --json` shows its inputs, their limits and, once logged in, its price.
3. Call: `opsfy call <tool> "<input>" --json`, or `--input name=value` for named inputs.
4. Check: `opsfy logs --json` shows what each call cost and the balance left. Tell the person.

Every paid call comes out of the person's balance. Check the price with `opsfy info <tool>` first.
Never repeat a call that may have gone through: read `opsfy logs` first.
Ask the person only for their email, the code and paying. Run everything else yourself.
Never show, share or store the key outside opsfy.

## Install

    npm i -g @opsfy/cli

Needs Node.js 20 or newer. `opsfy install` works on a Mac today, Windows and Linux next; the other commands work anywhere.
To install from this repository instead: `npm i -g opsfy-ai/opsfy`
If npm answers `EEXIST`, an opsfy older than 0.2.1 is installed: run `npm uninstall -g opsfy`, then install again.

## Commands

```text
- opsfy list: the library: pay as you go, one-command install, self-serve
- opsfy find <words>: find a tool for a job
- opsfy info <tool>: read its inputs and price
- opsfy install <app>: install a free app on this Mac
- opsfy ask <tool>: ask for a tool; it shows on the wall at opsfy.ai
- opsfy call <tool> "<input>": call an open tool; each call is paid from the balance; --input name=value or --input-file path supplies named inputs
- opsfy login --email <email>: send a login code to the email; then add --code <code>
- opsfy key: the account's email and the key's last four characters
- opsfy key rotate: replace the key; the old one stops working
- opsfy logout: log out; the key stops working
- opsfy logout --all: stop every key on the account; then run opsfy login --email <email> --json
- opsfy topup <amount>: start a top-up of $10, $25, $50, $100, $250 or $500; the person pays on a Stripe page
- opsfy topup wait <id>: wait until a top-up is paid, cancelled or expired
- opsfy topup status <id>: whether a top-up is open, paid, cancelled or expired
- opsfy logs: the balance, then each top-up and call with its id, time and amount
```

Add --json to any command for one line of JSON. Every answer has "ok": true when the command did its job, or "ok": false with an "error" code and a "message": the plain line without its code, which says what happened, with the exact numbers, and the command to run next or what to ask the person. The exit codes stay the same. With --json, opsfy never asks a question and never opens a browser; an app's own installer prints to standard error and may still ask its own questions.

A person at a terminal can leave out `--json`: `opsfy login` asks for the email and the code; `opsfy topup` asks for
the amount, opens the payment page (on a computer without a desktop it prints the link) and waits.

Run `opsfy login --email <email> --json`, ask the person for the code, then add `--code <code>`. Each computer keeps its own key; logging in again replaces only the keys saved on that computer. Run `opsfy logout --json` to stop its key. With CLI 0.7.0 or newer, run `opsfy logout --all --json` to stop every key on the account, then log in again. A wiped computer or a CLI older than 0.7.0 can leave an earlier key active; `opsfy logout --all --json` stops it.

## What opsfy sends and keeps

- A call: the tool and its input go to opsfy.ai, which passes them to the tool. Opsfy keeps the tool, time, price
  and outcome, never the inputs or results.
- Login: the email goes to opsfy.ai, which emails a code. The key is saved in `~/.opsfy/key`, readable only by this
  user, and never shown in full.
- Prices: when logged in, `opsfy list` and `opsfy info` send the key to opsfy.ai to show prices.
- The library: read from opsfy.ai once a day; when that fails, the saved or bundled copy answers.
- `opsfy install`: first reads opsfy.ai's list of stopped apps, sending nothing about the app, and installs nothing
  if it cannot check. Then it sends a count: the app's name, whether it installed, and a random install id made
  once in `~/.opsfy/id`. `OPSFY_NO_COUNT=1` stops the count and the id; deleting `~/.opsfy/id` makes a new one.
- `opsfy ask`: sends the words given to the wall at opsfy.ai.

An app's installer runs its maker's code on this computer. `opsfy install` never runs as root and never installs a
missing prerequisite: it answers `needs_homebrew` or `missing_tools` with the one line to run, and stops.

## Settings

| Variable | Effect |
| --- | --- |
| `OPSFY_API_KEY` | use this key instead of logging in, for example on a server |
| `OPSFY_HOME` | where the key, the install id and the list of tools are kept; the default is ~/.opsfy |
| `OPSFY_NO_COUNT=1` | stop install counts and the install id (a count holds the app's name, whether it installed, and a random install id kept in ~/.opsfy/id) |
| `OPSFY_DRY_RUN=1` | install and ask say what they would do and do nothing; call, logs, topup, login, logout and key refuse with dry_run |
| `OPSFY_CATALOG=<file>` | use only this local catalogue file; a bad file answers internal |
| `OPSFY_CATALOG_URL=<url>` | read the library from this address instead; OPSFY_CATALOG still comes first |
| `OPSFY_API_BASE=<url>` | the address for every request; default https://opsfy.ai; HTTPS, or HTTP only on 127.0.0.1, localhost or ::1 |
| `OPSFY_PLATFORM=<darwin\|linux\|win32>` | for tests: act as this platform |

## Development

Run `npm test` from this package folder, or `node --test --test-reporter=tap test/cli.test.js` for TAP output. The tests use disposable homes, an isolated PATH, fake installers, stubbed fetch, and explicitly requested dry runs. They clean up their scratch folders and need no network or installed prerequisites.

## License

MIT. See LICENSE.
