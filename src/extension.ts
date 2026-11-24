import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream';
import { StringDecoder } from 'string_decoder';

interface Settings {
  ollamaUrl: string;
  proxyPort: number;
  model: string;
}

type Outcome = 'completed' | 'empty' | 'failed' | 'cancelled';

interface RequestMetrics {
  id: number;
  startedAt: number;
  firstByteAt?: number;
  firstTokenAt?: number;
  generatedChars: number;
  generatedTokens?: number;
  promptTokens?: number;
  doneSeen: boolean;
  httpStatus?: number;
  error?: string;
  endpoint: string;
}

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_PROXY_PORT = 11435;
const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base';
const SPINNER_FRAMES = 4;
const SPINNER_INTERVAL_MS = 180;

let server: http.Server | undefined;
let active = new Map<number, RequestMetrics>();
let nextRequestId = 1;
let animationTimer: ReturnType<typeof setInterval> | undefined;
let animationFrame = 0;
let decorations: vscode.TextEditorDecorationType[] = [];
let status: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel;
let recentSummary = 'No autocomplete requests recorded';

function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('continueQwenIndicator');
  return {
    ollamaUrl: config.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL),
    proxyPort: config.get<number>('proxyPort', DEFAULT_PROXY_PORT),
    model: config.get<string>('model', DEFAULT_MODEL),
  };
}

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  output.appendLine(line);
}

function createDecorations(context: vscode.ExtensionContext): void {
  for (let frame = 0; frame < SPINNER_FRAMES; frame++) {
    const decoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `spinner-${frame}.svg`),
    });
    decorations.push(decoration);
    context.subscriptions.push(decoration);
  }
}

function clearDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    for (const decoration of decorations) editor.setDecorations(decoration, []);
  }
}

function renderIndicator(): void {
  clearDecorations();
  const count = active.size;
  if (status) {
    status.text = count > 0 ? `$(sync~spin) Qwen ${count} generating` : '$(check) Qwen idle';
    status.tooltip = count > 0
      ? `${count} monitored Ollama request(s) active. ${recentSummary}`
      : `No active requests. ${recentSummary}\nClick to show request status.`;
    status.show();
  }
  if (count === 0 || decorations.length === 0) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const lineRange = editor.document.lineAt(editor.selection.active.line).range;
  editor.setDecorations(decorations[animationFrame % decorations.length], [lineRange]);
}

function startAnimation(): void {
  if (animationTimer) return;
  animationFrame = 0;
  animationTimer = setInterval(() => {
    animationFrame = (animationFrame + 1) % SPINNER_FRAMES;
    renderIndicator();
  }, SPINNER_INTERVAL_MS);
}

function stopAnimationIfIdle(): void {
  if (active.size !== 0 || !animationTimer) return;
  clearInterval(animationTimer);
  animationTimer = undefined;
  animationFrame = 0;
}

function beginRequest(endpoint: string): RequestMetrics {
  const metrics: RequestMetrics = {
    id: nextRequestId++,
    startedAt: Date.now(),
    generatedChars: 0,
    doneSeen: false,
    endpoint,
  };
  active.set(metrics.id, metrics);
  startAnimation();
  renderIndicator();
  log(`#${metrics.id} START ${endpoint}`);
  return metrics;
}

function finishRequest(metrics: RequestMetrics, outcome: Outcome): void {
  if (!active.has(metrics.id)) return;
  active.delete(metrics.id);
  const elapsed = Date.now() - metrics.startedAt;
  const firstByte = metrics.firstByteAt === undefined ? 'n/a' : `${metrics.firstByteAt - metrics.startedAt}ms`;
  const firstToken = metrics.firstTokenAt === undefined ? 'n/a' : `${metrics.firstTokenAt - metrics.startedAt}ms`;
  const summary = `#${metrics.id} ${outcome.toUpperCase()} | HTTP ${metrics.httpStatus ?? 'n/a'} | total ${elapsed}ms | first byte ${firstByte} | first text ${firstToken} | chars ${metrics.generatedChars} | eval tokens ${metrics.generatedTokens ?? 'n/a'}${metrics.error ? ` | ${metrics.error}` : ''}`;
  recentSummary = summary;
  log(summary);
  stopAnimationIfIdle();
  renderIndicator();
}

function isMonitoredRequest(body: Buffer, configuredModel: string): boolean {
  if (!body.length) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model === configuredModel;
  } catch {
    return false;
  }
}

function extractText(payload: any): string {
  if (typeof payload?.response === 'string') return payload.response;
  if (typeof payload?.message?.content === 'string') return payload.message.content;
  return '';
}

function inspectNdjsonLine(line: string, metrics: RequestMetrics): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const payload = JSON.parse(trimmed);
    const text = extractText(payload);
    if (text.length > 0) {
      metrics.generatedChars += text.length;
      if (metrics.firstTokenAt === undefined) metrics.firstTokenAt = Date.now();
    }
    if (typeof payload.eval_count === 'number') metrics.generatedTokens = payload.eval_count;
    if (typeof payload.prompt_eval_count === 'number') metrics.promptTokens = payload.prompt_eval_count;
    if (payload.done === true) metrics.doneSeen = true;
    if (payload.error) metrics.error = String(payload.error);
  } catch {
    // Non-JSON lines are not interpreted. The original bytes are still forwarded unchanged.
  }
}

