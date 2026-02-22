import * as vscode from 'vscode';
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

    constructor(
        private readonly getActiveChgUri: () => vscode.Uri | undefined,
        private readonly state: ChgState,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html();

        this._postSelection();
        this._postFrames();

        const subs = [
            this.state.onSelectionChange(() => this._postSelection()),
            this.state.onDataChange(() => this._postFrames()),
            this.state.onFrameChange(() => this._postFrames()),
        ];
        webviewView.onDidDispose(() => subs.forEach(s => s.dispose()));

        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; frame?: string }) => {
            switch (msg.command) {
                case 'addNode':     await this._addNode();              break;
                case 'addEdge':     await this._addEdge();              break;
                case 'removeNode':  await this._removeNode();           break;
                case 'removeEdge':  await this._removeEdge();           break;
                case 'selectFrame': this._selectFrame(msg.frame ?? ''); break;
                case 'addFrame':    await this._addFrame();             break;
                case 'deleteFrame': await this._deleteFrame();          break;
                case 'clearFrame':  await this._clearFrame();           break;
                case 'renameFrame': await this._renameFrame();          break;
            }
        });
    }

    private _postSelection(): void {
        this._view?.webview.postMessage({
            command: 'selectionChanged',
            kind: this.state.kind,
        });
    }

    private _postFrames(): void {
        const { data, currentFrame } = this.state;
        this._view?.webview.postMessage({
            command: 'framesChanged',
            frames: data?.frameNames ?? [],
            current: currentFrame,
        });
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
  .section-sep {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #444));
    margin: 8px 0;
  }
  .frame-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
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
</style>
</head>
<body>
<div class="btn-row">
  <button id="addNode">Add Node</button>
  <button id="addEdge">Add Edge</button>
</div>
<button id="deleteNode" class="delete-btn" style="display:none">Delete Node</button>
<button id="deleteEdge" class="delete-btn" style="display:none">Delete Edge</button>

<hr class="section-sep">

<div class="frame-row">
  <span class="frame-label">Frame</span>
  <select id="frameSelect"></select>
</div>
<div class="btn-row">
  <button id="addFrame">Add Frame</button>
  <button id="renameFrame">Rename Frame</button>
</div>
<div class="btn-row">
  <button id="clearFrame" class="delete-btn">Clear Frame</button>
  <button id="deleteFrame" class="delete-btn">Remove Frame</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const frameSelect = document.getElementById('frameSelect');

  document.getElementById('addNode').onclick    = () => vscode.postMessage({ command: 'addNode' });
  document.getElementById('addEdge').onclick    = () => vscode.postMessage({ command: 'addEdge' });
  document.getElementById('deleteNode').onclick = () => vscode.postMessage({ command: 'removeNode' });
  document.getElementById('deleteEdge').onclick = () => vscode.postMessage({ command: 'removeEdge' });

  frameSelect.addEventListener('change', () => {
    vscode.postMessage({ command: 'selectFrame', frame: frameSelect.value });
  });

  document.getElementById('addFrame').onclick    = () => vscode.postMessage({ command: 'addFrame' });
  document.getElementById('renameFrame').onclick = () => vscode.postMessage({ command: 'renameFrame' });
  document.getElementById('clearFrame').onclick  = () => vscode.postMessage({ command: 'clearFrame' });
  document.getElementById('deleteFrame').onclick = () => vscode.postMessage({ command: 'deleteFrame' });

  window.addEventListener('message', evt => {
    const msg = evt.data;
    if (msg.command === 'selectionChanged') {
      document.getElementById('deleteNode').style.display = msg.kind === 'NODE' ? 'block' : 'none';
      document.getElementById('deleteEdge').style.display = msg.kind === 'EDGE' ? 'block' : 'none';
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
    }
  });
</script>
</body>
</html>`;
    }
}
