# opsfy

One key for all your tools.

https://opsfy.ai

Requires Node.js 20 or newer. Install the command with:

```sh
npm i -g @opsfy/cli
```

The same install works straight from this repo: `npm i -g opsfy-ai/opsfy`.

Installed opsfy before 0.2.1? Remove the old one first: `npm uninstall -g opsfy`.

Mac today; Windows and Linux next.

```text
opsfy list
opsfy list --json
opsfy install <app>
opsfy ask <tool>
opsfy login
opsfy login --email you@example.com
opsfy login --email you@example.com --code 123456
opsfy key
opsfy key rotate
opsfy logout
opsfy topup
opsfy topup 25
opsfy topup 10 --json
opsfy topup wait <id> --json
opsfy topup status <id> --json
opsfy call <tool> ...
opsfy logs
opsfy logs --json
```

For example, `opsfy install openwork` installs OpenWork, and `opsfy ask Google Sheets` asks for a tool on the wall at opsfy.ai. App slugs and names match without regard to letter case.

Free apps install from their upstream source with their own installer (a Homebrew cask from the upstream release, or a git clone and the app's own setup). opsfy never runs as root and never installs a prerequisite for you: it prints the one line to run and stops.

The catalogue refreshes once a day from opsfy.ai. `opsfy list --json` prints the catalogue as JSON. A valid cached catalogue or the bundled catalogue keeps listings available when the refresh fails. Only a successful, valid refresh creates or updates the cache.

An app's cask or setup runs the upstream installer's code on your machine. The default catalogue is trusted over TLS; a compromised catalogue could remain cached for up to 24 hours, and for longer on a machine that cannot reach opsfy.ai.

The install count contains the app slug and success or failure; `OPSFY_NO_COUNT=1` turns the count off. Before it installs anything, `opsfy install` asks opsfy.ai for its list of pulled apps and checks it on your Mac. It sends nothing about the app, and if opsfy.ai does not answer clearly, it installs nothing. `opsfy ask` sends the words you supply to the wall, and `opsfy login` sends the email you give to opsfy.ai, which emails you a code. Catalogue refreshes request the public catalogue. Failed install counts are ignored.

Paid tools are not open yet.

`opsfy call` explains whether a tool is paid, free, or coming soon. It does not make paid calls.

## Logging in

`opsfy login` asks for your email, emails you a code, and asks for the code. An agent can pass both instead: `opsfy login --email you@example.com` emails a code, and `opsfy login --email you@example.com --code 123456` logs in. A code works for 10 minutes.

Your key is saved in `~/.opsfy/key`, which only you can read, and is never shown in full. On a server, set `OPSFY_API_KEY` instead; it takes the place of the saved key. `opsfy key` checks your key and shows its last four characters, `opsfy key rotate` replaces it, and `opsfy logout` makes it stop working. Each account has one key, so logging in on another computer stops the key on this one. One email at a time on each computer.

## Adding money

`opsfy topup` asks you to choose $10, $25, $50, $100, $250 or $500 USD. Pass the amount to skip the question: `opsfy topup 25`. An agent must pass an amount. The forms `25`, `$25`, `25.00` and `25usd` all mean $25; quote the dollar sign in your shell: `opsfy topup '$25'`.

For an agent, run `opsfy topup 10 --json`, show the person the `url`, then run `opsfy topup wait <id> --json`. Each call returns one JSON object. `opsfy topup status <id> --json` checks once. Start returns at once; wait checks every 3 seconds for up to 10 minutes. Outcomes are `paid` (exit 0), `cancelled` (3), `expired` (4), or still `open` (5). Errors keep exits 1 and 2.

In a terminal, `opsfy topup [amount]` prints and opens the payment page, then waits. Without a desktop, open the printed link on another machine. Ctrl-C stops waiting (exit 130); a payment still counts. Without terminal output, omit `--json` to get the link and the next command at once. Your balance changes only after Stripe confirms payment. If the answer is lost, start again for a new page.

`opsfy logs` shows your balance in USD and every paid top-up, newest recorded first, with UTC times. An unpaid page does not appear. `opsfy logs --json` prints the same balance in cents and the top-ups as JSON.

Top-ups and logs use `OPSFY_API_KEY` when it is nonempty, otherwise the saved key. Paid tools are not open yet.

## Settings

| Variable | Effect |
| --- | --- |
| `OPSFY_HOME` | Where your key and `cache/tools.json` are kept; defaults to `~/.opsfy`. |
| `OPSFY_API_KEY` | Use this key instead of the saved one, for example on a server. |
| `OPSFY_NO_COUNT=1` | Disable install counts. |
| `OPSFY_CATALOG=<file>` | Use a local catalogue exclusively; a bad file is an error. |
| `OPSFY_API_BASE=<url>` | Base for catalogue refreshes, the pulled-app check, install counts, asks, logins, top-ups and logs. Unset or empty defaults to `https://opsfy.ai`; trailing slashes are ignored. Requires HTTPS, or HTTP on exactly `127.0.0.1`, `localhost` or `::1`, with an optional port. |
| `OPSFY_CATALOG_URL=<url>` | Override the base for catalogue refreshes; the local catalogue file still takes priority. |
| `OPSFY_DRY_RUN=1` | Print installer actions to stdout and requests to stderr; install nothing and send nothing. Normal refusal checks still apply. Login, logout, key, topup and logs do not run in a dry run. |
| `OPSFY_PLATFORM=<darwin\|linux\|win32>` | Override the platform check for testing. |

## Development

Run `npm test` from this package folder, or `node --test --test-reporter=tap test/cli.test.js` for TAP output. The tests use disposable homes, an isolated PATH, fake installers, stubbed fetch, and explicitly requested dry runs. They clean up their scratch folders and need no network or installed prerequisites.

## License

MIT. See LICENSE.
