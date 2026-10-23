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

Read `opsfy info <tool> --json` for the unit price and maximum hold before calling. A call holds its maximum first, then charges actual use and releases the rest; when the tool does not report its use, the call is charged its full hold. An at-once answer gives `held_microusd` and `charged_microusd`; `price_microusd` is the charge. A job start gives `job_id` and `held_microusd`, with `charged_microusd` null while its charge is pending. Amounts are exact whole millionths of a US dollar. Before repeating an interrupted or unconfirmed at-once call, read `opsfy logs --json`; for a job, read `opsfy jobs --json` and check its status first.
Never repeat a call that may have gone through: read `opsfy logs --json` for an at-once call or `opsfy jobs --json` for a job first.
Ask the person only for their email, the code, paying, and before starting again a job whose status is unknown. Run everything else yourself.
Never show, share or store the key outside opsfy.

A job call answers at once with its job id and held_microusd. Run `opsfy job status <id> --json` to check once, `opsfy job wait <id> --json` to check every 3 seconds for up to 10 minutes, or `opsfy job stop <id> --json` where the tool permits it. Waiting never stops the job. Run `opsfy jobs --json` to recover this account's job ids after a lost answer. The hold stays reserved until settlement. Run `opsfy job result <id> --json` while the company keeps the result; the answer gives its retention time. Opsfy never stores the result. A result that would add an uncovered charge is not relayed. If the company does not confirm a job's start, the job is charged its full hold, because Opsfy cannot follow it; ask the person before starting it again. A timed-out job needs a longer limit before a new call. If `opsfy jobs` is not a command, update the CLI first: npm i -g @opsfy/cli. Job wait exits 0 for succeeded, 3 for failed, 4 for cancelled, 5 for timed_out, 6 when still pending at ten minutes, and 7 when Opsfy can no longer follow the job (status unknown). Status and stop exit 0 when checked; command errors exit 1 or 2. The jobs command lists the latest 50 visible jobs; use an existing id to check an older job.

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

For a tool shown in your private tools, run opsfy info <tool> --json first. OpenRouter text chat takes model, prompt, optional system and optional max_tokens. Model ids are listed at https://openrouter.ai/models. Use opsfy call openrouter --input model=<model> --input prompt="<text>" --input max_tokens=500 --json, or --input-file input.json for one UTF-8 JSON object; --input-file - reads standard input. OpenRouter prompt and system each allow 131,072 Unicode characters, including line breaks; the JSON file and encoded request allow 1,048,576 bytes. Other tools keep their existing limits. The input hold uses the model endpoints' published prompt limit, so even a short prompt may need a large hold. The output hold always uses the published maximum, even with max_tokens; the unused hold is released when the call ends. Every model is enabled, including free models at $0, when its published prices and limits pass these checks. The call waits for the complete answer up to 8,388,608 UTF-8 bytes; an interrupted or larger answer has no retained text and is settled from the generation record. The answer shows text, answering model, input and output tokens, held amount and charged amount. If the terminal closes, run opsfy jobs --json and check the job before calling again; the charge settles from the company's record. Opsfy does not retain the text, so a lost answer cannot be recovered. A company credit refusal means the tool is unavailable; adding to your Opsfy balance does not fix it.

Jev answers typed questions about text for authorized private-tool accounts. Use CLI 0.8.0: run opsfy info jev --json, then opsfy call jev --input-file input.json --json. input.json contains model (typesafe/jev-1.14 or typesafe/jev-1.13), state (text, up to 131,072 characters) and questions (a JSON object, up to 65,536 UTF-8 bytes and 16 container levels). A question has type noul, choice or score; choice criteria have 1 to 255 options and score criteria have 1 to 10 levels. The whole input file and request are limited to 1,048,576 UTF-8 bytes. Named --input questions accepts JSON text. Images, assets, box questions, aliases and other models are refused. The call reads current prices and holds the published context maximum; it charges actual use. A refusal or failure at the start costs nothing unless the company reports a usable charge; that figure decides, capped at the hold. An answer that never comes, or a complete Jev answer with no usable figure, pays the hold. Answers keep the returned numbers, model, input tokens, held amount and charged amount. A long call waits; after an interrupted answer, run the returned opsfy job status command before calling again. Opsfy does not retain the state, questions or answers. Other accounts see Jev as not open yet.

For a tool that returns audio, run opsfy info <tool> --json for its model ids, limits and available voice ids. Call ElevenLabs with opsfy call elevenlabs --input text="<text>" --input voice=<id> --out voice.mp3 --json, or --input-file input.json for text with line breaks. Optional model defaults to eleven_multilingual_v2. Only text, voice and model are accepted; the file is MP3 (mp3_44100_128). Use a new output path; an existing file is never overwritten. Audio streams directly into that file and never appears in terminal output. The answer reports file, bytes, counted_units, held_microusd and charged_microusd; counted_units is ElevenLabs' character-cost figure, not the text length. Amounts are exact millionths of a US dollar. The input file and encoded request allow 1,048,576 UTF-8 bytes; each model's character limit still applies. The call waits without a time limit. Settlement uses the count received with the audio headers, even if delivery is interrupted; without a usable count, it charges the hold. A company refusal or failure at the start costs nothing unless it supplies a usable count; then that count decides the charge. An unanswered start is charged its hold. If the terminal closes, run opsfy jobs --json before starting another call. A detected interruption removes the partial output file when possible; if removal fails, the answer names the remaining partial file and tells you to remove it. After a forced process kill, treat any file as incomplete until a successful answer confirms it. Opsfy retains no text or audio and cannot recover the clip. A company credit or key-limit refusal means ElevenLabs is unavailable; adding to the Opsfy balance does not fix it. Private tools are available only to their authorized accounts.

