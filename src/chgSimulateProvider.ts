import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ChgState } from './chgState';

// Returns the mutable nodes array from either nested or flat JSON structure.
function getNodes(raw: any): any[] {
    if (raw.hypergraph) {
        if (!Array.isArray(raw.hypergraph.nodes)) { raw.hypergraph.nodes = []; }
        return raw.hypergraph.nodes;
    }
    if (!Array.isArray(raw.nodes)) { raw.nodes = []; }
    return raw.nodes;
}

export class ChgSimulateProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _outputChannel?: vscode.OutputChannel;

    constructor(
        private readonly getActiveChgUri: () => vscode.Uri | undefined,
        private readonly state: ChgState,
        private readonly getPythonPath: () => string | null | undefined,
        private readonly scriptPath: string
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html();

        this._postSelection();

        const subs = [
            this.state.onSelectionChange(() => this._postSelection()),
            this.state.onDataChange(() => {
                // Only clear the sim path if the target node no longer exists in the graph.
                // This preserves the highlight through value updates (e.g. simulation result writes)
                // while still clearing when the user removes or renames the target node.
                const sp = this.state.simPath;
                if (sp && !(this.state.data?.nodes.some(n => n.label === sp.targetNode) ?? false)) {
                    this.state.setSimPath(null);
                }
                this._postSelection();
            }),
            this.state.onFrameChange(() => this._postSelection()),
            this.state.onSimPathChange(p => this._view?.webview.postMessage({ command: 'simPathChanged', hasPath: p !== null })),
        ];
        webviewView.onDidDispose(() => subs.forEach(s => s.dispose()));

        webviewView.webview.onDidReceiveMessage(async (msg: {
            command: string;
            toPrint?: boolean;
            minIndex?: number;
            loggingLevel?: number;
            debugNodes?: string[];
            debugEdges?: string[];
        }) => {
            switch (msg.command) {
                case 'clearSimulation': this.state.setSimPath(null);                                                                                                     break;
                case 'simulate':        await this._simulate(msg.toPrint ?? true, msg.minIndex ?? 0, msg.loggingLevel ?? 0, msg.debugNodes ?? [], msg.debugEdges ?? []); break;
            }
        });
    }

    private _selectedNodeHasValue(): boolean {
        const { kind, label, data, currentFrame } = this.state;
        if (kind !== 'NODE' || !label || !data) { return false; }
        const node = data.nodes.find(n => n.label === label);
        if (!node) { return false; }
        const isConst = node.is_constant ?? node.constant;
        if (isConst) {
            return node.value !== undefined && node.value !== null && node.value !== '';
        }
        if (currentFrame && data.frames[currentFrame]) {
            const v = data.frames[currentFrame][label];
            if (Array.isArray(v)) { return v.length > 0 && v[0] !== undefined && v[0] !== null && v[0] !== ''; }
            return v !== undefined && v !== null;
        }
        return node.value !== undefined && node.value !== null && node.value !== '';
    }

    private _postSelection(): void {
        this._view?.webview.postMessage({
            command: 'selectionChanged',
            kind: this.state.kind,
            nodeHasValue: this._selectedNodeHasValue(),
        });
    }

    // ── Simulate ──────────────────────────────────────────────────────────────

    private async _simulate(toPrint: boolean = true, minIndex: number = 0, loggingLevel: number = 0, debugNodes: string[] = [], debugEdges: string[] = []): Promise<void> {
        const pyPath = this.getPythonPath();
        if (pyPath === undefined) {
            vscode.window.showWarningMessage('Python detection is still in progress. Please try again in a moment.');
            return;
        }
        if (pyPath === null) {
            vscode.window.showErrorMessage('Python not found. Please install Python 3 and ensure it is on your PATH.');
            return;
        }

        const hasConstrainthg = await this._checkPackage(pyPath, 'constrainthg');
        if (!hasConstrainthg) {
            const action = await vscode.window.showErrorMessage(
                'The constrainthg package is not installed.',
                'Copy pip command'
            );
            if (action === 'Copy pip command') {
                vscode.env.clipboard.writeText('pip install constrainthg');
            }
            return;
        }

        const uri = this.getActiveChgUri();
        if (!uri) { vscode.window.showErrorMessage('No active .chg file.'); return; }

        const { kind, label, currentFrame } = this.state;
        if (kind !== 'NODE' || !label) { return; }

        const frameKey = currentFrame ?? '';
        const result = await this._runScript(pyPath, uri.fsPath, label, frameKey, toPrint, minIndex, loggingLevel, debugNodes, debugEdges);

        if (result.error) {
            vscode.window.showErrorMessage(`Simulation failed: ${result.error}`);
            return;
        }

        await this._writeSimulationResult(uri, label, result.value, frameKey);

        if (result.target_node !== undefined && result.path_nodes !== undefined) {
            this.state.setSimPath({
                targetNode: result.target_node,
                nodes: result.path_nodes,
                edges: result.path_edges ?? [],
                cost: result.cost ?? 0,
                numEdges: result.num_edges ?? 0,
                numNodes: result.num_nodes ?? 0,
            });
        }

        if (!this._outputChannel) {
            this._outputChannel = vscode.window.createOutputChannel('CHG Simulation');
        }
        this._outputChannel.clear();
        this._outputChannel.appendLine(`Simulation result: ${result.msg}`);
        if (result.tree && toPrint) {
            this._outputChannel.appendLine('');
            this._outputChannel.append(result.tree as string);
        }
        this._outputChannel.show(true);
    }

    private _checkPackage(pyPath: string, pkg: string): Promise<boolean> {
        return new Promise(resolve => {
            const p = cp.spawn(pyPath, ['-c', `import ${pkg}`], { shell: false, stdio: 'ignore' });
            p.on('close', code => resolve(code === 0));
            p.on('error', () => resolve(false));
        });
    }

    private _runScript(
        pyPath: string, filePath: string, outputNode: string, frameKey: string,
        toPrint: boolean, minIndex: number,
        loggingLevel: number = 0, debugNodes: string[] = [], debugEdges: string[] = []
    ): Promise<{ value?: unknown; cost?: number; tree?: string; error?: string; msg?: string; target_node?: string; path_nodes?: string[]; path_edges?: string[]; num_nodes?: number; num_edges?: number }> {
        return new Promise(resolve => {
            const p = cp.spawn(
                pyPath,
                [
                    this.scriptPath, filePath, outputNode, frameKey,
                    String(toPrint), String(minIndex),
                    String(loggingLevel),
                    debugNodes.join(','),
                    debugEdges.join(','),
                ],
                { shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(filePath) }
            );
            let stdout = '';
            let stderr = '';
            p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            p.on('close', code => {
                try {
                    // to_print=True may produce non-JSON lines before the final result.
                    // Find the last line that looks like a JSON object.
                    const lines = stdout.trim().split('\n');
                    const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{')) ?? '';
                    resolve(JSON.parse(jsonLine));
                } catch {
                    resolve({ error: stderr.trim() || stdout.trim() || `Process exited with code ${code}` });
                }
            });
            p.on('error', err => resolve({ error: err.message }));
        });
    }

    private async _writeSimulationResult(
        uri: vscode.Uri, nodeLabel: string, value: unknown, frameKey: string
    ): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        let raw: any;
        try { raw = JSON.parse(doc.getText()); } catch { return; }

        const nodes = getNodes(raw);
        const node = nodes.find((n: any) => n.label === nodeLabel);
        if (!node) { return; }

        const isConst = node.is_constant ?? node.constant;
        if (isConst) {
            node.value = value;
        } else if (frameKey) {
            if (!raw.frames) { raw.frames = {}; }
            if (!raw.frames[frameKey]) { raw.frames[frameKey] = {}; }
            raw.frames[frameKey][nodeLabel] = [value];
        } else {
            node.value = value;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(raw, null, 2));
        await vscode.workspace.applyEdit(edit);
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _html(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  button {
    display: block; width: 100%; margin-bottom: 6px; padding: 5px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; cursor: pointer; text-align: left; border-radius: 2px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:disabled:hover { background: var(--vscode-button-background); }
  .sim-opts {
    display: flex; gap: 16px; align-items: center; margin-bottom: 8px;
  }
  .sim-opts label {
    display: flex; align-items: center; gap: 4px;
    color: var(--vscode-foreground); cursor: pointer;
  }
  .sim-opts input[type="number"] {
    width: 56px; padding: 2px 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .debug-section { margin-bottom: 8px; }
  .debug-section label {
    display: block; margin-bottom: 2px; font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .debug-section input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 2px 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
</style>
</head>
<body>

<div id="sim-section" style="display:none">
  <button id="simulate">Simulate</button>
  <div class="sim-opts">
    <label>min_index <input type="number" id="minIndex" value="0" min="0"></label>
  </div>
  <div class="sim-opts">
    <label><input type="checkbox" id="toPrint" checked> to_print</label>
    <label>log_level <input type="number" id="loggingLevel" value="0" min="0"></label>
  </div>
  <div class="debug-section">
    <label>debug_nodes</label>
    <input type="text" id="debugNodes" placeholder="node1, node2">
  </div>
  <div class="debug-section">
    <label>debug_edges</label>
    <input type="text" id="debugEdges" placeholder="edge1, edge2">
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  function splitCsv(str) {
    return str.split(',').map(s => s.trim()).filter(Boolean);
  }

  let simPathActive = false;
  let nodeHasValue = false;
  const simBtn = document.getElementById('simulate');

  function updateSimBtn() {
    // Disabled only when the node already has a value AND no sim path is active.
    // When a sim path is active, the button clears it, so it must always be enabled.
    simBtn.disabled = nodeHasValue && !simPathActive;
  }

  simBtn.onclick = () => {
    if (simPathActive) {
      vscode.postMessage({ command: 'clearSimulation' });
    } else {
      vscode.postMessage({
        command: 'simulate',
        toPrint: document.getElementById('toPrint').checked,
        minIndex: parseInt(document.getElementById('minIndex').value) || 0,
        loggingLevel: parseInt(document.getElementById('loggingLevel').value) || 0,
        debugNodes: splitCsv(document.getElementById('debugNodes').value),
        debugEdges: splitCsv(document.getElementById('debugEdges').value),
      });
    }
  };

  window.addEventListener('message', evt => {
    const msg = evt.data;
    if (msg.command === 'selectionChanged') {
      document.getElementById('sim-section').style.display = msg.kind === 'NODE' ? 'block' : 'none';
      nodeHasValue = !!msg.nodeHasValue;
      updateSimBtn();
    } else if (msg.command === 'simPathChanged') {
      simPathActive = msg.hasPath;
      simBtn.textContent = msg.hasPath ? 'Clear Simulation' : 'Simulate';
      updateSimBtn();
    }
  });
</script>
</body>
</html>`;
    }
}
