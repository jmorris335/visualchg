import * as vscode from 'vscode';
import { ChgState } from './chgState';

const LAYOUTS: { id: string; label: string }[] = [
    { id: 'grid',        label: 'Grid'          },
    { id: 'circle',      label: 'Circle'        },
    { id: 'concentric',  label: 'Concentric'    },
    { id: 'breadthfirst',label: 'Tree'          },
    { id: 'cose',        label: 'Cose' },
    { id: 'random',      label: 'Random'        },
];

export class ChgViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly state: ChgState) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._html();

        webviewView.webview.onDidReceiveMessage((msg: { command: string; layout?: string }) => {
            if (msg.command === 'setLayout') {
                this.state.setLayout(msg.layout ?? 'grid');
            }
        });
    }

    private _html(): string {
        const buttons = LAYOUTS.map(l =>
            `<button class="layout-btn" data-layout="${l.id}">${l.label}</button>`
        ).join('\n        ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    margin: 0;
    padding: 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  button {
    display: block; width: 100%; padding: 3px 8px; margin: 0;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; cursor: pointer; text-align: left; border-radius: 2px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
</style>
</head>
<body>
<div class="grid">
        ${buttons}
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.onclick = () =>
      vscode.postMessage({ command: 'setLayout', layout: btn.dataset.layout });
  });
</script>
</body>
</html>`;
    }
}
