import * as vscode from 'vscode';
import { ChgState, SimPath } from './chgState';
import { parseChgData } from './chgOutlineProvider';

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

export class ChgEditorProvider implements vscode.CustomTextEditorProvider {
    static readonly viewType = 'visualchg.chgEditor';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly state: ChgState
    ) {}

    resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): void {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        const nonce = getNonce();
        webviewPanel.webview.html = this._buildHtml(webviewPanel.webview, nonce);

        const postData = () => {
            const data = parseChgData(document.getText());
            webviewPanel.webview.postMessage({ type: 'setData', data });
        };

        const postSelection = () => {
            webviewPanel.webview.postMessage({
                type: 'setSelection',
                kind: this.state.kind,
                label: this.state.label,
            });
        };

        const postLayout = (layout: string) => {
            webviewPanel.webview.postMessage({ type: 'setLayout', layout });
        };

        const postSimPath = (path: SimPath) => {
            if (path) {
                webviewPanel.webview.postMessage({ type: 'setSimPath', path });
            } else {
                webviewPanel.webview.postMessage({ type: 'clearSimPath' });
            }
        };

        const subs = [
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === document.uri.toString()) {
                    postData();
                }
            }),
            this.state.onSelectionChange(() => postSelection()),
            this.state.onLayoutChange(layout => postLayout(layout)),
            this.state.onSimPathChange(path => postSimPath(path)),
        ];

        webviewPanel.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'ready':
                    postData();
                    postSelection();
                    postLayout(this.state.layout);
                    if (this.state.simPath) { postSimPath(this.state.simPath); }
                    break;
                case 'select':
                    vscode.commands.executeCommand('setContext', 'visualchg.selectedKind', msg.kind);
                    vscode.commands.executeCommand('setContext', 'visualchg.selectedLabel', msg.label);
                    this.state.setSelection(msg.kind as 'NODE' | 'EDGE', msg.label);
                    break;
                case 'deselect':
                    this.state.setSelection(null, null);
                    break;
            }
        });

        webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
    }

    private _buildHtml(webview: vscode.Webview, nonce: string): string {
        const mediaUri = (file: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

        const cssUri      = mediaUri('chg-editor.css');
        const graphStyleUri = mediaUri('chg-graph-style.js');
        const csp = webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com ${csp};
           style-src ${csp};">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="cy"></div>
<div id="sim-info"></div>
<svg id="sim-svg" xmlns="http://www.w3.org/2000/svg">
  <line id="sim-leader-line" x1="0" y1="0" x2="0" y2="0"></line>
</svg>
<script src="${graphStyleUri}"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────────────────────
  let currentData = null;
  let selectedKind = null;
  let selectedLabel = null;
  let lastLayout = 'grid';
  let currentSimPath = null;

  // ── Cytoscape ────────────────────────────────────────────────────────────────
  const cy = cytoscape({
    container:          document.getElementById('cy'),
    elements:           [],
    style:              buildCyStyle(),
    layout:             { name: 'preset' },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    selectionType:      'single',
    minZoom:            0.05,
    maxZoom:            5,
  });

  // ── Build Cytoscape elements from CHG data ────────────────────────────────────
  function buildElements(data) {
    if (!data) { return []; }
    const els = [];
    const nodeSet = new Set((data.nodes || []).map(n => n.label));

    for (const node of (data.nodes || [])) {
      els.push({ data: { id: 'n:' + node.label, label: node.label, type: 'chg-node' } });
    }

    for (const edge of (data.edges || [])) {
      els.push({ data: { id: 'e:' + edge.label, label: edge.label, type: 'chg-edge' } });

      for (const src of (edge.sources || [])) {
        const srcLabel = (src && typeof src === 'object') ? src.label : src;
        if (nodeSet.has(srcLabel)) {
          els.push({ data: { id: 'se:' + edge.label + ':' + srcLabel, source: 'n:' + srcLabel, target: 'e:' + edge.label } });
        }
      }

      if (edge.target && nodeSet.has(edge.target)) {
        els.push({ data: { id: 'te:' + edge.label, source: 'e:' + edge.label, target: 'n:' + edge.target } });
      }
    }

    return els;
  }

  // ── Position helpers ──────────────────────────────────────────────────────────
  function positionGroup(arr, x) {
    const n = arr.length;
    const STEP = 90;
    arr.forEach((el, i) => el.position({ x, y: (i - (n - 1) / 2) * STEP }));
  }

  // ── Display mode ──────────────────────────────────────────────────────────────
  function applyDisplayMode() {
    cy.elements().removeClass('dimmed selected label-visible');
    cy.layout({ name: lastLayout, fit: true, padding: 40, animate: false }).run();
  }

  // ── Focused node mode ─────────────────────────────────────────────────────────
  // Centers the selected CHG node. Leading edges (where node is target) + their
  // sources go left. Trailing edges (where node is a source) + their targets go right.
  function applyFocusedNode(label) {
    const central = cy.getElementById('n:' + label);
    if (central.empty()) { applyDisplayMode(); return; }

    // Leading: hyperedge nodes pointing TO the central node, and their source CHG nodes
    const leadEdgeNodes = central.incomers('node[type="chg-edge"]');
    const leadSrcNodes  = leadEdgeNodes.incomers('node[type="chg-node"]');
    const leadCyEdges   = central.incomers('edge').union(leadEdgeNodes.incomers('edge'));

    // Trailing: hyperedge nodes the central node points TO, and their target CHG nodes
    const trailEdgeNodes = central.outgoers('node[type="chg-edge"]');
    const trailTgtNodes  = trailEdgeNodes.outgoers('node[type="chg-node"]');
    const trailCyEdges   = central.outgoers('edge').union(trailEdgeNodes.outgoers('edge'));

    const relevant = central
      .union(leadEdgeNodes).union(leadSrcNodes).union(leadCyEdges)
      .union(trailEdgeNodes).union(trailTgtNodes).union(trailCyEdges);

    cy.elements().addClass('dimmed').removeClass('selected label-visible');
    relevant.removeClass('dimmed');
    leadEdgeNodes.union(trailEdgeNodes).addClass('label-visible');
    central.addClass('selected');

    const X = 220;
    central.position({ x: 0, y: 0 });
    positionGroup(leadEdgeNodes.toArray(), -X);
    positionGroup(leadSrcNodes.toArray(), -X * 2);
    positionGroup(trailEdgeNodes.toArray(), X);
    positionGroup(trailTgtNodes.toArray(), X * 2);

    if (!relevant.empty()) { cy.fit(relevant, 60); }
  }

  // ── Focused edge mode ─────────────────────────────────────────────────────────
  // Centers the selected hyperedge. Source CHG nodes go left, target CHG node goes right.
  function applyFocusedEdge(label) {
    const central = cy.getElementById('e:' + label);
    if (central.empty()) { applyDisplayMode(); return; }

    const srcNodes = central.incomers('node[type="chg-node"]');
    const tgtNodes = central.outgoers('node[type="chg-node"]');
    const cyEdges  = central.incomers('edge').union(central.outgoers('edge'));

    const relevant = central.union(srcNodes).union(tgtNodes).union(cyEdges);

    cy.elements().addClass('dimmed').removeClass('selected label-visible');
    relevant.removeClass('dimmed');
    central.addClass('selected label-visible');

    const X = 200;
    central.position({ x: 0, y: 0 });
    positionGroup(srcNodes.toArray(), -X);
    positionGroup(tgtNodes.toArray(), X);

    if (!relevant.empty()) { cy.fit(relevant, 60); }
  }

  // ── Apply selection / mode switch ─────────────────────────────────────────────
  function applySelection(kind, label) {
    selectedKind  = kind;
    selectedLabel = label;
    if (!kind || !label)      { applyDisplayMode(); }
    else if (kind === 'NODE') { applyFocusedNode(label); }
    else if (kind === 'EDGE') { applyFocusedEdge(label); }
  }

  // ── Simulation path highlighting ──────────────────────────────────────────

  const simInfo   = document.getElementById('sim-info');
  const simSvg    = document.getElementById('sim-svg');
  const simLeader = document.getElementById('sim-leader-line');

  function updateSimLeader() {
    if (!currentSimPath) { return; }
    const targetEl = cy.getElementById('n:' + currentSimPath.targetNode);
    if (targetEl.empty()) { return; }

    const pos      = targetEl.renderedPosition();
    const infoRect = simInfo.getBoundingClientRect();

    // Anchor the leader to the bottom-left corner of the info box.
    const x1 = infoRect.left;
    const y1 = infoRect.bottom;
    const x2 = pos.x;
    const y2 = pos.y;

    simLeader.setAttribute('x1', x1);
    simLeader.setAttribute('y1', y1);
    simLeader.setAttribute('x2', x2);
    simLeader.setAttribute('y2', y2);
  }

  function applySimPath(path) {
    currentSimPath = path;

    // Highlight matching nodes and edges with the sim-path class.
    cy.elements().removeClass('sim-path');
    for (const nodeLabel of (path.nodes || [])) {
      cy.getElementById('n:' + nodeLabel).addClass('sim-path');
    }
    for (const edgeLabel of (path.edges || [])) {
      cy.getElementById('e:' + edgeLabel).addClass('sim-path');
    }
    // Highlight arrows whose both endpoints are already in the sim path.
    cy.edges().forEach(e => {
      if (e.source().hasClass('sim-path') && e.target().hasClass('sim-path')) {
        e.addClass('sim-path');
      }
    });

    // Populate and show the info box.
    simInfo.textContent = '';
    const lines = [
      'Cost: ' + (typeof path.cost === 'number' ? path.cost.toPrecision(4) : path.cost),
      'Edges: ' + path.numEdges,
      'Nodes: ' + path.numNodes,
    ];
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      simInfo.appendChild(div);
    }
    simInfo.style.display = 'block';
    simSvg.style.display  = 'block';

    updateSimLeader();
  }

  function clearSimPath() {
    currentSimPath = null;
    cy.elements().removeClass('sim-path');
    simInfo.style.display = 'none';
    simSvg.style.display  = 'none';
  }

  cy.on('viewport layoutstop', updateSimLeader);

  // ── Hot-reload styles on VS Code theme change ────────────────────────────────
  new MutationObserver(() => cy.style(buildCyStyle())).observe(
    document.body, { attributes: true, attributeFilter: ['class', 'style'] }
  );

  // ── Click handlers ────────────────────────────────────────────────────────────
  cy.on('tap', 'node', evt => {
    const n = evt.target;
    const kind = n.data('type') === 'chg-node' ? 'NODE' : 'EDGE';
    vscode.postMessage({ type: 'select', kind, label: n.data('label') });
  });

  cy.on('tap', evt => {
    if (evt.target === cy) {
      vscode.postMessage({ type: 'deselect' });
    }
  });

  // ── Messages from extension ───────────────────────────────────────────────────
  window.addEventListener('message', evt => {
    const msg = evt.data;
    if (msg.type === 'setData') {
      currentData = msg.data;
      cy.elements().remove();
      if (currentData) { cy.add(buildElements(currentData)); }
      // Re-apply sim path after rebuilding elements (classes are wiped by the remove/add).
      if (currentSimPath) { applySimPath(currentSimPath); }
      applySelection(selectedKind, selectedLabel);
    } else if (msg.type === 'setSelection') {
      applySelection(msg.kind, msg.label);
    } else if (msg.type === 'setLayout') {
      lastLayout = msg.layout || 'grid';
      applyDisplayMode();
    } else if (msg.type === 'setSimPath') {
      applySimPath(msg.path);
    } else if (msg.type === 'clearSimPath') {
      clearSimPath();
    }
  });

  // Signal to extension that the webview is ready to receive data
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
    }
}
