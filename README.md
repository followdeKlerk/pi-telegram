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

## Commands

- `/telegram-setup` — configure or validate the bot token
- `/telegram-connect` — start polling in this pi session, if the single-session lock is free
- `/telegram-disconnect` — stop polling and release the single-session lock
- `/telegram-status` — show bot, pairing, polling, lock, and queue status
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
