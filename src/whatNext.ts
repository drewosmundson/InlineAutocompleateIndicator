

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