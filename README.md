# piguild

Discord-native [pi](https://github.com/mariozechner/pi) extension: **guild = workspace**, mention-based triggers in allowlisted channels, thread sessions, pluggable renderers.

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

## Docker

See the repository `Dockerfile` and `compose.yaml` for a container that builds piguild and runs pi with this extension.
