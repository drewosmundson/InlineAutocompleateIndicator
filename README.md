# Qwen Autocomplete Monitor

A local VS Code extension that proxies the Ollama API used by Continue and records what happened to each autocomplete request. It does not change Continue's completion behavior or edit the response body sent back to Continue.

## What it shows

- Animated gutter spinner and status-bar request count while monitored requests are active.
- Per-request HTTP status and outcome: completed, empty, failed, or cancelled.
- Time to first response byte and first non-empty generated text.
- Generated character count and Ollama `eval_count` when present.
- Request details in the **Qwen Autocomplete Monitor** Output panel.

The spinner means an HTTP request is in flight. It does not mean a completion will necessarily be accepted by Continue. The logs distinguish an empty Ollama response from a valid response that Continue may subsequently discard.

## Requirements

- VS Code 1.85+
- Node.js/npm for building
- Ollama listening at `http://127.0.0.1:11434` (or configure another URL)
- Continue configured to send its Ollama autocomplete requests through `http://127.0.0.1:11435`

## Build and install

```bash
npm install
npm run compile
npm install -g @vscode/vsce
vsce package
```

Then in VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. Alternatively, open this folder in VS Code and press F5 to launch an Extension Development Host.

## Continue model configuration

Keep the autocomplete model's `apiBase` pointed at the proxy:

```yaml
- name: Qwen Autocomplete
  provider: ollama
  model: qwen2.5-coder:1.5b-base
  apiBase: http://127.0.0.1:11435
  roles:
    - autocomplete
```

The proxy listens on `127.0.0.1:11435` and forwards requests to `127.0.0.1:11434` by default. Do not point `ollamaUrl` back to port `11435`, or you will create a proxy loop.

## Settings

- `continueQwenIndicator.ollamaUrl`: upstream Ollama base URL, default `http://127.0.0.1:11434`.
- `continueQwenIndicator.proxyPort`: local proxy port, default `11435`.
- `continueQwenIndicator.model`: exact model name to monitor, default `qwen2.5-coder:1.5b-base`.

## Commands

- **Qwen Monitor: Show Status**
- **Qwen Monitor: Open Request Logs**
- **Qwen Monitor: Restart Proxy**

Click the Qwen status-bar item to show the current configuration and most recent request summary. Use the Output panel to inspect the full request history.

## Request outcome interpretation

- `COMPLETED`: Ollama returned at least one non-empty completion text fragment.
- `EMPTY`: Ollama returned a successful HTTP response but no generated text was observed.
- `FAILED`: upstream connection, HTTP status, or response pipeline failed.
- `CANCELLED`: the downstream client closed the response before it completed.

For `/api/generate`, text is read from `response`. For `/api/chat`, text is read from `message.content`. Streaming NDJSON is inspected incrementally while the original response bytes are forwarded unchanged.

## Limitations

This extension observes the Ollama HTTP boundary. It cannot see Continue's internal acceptance/rejection decision after Ollama returns. If a request logs `COMPLETED` but no inline suggestion appears, inspect Continue's logs as the next step. It also cannot prove token-level timing more precisely than the first non-empty text fragment received from Ollama.
