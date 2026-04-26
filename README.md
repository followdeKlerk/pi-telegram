# pi-telegram

![pi-telegram screenshot](screenshot.png)

Telegram DM bridge for pi, maintained in the `followdeKlerk/pi-telegram` fork.

## Install

From git:

```bash
pi install git:github.com/followdeKlerk/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/followdeKlerk/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

You can either store the token in pi config:

```bash
/telegram-setup
```

or provide it via an environment variable before starting pi:

```bash
export PI_TELEGRAM_BOT_TOKEN='123456:ABCDEF...'
pi -e git:github.com/followdeKlerk/pi-telegram
```

When `/telegram-setup` sees `PI_TELEGRAM_BOT_TOKEN`, it validates that token and does not need to save a token in JSON. Otherwise it prompts for the token and stores it in:

```text
~/.pi/agent/telegram.json
```

## Connect one pi session

The Telegram bridge is session-local and uses Telegram long polling. Only one pi process can actively poll a bot at a time, so the extension creates a single-session lock at:

```text
~/.pi/agent/telegram.lock
```

Start polling in the pi session that should own the bot:

```bash
/telegram-connect
```

If another active pi process already holds the lock, this session refuses to start polling and shows the owning process id. Run `/telegram-disconnect` in that process first. If pi crashed and the lock is stale, remove the lock file manually.

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status, including the pairing command and lock state:

```bash
/telegram-status
```

The bridge auto-reconnects on session start when a bot token is configured, and refreshes the Telegram bot command menu with the supported Telegram commands.

To clear Telegram's persistent slash-command menu manually:

```bash
/telegram-reset-menu
```

The menu is refreshed again the next time the bridge connects.

## Pair your Telegram account

Pairing is not automatic. After token setup and `/telegram-connect`, pi shows a one-time command such as:

```text
/pair 839214
```

Open the DM with your bot in Telegram and send the exact command shown in pi. The first user to send the correct one-time pairing code becomes the allowed Telegram user. All other Telegram users are rejected.

To change the allowed user, run this in pi:

```bash
/telegram-reset-pairing
```

That forgets the current allowed user and shows a new `/pair NNNNNN` code.

## Usage

Chat with your bot in Telegram DMs after pairing.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:

- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:

- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Telegram commands

The bridge handles these commands directly from Telegram:

```text
/status
/new
/compact
/stop
/reload
/telegram_verbose on|off|status
/help
```

`/new` starts a real replacement pi session, and `/reload` reloads pi resources/extensions.

Pi prompt templates and skills are expanded and sent to pi from Telegram, for example:

```text
/skill:pi-subagents review this approach
```

Interactive-only TUI commands such as `/model`, `/resume`, `/tree`, and `/fork` are rejected from Telegram instead of being silently forwarded to the model.

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Verbose telemetry

Verbose mode adds a second, separate live Telegram message for each Telegram-triggered pi turn. It does **not** mix telemetry into the assistant answer stream, and it does **not** show private chain-of-thought. It only shows observable runtime telemetry exposed by pi's extension APIs.

Enable it from pi or from the paired Telegram DM:

```text
/telegram-verbose on
/telegram-verbose off
/telegram-verbose status
/telegram_verbose status
```

Verbose settings are persisted in:

```text
~/.pi/agent/telegram.json
```

Supported settings:

```json
{
  "verbose": true,
  "streamAssistantText": true,
  "streamTelemetry": true,
  "streamToolCalls": true,
  "streamBash": true,
  "streamStdout": true,
  "showElapsed": true,
  "showTokenUsage": true,
  "telemetryIntervalMs": 1000
}
```

Defaults are conservative: `verbose` is off, assistant text streaming is on, telemetry is off unless verbose is enabled, tool/bash visibility follows verbose mode, stdout streaming is off unless explicitly enabled, and telemetry edits are throttled to 1000 ms.

Example live telemetry message:

```text
⏱ 00:18
📍 status: bash
🛠 bash
$ npm test
🧠 context: 41.2k / 65.5k
🔢 output: 884 tokens
```

Final telemetry looks like:

```text
✅ completed
⏱ 00:31
🧠 context: 41.7k / 65.5k
🔢 output: 1.2k tokens
```

Token/context/tool visibility depends on what pi exposes at runtime. If a value is not available, the bridge shows `unknown` or omits that section rather than inventing data. Bash stdout/stderr snippets are truncated to the last few lines and bot tokens are never shown in telemetry, status, or errors.

## Commands

- `/telegram-setup` — configure or validate the bot token
- `/telegram-connect` — start polling in this pi session, if the single-session lock is free
- `/telegram-disconnect` — stop polling and release the single-session lock
- `/telegram-status` — show bot, pairing, polling, lock, and queue status
- `/telegram-verbose on|off|status` — configure verbose Telegram telemetry
- `/telegram-reset-menu` — clear Telegram's persistent slash-command menu
- `/telegram-reset-pairing` — forget the allowed Telegram user and show a new pairing code

## Notes

- Pairing requires the one-time `/pair NNNNNN` command shown in pi
- `PI_TELEGRAM_BOT_TOKEN` can be used instead of storing the bot token in JSON
- Only one pi session can be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
