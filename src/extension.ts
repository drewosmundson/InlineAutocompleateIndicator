
import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { URL } from "url";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let server: http.Server | undefined;

let activeRequests = 0;
let animationTimer: ReturnType<typeof setInterval> | undefined;
let animationFrame = 0;

let decorations: vscode.TextEditorDecorationType[] = [];
let status: vscode.StatusBarItem | undefined;

const SPINNER_FRAME_COUNT = 4;
const SPINNER_INTERVAL_MS = 250;

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_PROXY_PORT = 11435;
const DEFAULT_MODEL = "qwen2.5-coder:1.5b-base";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

interface IndicatorSettings {
  ollamaUrl: string;
  proxyPort: number;
  model: string;
}

function getSettings(): IndicatorSettings {
  const config = vscode.workspace.getConfiguration(
    "continueQwenIndicator"
  );

  return {
    ollamaUrl: config.get<string>(
      "ollamaUrl",
      DEFAULT_OLLAMA_URL
    ),
    proxyPort: config.get<number>(
      "proxyPort",
      DEFAULT_PROXY_PORT
    ),
    model: config.get<string>(
      "model",
      DEFAULT_MODEL
    ),
  };
}

// -----------------------------------------------------------------------------
// Gutter decorations
// -----------------------------------------------------------------------------

function createDecorations(context: vscode.ExtensionContext): void {
  decorations = [];

  for (let frame = 0; frame < SPINNER_FRAME_COUNT; frame++) {
    const decoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        `spinner-${frame}.svg`
      ),
    });

    decorations.push(decoration);
    context.subscriptions.push(decoration);
  }
}

function clearDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    for (const decoration of decorations) {
      editor.setDecorations(decoration, []);
    }
  }
}

function renderIndicator(): void {
  clearDecorations();

  if (status) {
    if (activeRequests > 0) {
      status.text = `$(sync~spin) Qwen generating (${activeRequests})`;
      status.tooltip = "Qwen autocomplete request in progress";
    } else {
      status.text = "Qwen idle";
      status.tooltip = "No Qwen autocomplete request is running";
    }

    status.show();
  }

  if (activeRequests === 0 || decorations.length === 0) {
    return;
  }

  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }


  const position = editor.selection.active;
  const lineRange = editor.document.lineAt(position.line).range;

  const currentDecoration =
    decorations[animationFrame % decorations.length];

  editor.setDecorations(currentDecoration, [lineRange]);
}

// -----------------------------------------------------------------------------
// Animation and request tracking
// -----------------------------------------------------------------------------

function updateActiveRequests(delta: number): void {
  activeRequests = Math.max(0, activeRequests + delta);

  if (activeRequests > 0 && !animationTimer) {
    animationFrame = 0;

    animationTimer = setInterval(() => {
      animationFrame =
        (animationFrame + 1) % SPINNER_FRAME_COUNT;

      renderIndicator();
    }, SPINNER_INTERVAL_MS);
  }

  if (activeRequests === 0 && animationTimer) {
    clearInterval(animationTimer);
    animationTimer = undefined;
    animationFrame = 0;
  }

  renderIndicator();
}

// -----------------------------------------------------------------------------
// Request detection
// -----------------------------------------------------------------------------

