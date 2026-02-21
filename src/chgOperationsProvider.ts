import * as vscode from 'vscode';
import * as cp from 'child_process';
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

// Returns the mutable edges array from either nested or flat JSON structure.
function getEdges(raw: any): any[] {
    if (raw.hypergraph) {
        if (!Array.isArray(raw.hypergraph.edges)) { raw.hypergraph.edges = []; }
        return raw.hypergraph.edges;
    }
    if (!Array.isArray(raw.edges)) { raw.edges = []; }
    return raw.edges;
}

export class ChgOperationsProvider implements vscode.WebviewViewProvider {
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

        // Send current state immediately so UI starts correctly.
        this._postSelection();
        this._postFrames();

        const subs = [
            this.state.onSelectionChange(() => this._postSelection()),
            this.state.onDataChange(() => this._postFrames()),
            this.state.onFrameChange(() => this._postFrames()),
        ];
        webviewView.onDidDispose(() => subs.forEach(s => s.dispose()));

        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; frame?: string; toPrint?: boolean; minIndex?: number }) => {
            switch (msg.command) {
                case 'addNode':     await this._addNode();                                              break;
                case 'addEdge':     await this._addEdge();                                              break;
                case 'removeNode':  await this._removeNode();                                           break;
                case 'removeEdge':  await this._removeEdge();                                           break;
                case 'selectFrame': this._selectFrame(msg.frame ?? '');                                 break;
                case 'addFrame':    await this._addFrame();                                             break;
                case 'deleteFrame': await this._deleteFrame();                                          break;
                case 'clearFrame':  await this._clearFrame();                                           break;
                case 'renameFrame': await this._renameFrame();                                          break;
                case 'simulate':    await this._simulate(msg.toPrint ?? true, msg.minIndex ?? 0);       break;
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

    private _postFrames(): void {
        const { data, currentFrame } = this.state;
        this._view?.webview.postMessage({
            command: 'framesChanged',
            frames: data?.frameNames ?? [],
            current: currentFrame,
            nodeHasValue: this._selectedNodeHasValue(),
        });
    }

    // ── Add operations ────────────────────────────────────────────────────────

    private async _addNode(): Promise<void> {
        const label = await vscode.window.showInputBox({
            prompt: 'Node label',
            placeHolder: 'e.g. x',
        });
        if (label === undefined) { return; }
        await this._editJson(raw => {
            const nodes = getNodes(raw);
            if (nodes.some((n: any) => n.label === label)) {
                vscode.window.showErrorMessage(`Node "${label}" already exists.`);
                return false;
            }
            nodes.push({ label });
            return true;
        });
    }

    private async _addEdge(): Promise<void> {
        const label = await vscode.window.showInputBox({
            prompt: 'Edge label',
            placeHolder: 'e.g. e1',
        });
        if (label === undefined) { return; }
        await this._editJson(raw => {
            const edges = getEdges(raw);
            if (edges.some((e: any) => e.label === label)) {
                vscode.window.showErrorMessage(`Edge "${label}" already exists.`);
                return false;
            }
            edges.push({ label, source_nodes: [], target: '' });
            return true;
        });
    }

    // ── Remove operations ─────────────────────────────────────────────────────

    private async _removeNode(): Promise<void> {
        const { kind, label } = this.state;
        if (kind !== 'NODE' || !label) { return; }
        await this._editJson(raw => {
            const nodes = getNodes(raw);
            const idx = nodes.findIndex((n: any) => n.label === label);
            if (idx === -1) { return false; }
            nodes.splice(idx, 1);
            const edges = getEdges(raw);
            for (const e of edges) {
                if (Array.isArray(e.source_nodes)) {
                    e.source_nodes = e.source_nodes.filter((s: string) => s !== label);
                }
                if (Array.isArray(e.sources)) {
                    e.sources = e.sources.filter((s: string) => s !== label);
                }
                if (e.target === label) { e.target = ''; }
            }
            // Remove the node's entries from all frames.
            if (raw.frames) {
                for (const frameData of Object.values(raw.frames) as any[]) {
                    delete frameData[label];
                }
            }
            return true;
        });
        this.state.setSelection(null, null);
    }

    private async _removeEdge(): Promise<void> {
        const { kind, label } = this.state;
        if (kind !== 'EDGE' || !label) { return; }
        await this._editJson(raw => {
            const edges = getEdges(raw);
            const idx = edges.findIndex((e: any) => e.label === label);
            if (idx === -1) { return false; }
            edges.splice(idx, 1);
            return true;
        });
        this.state.setSelection(null, null);
    }

    // ── Frame operations ──────────────────────────────────────────────────────

    private _selectFrame(frame: string): void {
        if (frame) { this.state.setCurrentFrame(frame); }
    }

    private async _addFrame(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'New frame name',
            placeHolder: 'e.g. frame_2',
        });
        if (!name) { return; }
        await this._editJson(raw => {
            if (!raw.frames) { raw.frames = {}; }
            if (raw.frames[name] !== undefined) {
                vscode.window.showErrorMessage(`Frame "${name}" already exists.`);
                return false;
            }
            raw.frames[name] = {};
            return true;
        });
        this.state.setCurrentFrame(name);
    }

    private async _deleteFrame(): Promise<void> {
        const currentFrame = this.state.currentFrame;
        if (!currentFrame) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete frame "${currentFrame}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }
        const remaining = (this.state.data?.frameNames ?? []).filter(f => f !== currentFrame);
        await this._editJson(raw => {
            if (!raw.frames?.[currentFrame]) { return false; }
            delete raw.frames[currentFrame];
            return true;
        });
        this.state.setCurrentFrame(remaining[0] ?? null);
    }

    private async _clearFrame(): Promise<void> {
        const currentFrame = this.state.currentFrame;
        if (!currentFrame) { return; }
        await this._editJson(raw => {
            if (!raw.frames) { return false; }
            raw.frames[currentFrame] = {};
            return true;
        });
    }

    private async _renameFrame(): Promise<void> {
        const currentFrame = this.state.currentFrame;
        if (!currentFrame) { return; }
        const newName = await vscode.window.showInputBox({
            prompt: 'Rename frame',
            value: currentFrame,
        });
        if (!newName || newName === currentFrame) { return; }
        await this._editJson(raw => {
            if (!raw.frames?.[currentFrame]) { return false; }
            if (raw.frames[newName] !== undefined) {
                vscode.window.showErrorMessage(`Frame "${newName}" already exists.`);
                return false;
            }
            raw.frames[newName] = raw.frames[currentFrame];
            delete raw.frames[currentFrame];
            return true;
        });
        this.state.setCurrentFrame(newName);
    }

    // ── Simulate ──────────────────────────────────────────────────────────────

    private async _simulate(toPrint: boolean = true, minIndex: number = 0): Promise<void> {
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
        const result = await this._runScript(pyPath, uri.fsPath, label, frameKey, toPrint, minIndex);

        if (result.error) {
            vscode.window.showErrorMessage(`Simulation failed: ${result.error}`);
            return;
        }

        await this._writeSimulationResult(uri, label, result.value, frameKey);

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
        toPrint: boolean, minIndex: number
    ): Promise<{ value?: unknown; cost?: unknown; tree?: string; error?: string; msg?: string }> {
        return new Promise(resolve => {
            const p = cp.spawn(
                pyPath,
                [this.scriptPath, filePath, outputNode, frameKey, String(toPrint), String(minIndex)],
                { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
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

    // ── JSON helper ───────────────────────────────────────────────────────────

    private async _editJson(mutate: (raw: any) => boolean): Promise<void> {
        const uri = this.getActiveChgUri();
        if (!uri) { vscode.window.showErrorMessage('No active .chg file.'); return; }
        const doc = await vscode.workspace.openTextDocument(uri);
        let raw: any;
        try { raw = JSON.parse(doc.getText()); }
        catch { vscode.window.showErrorMessage('Cannot parse .chg file.'); return; }
        if (!mutate(raw)) { return; }
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
  .delete-btn {
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  .delete-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
  }
  .btn-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .btn-row button { flex: 1; width: auto; margin-bottom: 0; }
  .separator { border: none; border-top: 1px solid var(--vscode-widget-border, #444); margin: 8px 0; }
  .frame-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .frame-label {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }
  select {
    flex: 1; width: auto; padding: 4px 6px; box-sizing: border-box;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
  }
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
  /* Custom context menu */
  #ctx-menu {
    position: fixed; display: none; z-index: 9999;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #444));
    border-radius: 3px; padding: 4px 0; min-width: 150px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  #ctx-menu .item {
    padding: 5px 14px; cursor: pointer;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    font-size: var(--vscode-font-size);
  }
  #ctx-menu .item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  }
  #ctx-menu .sep { border-top: 1px solid var(--vscode-menu-border, #444); margin: 3px 0; }
</style>
</head>
<body>
<div class="btn-row">
  <button id="addNode">Add Node</button>
  <button id="addEdge">Add Edge</button>
</div>
<button id="deleteNode" class="delete-btn" style="display:none">Delete Node</button>
<button id="deleteEdge" class="delete-btn" style="display:none">Delete Edge</button>

<hr class="separator">

<div id="sim-section" style="display:none">
  <button id="simulate">Simulate</button>
  <div class="sim-opts">
    <label><input type="checkbox" id="toPrint" checked> to_print</label>
    <label>min_index <input type="number" id="minIndex" value="0" min="0"></label>
  </div>
</div>

<div class="frame-row">
  <span class="frame-label">Frame</span>
  <select id="frameSelect"></select>
</div>

<div id="ctx-menu">
  <div class="item" id="ctx-add">Add Frame</div>
  <div class="item" id="ctx-rename">Rename Frame</div>
  <div class="sep"></div>
  <div class="item" id="ctx-clear">Clear Frame</div>
  <div class="item" id="ctx-delete">Delete Frame</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const frameSelect = document.getElementById('frameSelect');
  const ctxMenu = document.getElementById('ctx-menu');

  document.getElementById('addNode').onclick    = () => vscode.postMessage({ command: 'addNode' });
  document.getElementById('addEdge').onclick    = () => vscode.postMessage({ command: 'addEdge' });
  document.getElementById('deleteNode').onclick = () => vscode.postMessage({ command: 'removeNode' });
  document.getElementById('deleteEdge').onclick = () => vscode.postMessage({ command: 'removeEdge' });
  document.getElementById('simulate').onclick   = () => vscode.postMessage({
    command: 'simulate',
    toPrint: document.getElementById('toPrint').checked,
    minIndex: parseInt(document.getElementById('minIndex').value) || 0,
  });

  frameSelect.addEventListener('change', () => {
    vscode.postMessage({ command: 'selectFrame', frame: frameSelect.value });
  });

  // Show context menu on right-click of the frame selector.
  frameSelect.addEventListener('contextmenu', e => {
    e.preventDefault();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.style.display = 'block';
  });

  // Hide context menu when clicking elsewhere.
  document.addEventListener('click', () => {
    ctxMenu.style.display = 'none';
  });

  document.getElementById('ctx-add').onclick    = () => { ctxMenu.style.display = 'none'; vscode.postMessage({ command: 'addFrame' }); };
  document.getElementById('ctx-rename').onclick = () => { ctxMenu.style.display = 'none'; vscode.postMessage({ command: 'renameFrame' }); };
  document.getElementById('ctx-clear').onclick  = () => { ctxMenu.style.display = 'none'; vscode.postMessage({ command: 'clearFrame' }); };
  document.getElementById('ctx-delete').onclick = () => { ctxMenu.style.display = 'none'; vscode.postMessage({ command: 'deleteFrame' }); };

  window.addEventListener('message', evt => {
    const msg = evt.data;
    if (msg.command === 'selectionChanged') {
      document.getElementById('deleteNode').style.display   = msg.kind === 'NODE' ? 'block' : 'none';
      document.getElementById('deleteEdge').style.display   = msg.kind === 'EDGE' ? 'block' : 'none';
      document.getElementById('sim-section').style.display  = msg.kind === 'NODE' ? 'block' : 'none';
      document.getElementById('simulate').disabled = !!msg.nodeHasValue;
    } else if (msg.command === 'framesChanged') {
      const cur = msg.current;
      frameSelect.innerHTML = '';
      if (!msg.frames || msg.frames.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no frames)';
        frameSelect.appendChild(opt);
      } else {
        for (const name of msg.frames) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          if (name === cur) { opt.selected = true; }
          frameSelect.appendChild(opt);
        }
      }
      document.getElementById('simulate').disabled = !!msg.nodeHasValue;
    }
  });
</script>
</body>
</html>`;
    }
}
