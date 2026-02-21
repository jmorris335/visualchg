import * as vscode from 'vscode';
import { ChgOutlineProvider } from './chgOutlineProvider';
import { ChgState } from './chgState';
import { ChgOperationsProvider } from './chgOperationsProvider';
import { ChgDetailsProvider } from './chgDetailsProvider';
import { ChgEditorProvider } from './chgEditorProvider';
import { ChgViewProvider } from './chgViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const state = new ChgState();
    const provider = new ChgOutlineProvider();

    const treeView = vscode.window.createTreeView('chgOutlineView', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    // ── Helpers ──────────────────────────────────────────────────────────────

    function isChgDocument(doc: vscode.TextDocument): boolean {
        return doc.fileName.endsWith('.chg');
    }

    function getActiveChgUri(): vscode.Uri | undefined {
        const active = vscode.window.activeTextEditor;
        if (active && isChgDocument(active.document)) { return active.document.uri; }
        return vscode.workspace.textDocuments.find(isChgDocument)?.uri;
    }

    // Ensures the .chg file has at least one frame; creates "frame0" if none exist.
    async function ensureFrame0(uri: vscode.Uri): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        let raw: any;
        try { raw = JSON.parse(doc.getText()); } catch { return; }
        if (!raw.frames || Object.keys(raw.frames).length === 0) {
            if (!raw.frames) { raw.frames = {}; }
            raw.frames.frame0 = {};
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(raw, null, 2));
            await vscode.workspace.applyEdit(edit);
        }
    }

    // Load a .chg document into the provider; returns true if it was a .chg file.
    function updateFromDocument(doc: vscode.TextDocument): boolean {
        if (!isChgDocument(doc)) { return false; }
        const ok = provider.loadFromDocument(doc);
        treeView.message = ok ? undefined : 'Error parsing .chg file.';
        const data = provider.getData();
        state.setData(data);
        // Create frame0 if no frames exist yet.
        if (data && data.frameNames.length === 0) {
            ensureFrame0(doc.uri);
        }
        return true;
    }

    // Sync the outline with whatever .chg file is most relevant right now.
    function syncWithEditor(): void {
        const active = vscode.window.activeTextEditor;
        if (active && updateFromDocument(active.document)) { return; }

        // Fall back to any open .chg document.
        const openChg = vscode.workspace.textDocuments.find(isChgDocument);
        if (openChg) {
            updateFromDocument(openChg);
        } else {
            provider.clear();
            state.setData(null);
            treeView.message = 'Open a .chg file to see the outline.';
        }
    }

    // ── Status bar ───────────────────────────────────────────────────────────

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    context.subscriptions.push(statusBar);

    function updateStatusBar(): void {
        const { kind, label, data } = state;
        if (!kind || !label) { statusBar.hide(); return; }

        if (kind === 'NODE' && data) {
            const node = data.nodes.find(n => n.label === label);
            if (node) {
                const val = (node.value !== undefined && node.value !== null && node.value !== '')
                    ? ` = ${node.value}${node.units ? ' ' + node.units : ''}`
                    : '';
                statusBar.text = `${node.label}${val}`;
                statusBar.tooltip = `Node: ${node.label}${val}`;
                statusBar.show();
                return;
            }
        } else if (kind === 'EDGE' && data) {
            const edge = data.edges.find(e => e.label === label);
            if (edge) {
                const weight = edge.weight !== undefined ? ` (weight: ${edge.weight})` : '';
                statusBar.text = `${edge.label}${weight}`;
                statusBar.tooltip = `Edge: ${edge.label}${weight}`;
                statusBar.show();
                return;
            }
        }
        statusBar.hide();
    }

    context.subscriptions.push(
        state.onSelectionChange(() => updateStatusBar()),
        state.onDataChange(() => updateStatusBar()),
    );

    // ── Initial load ─────────────────────────────────────────────────────────

    syncWithEditor();

    // ── Register main editor ──────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            ChgEditorProvider.viewType,
            new ChgEditorProvider(context, state),
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
    );

    // ── Register primary sidebar providers ───────────────────────────────────

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'chgOperationsView',
            new ChgOperationsProvider(getActiveChgUri, state)
        ),
        vscode.window.registerWebviewViewProvider(
            'chgDetailsView',
            new ChgDetailsProvider(state, getActiveChgUri)
        ),
        vscode.window.registerWebviewViewProvider('chgViewPanel', new ChgViewProvider(state)),
    );

    // ── Event listeners ──────────────────────────────────────────────────────

    context.subscriptions.push(
        // Live sync: re-parse on every keystroke in a .chg document.
        vscode.workspace.onDidChangeTextDocument(e => {
            updateFromDocument(e.document);
        }),

        // Update when the user switches editor tabs.
        vscode.window.onDidChangeActiveTextEditor(() => {
            syncWithEditor();
        }),

        // Catch .chg files opened programmatically or from the file system.
        vscode.workspace.onDidOpenTextDocument(doc => {
            updateFromDocument(doc);
        }),

        // Watch for .chg file changes on disk (edits outside VS Code).
        (() => {
            const watcher = vscode.workspace.createFileSystemWatcher('**/*.chg');
            watcher.onDidChange(uri => {
                // If the file is already open as a TextDocument, VS Code will
                // emit onDidChangeTextDocument when the user accepts the reload.
                // Handle the case where it is NOT open as a document.
                const open = vscode.workspace.textDocuments.find(
                    d => d.uri.fsPath === uri.fsPath
                );
                if (!open) {
                    provider.loadFromPath(uri.fsPath);
                }
            });
            return watcher;
        })(),

        // Selection: set global context vars and update shared state.
        treeView.onDidChangeSelection(e => {
            if (e.selection.length === 0) { return; }
            const { itemKind } = e.selection[0];

            let kind: 'NODE' | 'EDGE' | undefined;
            let label: string | undefined;

            if (itemKind.tag === 'node' || itemKind.tag === 'node-ref') {
                kind  = 'NODE';
                label = itemKind.nodeLabel;
            } else if (itemKind.tag === 'edge' || itemKind.tag === 'edge-ref') {
                kind  = 'EDGE';
                label = itemKind.edgeLabel;
            }

            if (kind && label) {
                vscode.commands.executeCommand('setContext', 'visualchg.selectedKind',  kind);
                vscode.commands.executeCommand('setContext', 'visualchg.selectedLabel', label);
                state.setSelection(kind, label);
            }
        }),

        treeView,
    );
}

export function deactivate() {}