For a rental in your private tools, run opsfy info runpod --json first. Give gpu, image and disk; cloud defaults to SECURE and gpu_count to 1. Pass ports as 8000/http,22/tcp, and env as an object of strings in --input-file pod.json. Opsfy reserves 15 minutes ahead and renews while the balance covers another 15. Run opsfy job wait <id> --json for the address, opsfy job status <id> --json for the paid-until time and charges, and opsfy job stop <id> --json to delete the pod and its container disk. Waiting stops when the address is ready; ending the terminal does not stop the rental. The address is public: keep your own server key; stream long generations or add a TCP port because HTTP proxy connections end at 100 seconds. Opsfy does not relay your model requests. A start refused by Runpod costs nothing without a usable charge figure. An unanswered start pays its first hold; Opsfy searches for and deletes that pod. Run opsfy jobs --json and ask the person before starting another rental after an unconfirmed start. If checking stops, the pod can outlive its paid time; those unheld minutes are paid by Opsfy. Each settled 15-minute slice appears in opsfy logs --json. Runpod credit or account limits mean Runpod is unavailable; adding to the Opsfy balance does not fix them.

For a tool shown in your private tools, run opsfy info tavily-research --json first. Start a report with opsfy call tavily-research "<question>" --input model=mini --json; choose mini or pro. The question allows 1 to 2,000 characters. opsfy info tavily-research --json shows each model's hold and the price of a reported credit; the final charge never exceeds the hold. Optional citation_format takes numbered, mla, apa or chicago; optional output_length takes short, standard or long. Omit either to use Tavily's default. A start returns a job id: run opsfy job wait <id> --json, then opsfy job result <id> --json for text and source titles and URLs. A report may take minutes and cannot be stopped. Closing the terminal does not stop it; run opsfy jobs --json to recover its id. Failed jobs pay their reported use, including zero; missing usage, a report too large to read, an unconfirmed start or a deleted status record costs the hold. A refused start without reported use costs nothing. If a result is gone, its settled charge stands. Opsfy does not store the question or report. A company credit refusal means research is unavailable; adding money to Opsfy does not fix it. If research is not listed in your private tools, update the CLI and run opsfy info tavily-research --json again; it may not be open to your account.

For an authorized private Apify tool, run opsfy info apify --json, then opsfy call apify --input-file input.json --json. The file contains actor, max_usd as a positive dollar string such as "0.10", and an optional input object. Actor ids are written user/name; user~name is the same. Only Actors whose cost Apify caps and that need no full account access are available. The run holds its maximum from max_usd and charges actual use up to that hold, including failed, stopped and timed-out runs. An unanswered start or a deleted status record pays the hold. Follow the returned opsfy job command; waiting does not stop the run. Run opsfy job result <id> --json for up to 50 items from the first dataset page, within 262,144 UTF-8 bytes. Each result read has a separate hold and charge, shown in result_read; repeated reads are charged again. A missing result does not change the run charge. Opsfy stores neither input nor results. Apify retains them in its account; result availability is not guaranteed. Apify account limits mean the tool is unavailable right now; adding to the Opsfy balance does not fix them. Other accounts see Apify as not open yet.

For serverless jobs in your private tools, use CLI 0.8.0. Run opsfy info runpod-serverless --json for Opsfy endpoint names, models, GPU pools and hourly prices. Call opsfy call runpod-serverless --input-file input.json --json with the complete input object; do not combine named inputs and --input-file. The file contains endpoint, input (a JSON object, at most 65,536 UTF-8 bytes and 16 container levels), and optional seconds (5 to 604800; default 600). The whole file and request allow 1,048,576 UTF-8 bytes. A named --input input accepts JSON text. The hold covers the limit, up to 420 seconds of waiting and 5 seconds after running. The charge uses the reported run time, waiting capped at 420 seconds and 5 seconds after running; a job reported as never run costs zero. Waiting can include queue time. A refused start without usable usage costs zero; an unanswered start, a deleted status record or missing final usage pays the hold. Every charge is capped at the hold. Run the returned opsfy job wait <id> --json, or job status, stop or result. A stop keeps the hold until Runpod reports the end. Results are available while Runpod keeps them, normally 30 minutes; Opsfy stores neither input nor output. The result is an object containing output, preserving any JSON output type. An output above 262,144 UTF-8 bytes cannot be relayed, but its charge still settles. Missing or invalid output has a separate result error; the charge stands. Runpod credit or account limits mean Runpod is unavailable; adding to the Opsfy balance does not fix them. An unknown endpoint needs a name from opsfy info runpod-serverless --json; a sleeping endpoint needs the person to wake it. Other accounts see this tool as not open yet.
