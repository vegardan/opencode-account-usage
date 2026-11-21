# OpenCode Account Usage

A native **OpenCode Desktop V2** extension for monitoring multiple OpenAI accounts together. Built with TypeScript and Solid; targets the `@opencode/plugin` **2.3.2** API.

## Features

- Discovers all saved OpenAI accounts, including inactive accounts.
- Shows account-wide Codex usage windows, remaining percentages, provider-reported reset times, plans, extra model limits, and credits when available.
- Records OpenCode Responses API usage over HTTP/SSE and WebSocket: input, cached input, output, reasoning, account, model, and request type.
- Per-account and combined totals, daily activity, model breakdown, recent requests, and CSV export.
- Last 24 hours, 7 days, 30 days, or all recorded time.
- Selected account's remaining Codex allowances and reset times at the very top; follows account changes automatically.
- Sidebar usage button always shows the selected account's name and lowest remaining Codex allowance (for example, `OpenAI Personal · 41% left`) without hovering; hover for individual windows. Refreshes every minute even with the dashboard closed.
- Settings page, session side panel, titlebar shortcut, `/account-usage`, and an `account_usage` agent tool.

## Install locally

Requires Node.js 22.12+ for development and an OpenCode Desktop service compatible with plugin SDK 2.3.2.

```powershell
npm ci
npm run check
npm run install:local
```

The installer adds this directory to your global OpenCode configuration, preserving other settings and backing up the file. Configuration reloads automatically.

Open **Settings → Account usage**, use **Open account usage** in the command palette, or type **`/account-usage`**.

Manual equivalent (merge into your existing global `~/.config/opencode/opencode.json(c)`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/path/to/opencode-account-usage"]
}
```

### Moving the project later

Move the whole `opencode-account-usage` folder. Replace its old path in the global config with the new directory. Run `npm ci` and `npm run build` if you did not move dependencies and build output. Usage records stay in OpenCode's plugin storage.

### Remove

Remove the plugin's directory entry from the global config. Turning its GUI off under **Settings → Extensions → Plugins** hides the UI; remove the config entry to stop token recording too.

## What the numbers mean

**Allowance data** is fetched from OpenAI's `https://chatgpt.com/backend-api/wham/usage`, the endpoint used by Codex clients. It reflects usage across clients sharing the account's Codex allowance. This endpoint is not a supported public billing API and may change; failed polls show an error and retain the last successful reading with a stale label.

**New “Sign in with ChatGPT” accounts:** token-sharing credentials authorize the public Responses API, not ChatGPT backend endpoints. For these accounts the extension tracks local token usage and links to [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage), as prescribed by [OpenAI's documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage). It does not send these tokens to the legacy Codex usage endpoint or report unavailable allowance data as zero. Legacy Codex sign-ins support inline allowance readings.

Window labels come from the reported duration: a primary window is not assumed to be five hours. Reset times are the provider's current estimate. Reset deadlines are not treated as proof that the allowance has renewed.

**Token activity** covers Responses requests observed by this plugin in OpenCode, starting at installation. It is not reconstructed by guessing which account was selected for old messages. ChatGPT website token history, Codex CLI request history, stateless image/video generation, non-Responses protocols, and requests made while the plugin is unloaded are not included.

Attribution uses the actual outgoing bearer credential fingerprint or account ID, rather than whichever account happens to be selected when a response finishes. Unmatched or ambiguous identities are omitted with a visible completeness notice. No automatic account switching.

- Total = input + output.
- Cached input is already included in input.
- Reasoning is already included in output.
- Request counts include observed title/compaction/generation requests when they use the Responses protocol.
- Limits are current and independent of the selected token-history period.
- Token counts are **not subscription charges** or a dollar balance.

## Data and credentials

The plugin asks OpenCode to resolve credentials and handle refresh for each saved account. It does not read auth files or browser sessions. OAuth tokens are sent only to the fixed ChatGPT usage endpoint, are not exposed by RPC, and are not persisted by this plugin.

OpenCode's plugin-scoped durable store holds usage metadata only: response ID, credential ID and label, session ID, timestamp, model, request kind, and token counts. No prompts or generated text are stored. HTTP observation consumes a cloned response incrementally, with a per-event size cap; the original response is untouched.

OpenCode may choose HTTP transport when an HTTP observer hook is installed. WebSocket hooks are also implemented for hosts/routes that retain that transport.

### Sharing this project

The development preview and tests use fictional account labels and sample usage. Real account credentials and recorded usage stay in OpenCode's storage, outside the project.

Do not commit real usage exports, screenshots containing account details, credential files, or copies of your global OpenCode configuration. Usage CSVs include account labels and session identifiers. Local settings, backups, usage exports, and common credential/database files are ignored by default. Review any files before force-adding them.

## Troubleshooting

- **New ChatGPT sign-in:** allowance polling is unavailable for this method. Use the ChatGPT usage link; signing in again with the same method will not fix that limitation. A legacy Codex sign-in, if available, supports inline limits.
- **No tokens yet:** send a normal OpenAI chat message after installing. The initial empty state is intentional.
- **Plugin not visible:** check Settings → Extensions → Plugins; the running desktop **service** version matters and can differ from `opencode --version`. `opencode api get /api/info` reports it.
- **Stale data:** each location's usage poll is coalesced and cached for 60 seconds; an open dashboard refreshes every minute. Errors are shown per account.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

`npm run dev` opens a standalone development preview at `http://127.0.0.1:4173` with clearly labeled sample data; it does not connect to your accounts.

Source:

- `src/index.ts`: server registration and agent tool.
- `src/tracker.ts`: account discovery, credential matching, lifecycle, and summaries.
- `src/capture.ts`: streaming/JSON usage observation.
- `src/ledger.ts`: deduplicated persistent records and CSV.
- `src/quota.ts`: provider usage endpoint and payload normalization.
- `src/gui.tsx`, `src/gui/`: native desktop dashboard.
- `src/rpc.ts`: validated server/UI contract.

The GUI API is experimental. Rebuild and re-test when upgrading the SDK. No external analytics, paid services, or additional account login flow is required by the extension.
