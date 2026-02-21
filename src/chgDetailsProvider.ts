import * as vscode from 'vscode';
import { ChgState } from './chgState';
import { ChgNode, ChgEdge } from './chgOutlineProvider';

function coerceValue(str: string): string | number {
    const num = Number(str);
    return isNaN(num) ? str : num;
}

function esc(v: unknown): string {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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

export class ChgDetailsProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly state: ChgState,
        private readonly getActiveChgUri: () => vscode.Uri | undefined
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        this._refresh();

        const subs = [
            this.state.onSelectionChange(() => this._refresh()),
            this.state.onDataChange(() => this._refresh()),
            this.state.onFrameChange(() => this._refresh()),
            webviewView.webview.onDidReceiveMessage(async (msg: { command: string; field: string; value: unknown }) => {
                if (msg.command === 'update') {
                    await this._applyUpdate(msg.field, msg.value);
                }
            }),
        ];
        webviewView.onDidDispose(() => subs.forEach(s => s.dispose()));
    }

    private _refresh(): void {
        if (!this._view) { return; }
        this._view.webview.html = this._buildHtml();
    }

    /** Resolves a node's display value from the current frame (non-constant) or node.value (constant). */
    private _getNodeValue(node: ChgNode): unknown {
        const isConst = node.is_constant ?? node.constant;
        if (isConst) {
            return node.value;
        }
        const { currentFrame, data } = this.state;
        if (currentFrame && data?.frames?.[currentFrame]) {
            const frameNodeData = data.frames[currentFrame][node.label];
            if (frameNodeData !== undefined) {
                return Array.isArray(frameNodeData) ? frameNodeData[0] : frameNodeData;
            }
        }
        return node.value; // fallback for non-constant nodes with a legacy static value
    }

    private _buildHtml(): string {
        const { kind, label, data } = this.state;
        let body = '<p class="hint">Nothing selected.</p>';

        if (kind === 'NODE' && label && data) {
            const node = data.nodes.find(n => n.label === label);
            if (node) { body = this._nodeForm(node); }
        } else if (kind === 'EDGE' && label && data) {
            const edge = data.edges.find(e => e.label === label);
            if (edge) { body = this._edgeForm(edge, data.nodes.map(n => n.label)); }
        } else if (kind === 'PATH') {
            body = '<p class="hint">Path details not yet available.</p>';
        }

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
  .hint { color: var(--vscode-descriptionForeground); font-style: italic; padding: 4px 0; }
  .row { margin-bottom: 8px; }
  label {
    display: block;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }
  input[type="text"], input[type="number"], textarea {
    width: 100%; box-sizing: border-box; padding: 3px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  textarea {
    height: 120px;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .check-row { display: flex; align-items: center; gap: 6px; }
  .check-row label { margin: 0; color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  .frame-hint { font-size: 0.85em; opacity: 0.7; }
  .src-keys-section { display: flex; align-items: stretch; margin-bottom: 8px; gap: 6px; }
  .src-keys-rotated {
    writing-mode: vertical-lr; transform: rotate(180deg);
    font-size: 0.85em; color: var(--vscode-descriptionForeground);
    white-space: nowrap; align-self: center;
  }
  .src-keys-grid { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .src-key-cell { width: calc(50% - 3px); box-sizing: border-box; }
  .src-key-node { display: block; font-size: 0.85em; color: var(--vscode-descriptionForeground);
    margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  input.key-error {
    border-color: var(--vscode-inputValidation-errorBorder, #f44) !important;
    color: var(--vscode-inputValidation-errorForeground, #f44);
  }
</style>
</head>
<body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('change', () => {
      const field = el.dataset.field;
      const value = el.type === 'checkbox' ? el.checked : el.value;
      vscode.postMessage({ command: 'update', field, value });
    });
  });

  function validateSourceKeys() {
    const inputs = Array.from(document.querySelectorAll('[data-field^="source-key:"]'));
    const counts = {};
    for (const el of inputs) {
      const v = el.value.trim();
      if (v) { counts[v] = (counts[v] || 0) + 1; }
    }
    for (const el of inputs) {
      const v = el.value.trim();
      const isDup = v && counts[v] > 1;
      el.classList.toggle('key-error', isDup);
      el.title = isDup ? 'Duplicate key \u2014 each source must have a unique key' : '';
    }
  }

  document.querySelectorAll('[data-field^="source-key:"]').forEach(el => {
    el.addEventListener('input', validateSourceKeys);
  });
  validateSourceKeys();
</script>
</body>
</html>`;
    }

    private _nodeForm(node: ChgNode): string {
        const isConst = node.is_constant ?? node.constant;
        const displayValue = this._getNodeValue(node);
        const frameHint = !isConst && this.state.currentFrame
            ? ` <span class="frame-hint">(${esc(this.state.currentFrame)})</span>`
            : '';
        return `
<div class="row"><label>Label</label>
  <input type="text" data-field="label" value="${esc(node.label)}">
</div>
<div class="row"><label>Value${frameHint}</label>
  <input type="text" data-field="value" value="${esc(displayValue)}">
</div>
<div class="row"><label>Description</label>
  <input type="text" data-field="description" value="${esc(node.description)}">
</div>
<div class="row"><label>Units</label>
  <input type="text" data-field="units" value="${esc(node.units)}">
</div>
<div class="row check-row">
  <input type="checkbox" data-field="constant" id="chk-const" ${isConst ? 'checked' : ''}>
  <label for="chk-const">Constant</label>
</div>`;
    }

    private _edgeForm(edge: ChgEdge, nodeLabels: string[]): string {
        const sourcesVal = Array.isArray(edge.sources) ? edge.sources.map(s => s.label).join(', ') : '';
        const datalist = nodeLabels.map(l => `<option value="${esc(l)}">`).join('');
        return `
<datalist id="node-list">${datalist}</datalist>
<div class="row"><label>Label</label>
  <input type="text" data-field="label" value="${esc(edge.label)}">
</div>
<div class="row"><label>Weight</label>
  <input type="number" data-field="weight" value="${esc(edge.weight)}">
</div>
<div class="row"><label>Sources (comma-separated)</label>
  <input type="text" data-field="sources" value="${esc(sourcesVal)}" list="node-list">
</div>
${edge.sources.length > 0 ? `<div class="src-keys-section">
  <span class="src-keys-rotated">Keys</span>
  <div class="src-keys-grid">
    ${edge.sources.map(s => `<div class="src-key-cell">
      <span class="src-key-node">${esc(s.label)}</span>
      <input type="text" data-field="source-key:${esc(s.handle)}" value="${esc(s.handle)}">
    </div>`).join('')}
  </div>
</div>` : ''}
<div class="row"><label>Target</label>
  <input type="text" data-field="target" value="${esc(edge.target)}" list="node-list">
</div>
<div class="row"><label>Rule</label>
  <textarea data-field="rule">${esc(edge.rel)}</textarea>
</div>`;
    }

    private async _applyUpdate(field: string, value: unknown): Promise<void> {
        const uri = this.getActiveChgUri();
        if (!uri) { return; }
        const { kind, label } = this.state;
        if (!kind || !label) { return; }

        const doc = await vscode.workspace.openTextDocument(uri);
        let raw: any;
        try { raw = JSON.parse(doc.getText()); }
        catch { return; }

        if (kind === 'NODE') {
            this._updateNode(raw, label, field, value);
        } else if (kind === 'EDGE') {
            this._updateEdge(raw, label, field, value);
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(raw, null, 2));
        await vscode.workspace.applyEdit(edit);
    }

    private _updateNode(raw: any, nodeLabel: string, field: string, value: unknown): void {
        const nodes = getNodes(raw);
        const node = nodes.find((n: any) => n.label === nodeLabel);
        if (!node) { return; }

        if (field === 'label') {
            const newLabel = String(value);
            const edges = getEdges(raw);
            for (const e of edges) {
                if (Array.isArray(e.source_nodes)) {
                    e.source_nodes = e.source_nodes.map((s: string) => s === nodeLabel ? newLabel : s);
                }
                if (Array.isArray(e.sources)) {
                    e.sources = e.sources.map((s: string) => s === nodeLabel ? newLabel : s);
                }
                if (e.target === nodeLabel) { e.target = newLabel; }
            }
            // Rename the node's entries in all frames
            if (raw.frames) {
                for (const frameData of Object.values(raw.frames) as any[]) {
                    if (frameData && frameData[nodeLabel] !== undefined) {
                        frameData[newLabel] = frameData[nodeLabel];
                        delete frameData[nodeLabel];
                    }
                }
            }
            node.label = newLabel;
            this.state.setSelection('NODE', newLabel);

        } else if (field === 'value') {
            const isConst = node.is_constant ?? node.constant;
            const str = String(value);
            if (isConst) {
                // Constant: persist directly in the node object (static_value).
                if (str === '') { delete node.value; } else { node.value = coerceValue(str); }
            } else {
                // Non-constant: persist in the current frame.
                const currentFrame = this.state.currentFrame;
                if (currentFrame) {
                    if (!raw.frames) { raw.frames = {}; }
                    if (!raw.frames[currentFrame]) { raw.frames[currentFrame] = {}; }
                    if (str === '') {
                        delete raw.frames[currentFrame][nodeLabel];
                    } else {
                        raw.frames[currentFrame][nodeLabel] = [coerceValue(str)];
                    }
                }
            }

        } else if (field === 'constant') {
            const newIsConstant = Boolean(value);
            const currentFrame = this.state.currentFrame;

            if (newIsConstant) {
                // Becoming constant: pull current value from frame into node.value.
                if (currentFrame && raw.frames?.[currentFrame]?.[nodeLabel] !== undefined) {
                    const frameVals = raw.frames[currentFrame][nodeLabel];
                    node.value = Array.isArray(frameVals) ? frameVals[0] : frameVals;
                    delete raw.frames[currentFrame][nodeLabel];
                }
                node.is_constant = true;
                delete node.constant; // remove legacy field if present
            } else {
                // Becoming non-constant: move node.value into the current frame.
                if (node.value !== undefined && node.value !== null && node.value !== '') {
                    const frame = currentFrame ?? 'frame0';
                    if (!raw.frames) { raw.frames = {}; }
                    if (!raw.frames[frame]) { raw.frames[frame] = {}; }
                    raw.frames[frame][nodeLabel] = [node.value];
                    delete node.value;
                }
                delete node.is_constant;
                delete node.constant;
            }

        } else {
            const str = String(value);
            if (str === '') { delete node[field]; } else { node[field] = str; }
        }
    }

    private _updateEdge(raw: any, edgeLabel: string, field: string, value: unknown): void {
        const edges = getEdges(raw);
        const edge = edges.find((e: any) => e.label === edgeLabel);
        if (!edge) { return; }

        if (field === 'label') {
            edge.label = String(value);
            this.state.setSelection('EDGE', String(value));
        } else if (field.startsWith('source-key:')) {
            const oldHandle = field.slice('source-key:'.length);
            const newHandle = String(value).trim();
            if (!newHandle || newHandle === oldHandle) { return; }
            // Rename the key in the source_nodes object (object-keyed format).
            if (edge.source_nodes && typeof edge.source_nodes === 'object' && !Array.isArray(edge.source_nodes)) {
                if (edge.source_nodes[oldHandle] !== undefined) {
                    edge.source_nodes[newHandle] = edge.source_nodes[oldHandle];
                    delete edge.source_nodes[oldHandle];
                }
            }
        } else if (field === 'weight') {
            const num = parseFloat(String(value));
            if (isNaN(num)) { delete edge.weight; } else { edge.weight = num; }
        } else if (field === 'sources') {
            const parts = String(value).split(',').map((s: string) => s.trim()).filter(Boolean);
            const nodeLabels = new Set<string>(getNodes(raw).map((n: any) => n.label));
            for (const part of parts) {
                if (!nodeLabels.has(part)) {
                    vscode.window.showWarningMessage(`Node "${part}" is not found in the hypergraph.`);
                }
            }
            // Preserve object format (keyed source_nodes) when it already exists.
            if (edge.source_nodes && typeof edge.source_nodes === 'object' && !Array.isArray(edge.source_nodes)) {
                const oldSn: Record<string, string> = edge.source_nodes;
                // Reverse map: node label → existing key
                const labelToKey: Record<string, string> = {};
                for (const [k, v] of Object.entries(oldSn)) { labelToKey[v as string] = k; }
                const newSn: Record<string, string> = {};
                for (const part of parts) {
                    if (labelToKey[part]) {
                        newSn[labelToKey[part]] = part; // reuse existing key
                    } else {
                        // Assign a new key: use node label (lower) or fall back to sN
                        let key = part.toLowerCase();
                        if (newSn[key] !== undefined) {
                            let i = 1;
                            while (newSn[`s${i}`] !== undefined) { i++; }
                            key = `s${i}`;
                        }
                        newSn[key] = part;
                    }
                }
                edge.source_nodes = newSn;
            } else {
                edge.source_nodes = parts;
            }
        } else if (field === 'target') {
            const target = String(value);
            if (target !== '') {
                const nodeLabels = new Set<string>(getNodes(raw).map((n: any) => n.label));
                if (!nodeLabels.has(target)) {
                    vscode.window.showWarningMessage(`Node "${target}" is not found in the hypergraph.`);
                }
            }
            edge.target = target;
        } else if (field === 'rule') {
            const str = String(value);
            if (str === '') { delete edge.rel; } else { edge.rel = str; }
        }
    }
}