function matchesModel(body: Buffer, configuredModel: string): boolean {
  if (body.length === 0) {
    return false;
  }

  try {
    const parsed = JSON.parse(body.toString("utf8"));

    return parsed.model === configuredModel;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Ollama reverse proxy
// -----------------------------------------------------------------------------

function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  settings: IndicatorSettings
): void {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer | string) => {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
  });

  req.on("error", (error: Error) => {
    console.error("Incoming proxy request error:", error);

    if (!res.headersSent) {
      res.writeHead(400);
      res.end("Bad request");
    }
  });

  req.on("end", () => {
    const body = Buffer.concat(chunks);

    const monitored = matchesModel(body, settings.model);

    if (monitored) {
      updateActiveRequests(1);
    }

    forwardRequest(req, res, body, settings, monitored);
  });
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  settings: IndicatorSettings,
  monitored: boolean
): void {
  let finished = false;

  const finishRequest = (): void => {
    if (finished) {
      return;
    }

    finished = true;

    if (monitored) {
      updateActiveRequests(-1);
    }
  };

  let ollamaUrl: URL;

  try {
    ollamaUrl = new URL(settings.ollamaUrl);
  } catch {
    finishRequest();

    res.writeHead(500);
    res.end("Invalid Ollama URL");
    return;
  }

  const protocol = ollamaUrl.protocol;

  if (protocol !== "http:" && protocol !== "https:") {
    finishRequest();

    res.writeHead(500);
    res.end("Ollama URL must use HTTP or HTTPS");
    return;
  }

  const transport = protocol === "https:" ? https : http;

  const incomingPath = req.url || "/";
  const basePath = ollamaUrl.pathname.replace(/\/$/, "");

  const requestPath =
    basePath +
    (incomingPath.startsWith("/")
      ? incomingPath
      : `/${incomingPath}`);

  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
  };

  delete headers.host;
  delete headers.connection;
  delete headers["transfer-encoding"];

  if (body.length > 0) {
    headers["content-length"] = body.length;
  } else {
    delete headers["content-length"];
  }

  const requestOptions: http.RequestOptions = {
    protocol,
    hostname: ollamaUrl.hostname,
    port: ollamaUrl.port
      ? Number(ollamaUrl.port)
      : undefined,
    method: req.method || "GET",
    path: requestPath,
    headers,
  };

  const upstreamRequest = transport.request(
    requestOptions,
    (upstreamResponse) => {
      res.writeHead(
        upstreamResponse.statusCode || 502,
        upstreamResponse.headers
      );

      upstreamResponse.on("end", finishRequest);
      upstreamResponse.on("aborted", finishRequest);
      upstreamResponse.on("error", finishRequest);

      upstreamResponse.pipe(res);
    }
  );

  upstreamRequest.on("error", (error: Error) => {
    console.error("Ollama proxy error:", error);

    finishRequest();

    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "text/plain",
      });

      res.end(`Ollama connection failed: ${error.message}`);
    } else {
      res.destroy(error);
    }
  });

  res.on("close", finishRequest);

  upstreamRequest.end(body);
}

// -----------------------------------------------------------------------------
// Proxy lifecycle
// -----------------------------------------------------------------------------

async function stopProxy(): Promise<void> {
  const currentServer = server;
  server = undefined;

  if (!currentServer) {
    return;
  }

  await new Promise<void>((resolve) => {
    currentServer.close(() => resolve());
  });
}

async function startProxy(): Promise<void> {
  await stopProxy();

  const settings = getSettings();

  if (
    !Number.isInteger(settings.proxyPort) ||
    settings.proxyPort < 1024 ||
    settings.proxyPort > 65535
  ) {
    throw new Error("Invalid proxy port configuration");
  }

  try {
    new URL(settings.ollamaUrl);
  } catch {
    throw new Error(
      `Invalid Ollama URL: ${settings.ollamaUrl}`
    );
  }

  const proxyServer = http.createServer((req, res) => {
    handleProxyRequest(req, res, settings);
  });

  server = proxyServer;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      proxyServer.off("listening", onListening);
      reject(error);
    };

    const onListening = (): void => {
      proxyServer.off("error", onError);
      resolve();
    };

    proxyServer.once("error", onError);
    proxyServer.once("listening", onListening);

    proxyServer.listen(settings.proxyPort, "127.0.0.1");
  }).catch(async (error: unknown) => {
    server = undefined;

    await new Promise<void>((resolve) => {
      proxyServer.close(() => resolve());
    });

    throw error;
  });

  console.log(
    `Qwen indicator proxy listening on 127.0.0.1:${settings.proxyPort}`
  );
}

// -----------------------------------------------------------------------------
// VS Code activation
// -----------------------------------------------------------------------------

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  createDecorations(context);

  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  status.command = "continueQwenIndicator.showStatus";
  context.subscriptions.push(status);

  renderIndicator();

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      renderIndicator();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      renderIndicator();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      renderIndicator();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "continueQwenIndicator.showStatus",
      () => {
        const settings = getSettings();

        vscode.window.showInformationMessage(
          [
            `Proxy port: ${settings.proxyPort}`,
            `Ollama URL: ${settings.ollamaUrl}`,
            `Monitored model: ${settings.model}`,
            `Active requests: ${activeRequests}`,
          ].join(" | ")
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "continueQwenIndicator.restartProxy",
      async () => {
        try {
          await startProxy();

          vscode.window.showInformationMessage(
            "Qwen indicator proxy restarted."
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          vscode.window.showErrorMessage(
            `Could not restart Qwen proxy: ${message}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("continueQwenIndicator")
      ) {
        void startProxy().catch((error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          vscode.window.showErrorMessage(
            `Could not restart Qwen proxy: ${message}`
          );
        });
      }
    })
  );

  try {
    await startProxy();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    vscode.window.showErrorMessage(
      `Could not start Qwen proxy: ${message}`
    );
  }
}

// -----------------------------------------------------------------------------
// VS Code deactivation
// -----------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = undefined;
  }

  activeRequests = 0;
  renderIndicator();

  for (const decoration of decorations) {
    decoration.dispose();
  }

  decorations = [];

  status?.dispose();
  status = undefined;

  await stopProxy();
}
