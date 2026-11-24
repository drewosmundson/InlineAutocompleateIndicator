








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