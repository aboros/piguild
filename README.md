# piguild

Discord bot runtime powered by [pi-coding-agent](https://github.com/mariozechner/pi). Each guild maps to a workspace with optional per-channel workspaces; the agent responds to mentions in allowlisted channels, keeps conversations in threads, and exposes a rich tool/reasoning UI.

## Requirements

- Node.js 22+
- A Discord bot token and [Message Content Intent](https://discord.com/developers/docs/topics/gateway#message-content-intent) enabled
- `pi` (pi-coding-agent) with API keys under `~/.pi` (e.g. Anthropic)

## Configuration

1. Copy `piguild.config.example.json` to `piguild.config.json` (or set `PIGUILD_CONFIG` to an absolute path).
2. Resolve secrets with the `ENV:VAR_NAME` pattern for `discordToken`, or paste a token (not recommended).
3. Set `allowedGuildIds`, `guildWorkspaces`, `trigger.allowedChannelIds`, and `access` to match your server.

Environment variables:

- `PIGUILD_CONFIG` — path to JSON config (optional; defaults to `./piguild.config.json` relative to the pi session `cwd`).
- Variables referenced as `ENV:...` in the config file.

## Running

From the directory that contains `piguild.config.json`:

```bash
pi -e /path/to/piguild/dist/index.js --no-session
```

Build the extension first:

```bash
cd piguild && npm install && npm run build
```

## Example

See [Piri](https://github.com/aboros/piri) for an example of how to run a piguild based bot with docker. 
