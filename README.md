# opsfy

One key for all your tools.

https://opsfy.ai

Requires Node.js 20 or newer. Install the command with:

```sh
npm i -g opsfy
```

The same install works straight from this repo: `npm i -g opsfy-ai/opsfy`.

Mac today; Windows and Linux next.

```text
opsfy list
opsfy list --json
opsfy install <app>
opsfy ask <tool>
opsfy login
opsfy login --email you@example.com
opsfy call <tool> ...
opsfy logs
```

For example, `opsfy install openwork` installs OpenWork, and `opsfy ask Google Sheets` asks for a tool on the wall at opsfy.ai. App slugs and names match without regard to letter case.

Free apps install from their upstream source with their own installer (a Homebrew cask from the upstream release, or a git clone and the app's own setup). opsfy never runs as root and never installs a prerequisite for you: it prints the one line to run and stops.

The catalogue refreshes once a day from opsfy.ai. `opsfy list --json` prints the catalogue as JSON. A valid cached catalogue or the bundled catalogue keeps listings available when the refresh fails. Only a successful, valid refresh creates or updates the cache.

An app's cask or setup runs the upstream installer's code on your machine. The default catalogue is trusted over TLS; a compromised catalogue could remain cached for up to 24 hours.

The install count contains the app slug and success or failure. `OPSFY_NO_COUNT=1` turns it off. `opsfy ask` sends the words you supply to the wall, and `opsfy login --email` sends the address you supply to the waitlist. Catalogue refreshes request the public catalogue. Failed install counts are ignored.

Paid tools open by waitlist.

`opsfy call` explains whether a tool is paid, free, or coming soon. `opsfy logs` explains that keys open with the paid tools. These commands do not make paid calls or retrieve call history.

## Settings

| Variable | Effect |
| --- | --- |
| `OPSFY_HOME` | Parent of `cache/tools.json`; defaults to `~/.opsfy`. |
| `OPSFY_NO_COUNT=1` | Disable install counts. |
| `OPSFY_CATALOG=<file>` | Use a local catalogue exclusively; a bad file is an error. |
| `OPSFY_API_BASE=<url>` | Base for catalogue refreshes, install counts, asks and the waitlist. Unset or empty defaults to `https://opsfy.ai`; trailing slashes are ignored. Requires HTTPS, or HTTP on exactly `127.0.0.1`, `localhost` or `::1`, with an optional port. |
| `OPSFY_CATALOG_URL=<url>` | Override the base for catalogue refreshes; the local catalogue file still takes priority. |
| `OPSFY_DRY_RUN=1` | Print installer actions to stdout and requests to stderr; install nothing and send nothing. Normal refusal checks still apply. |
| `OPSFY_PLATFORM=<darwin\|linux\|win32>` | Override the platform check for testing. |

## Development

Run `npm test` from this package folder, or `node --test --test-reporter=tap test/cli.test.js` for TAP output. The tests use disposable homes, an isolated PATH, fake installers, stubbed fetch, and explicitly requested dry runs. They clean up their scratch folders and need no network or installed prerequisites.

## License

MIT. See LICENSE.