class OllamaResponseInspector extends Transform {
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  constructor(private readonly metrics: RequestMetrics) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.metrics.firstByteAt === undefined && chunk.length > 0) {
      this.metrics.firstByteAt = Date.now();
    }
    this.pending += this.decoder.write(chunk);
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      inspectNdjsonLine(this.pending.slice(0, newline), this.metrics);
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) inspectNdjsonLine(this.pending, this.metrics);
    callback();
  }
}

function handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse, settings: Settings): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on('error', (error) => {
    log(`Incoming request error: ${error.message}`);
    if (!res.headersSent) res.writeHead(400);
    res.end('Bad request');
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const monitored = isMonitoredRequest(body, settings.model);
    const metrics = monitored ? beginRequest(req.url || '/') : undefined;
    forwardRequest(req, res, body, settings, metrics);
  });
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  settings: Settings,
  metrics?: RequestMetrics,
): void {
  let target: URL;
  try {
    target = new URL(settings.ollamaUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Ollama URL must use HTTP or HTTPS');
  } catch (error) {
    if (metrics) { metrics.error = String(error); finishRequest(metrics, 'failed'); }
    res.writeHead(500).end('Invalid Ollama URL');
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const basePath = target.pathname.replace(/\/$/, '');
  const incomingPath = req.url || '/';
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['transfer-encoding'];
  if (body.length) headers['content-length'] = body.length;
  else delete headers['content-length'];

  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port ? Number(target.port) : undefined,
    method: req.method || 'POST',
    path: `${basePath}${incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`}`,
    headers,
  }, (upstreamResponse) => {
    if (metrics) metrics.httpStatus = upstreamResponse.statusCode;
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);

    const inspector = metrics ? new OllamaResponseInspector(metrics) : new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) { callback(null, chunk); },
    });

    pipeline(upstreamResponse, inspector, res, (error) => {
      if (error) {
        if (metrics) {
          metrics.error = error.message;
          finishRequest(metrics, res.destroyed && !res.writableEnded ? 'cancelled' : 'failed');
        }
        if (!res.destroyed && !res.writableEnded) res.destroy(error);
        return;
      }
      if (metrics) {
        const outcome: Outcome = metrics.error || (metrics.httpStatus ?? 500) >= 400
          ? 'failed'
          : metrics.generatedChars > 0 ? 'completed' : 'empty';
        finishRequest(metrics, outcome);
      }
    });
  });

  upstream.on('error', (error) => {
    if (metrics) { metrics.error = error.message; finishRequest(metrics, 'failed'); }
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    if (!res.destroyed && !res.writableEnded) res.end(`Ollama connection failed: ${error.message}`);
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      upstream.destroy(new Error('Client disconnected'));
      if (metrics) finishRequest(metrics, 'cancelled');
    }
  });

  upstream.end(body);
}

async function stopProxy(): Promise<void> {
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

async function startProxy(): Promise<void> {
  await stopProxy();
  const settings = getSettings();
  if (!Number.isInteger(settings.proxyPort) || settings.proxyPort < 1024 || settings.proxyPort > 65535) {
    throw new Error('Proxy port must be an integer between 1024 and 65535');
  }
  const target = new URL(settings.ollamaUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Ollama URL must use HTTP or HTTPS');

  const nextServer = http.createServer((req, res) => handleProxyRequest(req, res, settings));
  server = nextServer;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { nextServer.off('listening', onListening); reject(error); };
    const onListening = () => { nextServer.off('error', onError); resolve(); };
    nextServer.once('error', onError);
    nextServer.once('listening', onListening);
    nextServer.listen(settings.proxyPort, '127.0.0.1');
  }).catch(async (error) => {
    server = undefined;
    await new Promise<void>((resolve) => nextServer.close(() => resolve()));
    throw error;
  });
  log(`Proxy listening on 127.0.0.1:${settings.proxyPort} -> ${settings.ollamaUrl}; monitoring model ${settings.model}`);
  renderIndicator();
}

function showStatus(): void {
  const settings = getSettings();
  const message = [
    `Proxy: 127.0.0.1:${settings.proxyPort} -> ${settings.ollamaUrl}`,
    `Model: ${settings.model}`,
    `Active requests: ${active.size}`,
    recentSummary,
  ].join('\n');
  void vscode.window.showInformationMessage(message);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Qwen Autocomplete Monitor');
  context.subscriptions.push(output);
  createDecorations(context);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'continueQwenIndicator.showStatus';
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.commands.registerCommand('continueQwenIndicator.showStatus', showStatus));
  context.subscriptions.push(vscode.commands.registerCommand('continueQwenIndicator.openLogs', () => output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('continueQwenIndicator.restartProxy', async () => {
    try {
      await startProxy();
      void vscode.window.showInformationMessage('Qwen autocomplete proxy restarted.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Proxy restart failed: ${message}`);
      void vscode.window.showErrorMessage(`Could not restart Qwen proxy: ${message}`);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(renderIndicator));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(renderIndicator));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(renderIndicator));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('continueQwenIndicator')) {
      void startProxy().catch((error) => vscode.window.showErrorMessage(`Could not restart Qwen proxy: ${String(error)}`));
    }
  }));

  renderIndicator();
  try {
    await startProxy();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Proxy startup failed: ${message}`);
    void vscode.window.showErrorMessage(`Could not start Qwen proxy: ${message}`);
  }
}

export async function deactivate(): Promise<void> {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = undefined;
  active.clear();
  clearDecorations();
  for (const decoration of decorations) decoration.dispose();
  decorations = [];
  status?.dispose();
  status = undefined;
  await stopProxy();
}
