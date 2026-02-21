import * as vscode from 'vscode';
import * as fs from 'fs';

// ─── Data model ──────────────────────────────────────────────────────────────

export interface ChgNode {
    label: string;
    value?: unknown;
    is_constant?: boolean;
    description?: string;
    units?: string;
    constant?: boolean;  // kept for backward compatibility
}

export interface ChgSource {
    handle: string;
    label: string;
}

export interface ChgEdge {
    label: string;
    weight?: number;
    constant?: boolean;
    sources: ChgSource[];
    target: string;
    rel?: string;
}

export interface ChgData {
    nodes: ChgNode[];
    edges: ChgEdge[];
    frames: Record<string, Record<string, unknown[]>>;
    frameNames: string[];
}

// ─── Tree item kinds (discriminated union) ────────────────────────────────────

export type ChgItemKind =
    | { tag: 'nodes-root' }
    | { tag: 'edges-root' }
    | { tag: 'node';     nodeLabel: string }
    | { tag: 'edge';     edgeLabel: string }
    | { tag: 'edge-ref'; edgeLabel: string; parentId: string; role: 'leading' | 'trailing' }
    | { tag: 'node-ref'; nodeLabel: string; parentId: string; role: 'source' | 'target'; missing?: boolean };

// ─── Unique ID generation ─────────────────────────────────────────────────────

function kindToId(kind: ChgItemKind): string {
    switch (kind.tag) {
        case 'nodes-root': return 'nodes-root';
        case 'edges-root': return 'edges-root';
        case 'node':       return `node:${kind.nodeLabel}`;
        case 'edge':       return `edge:${kind.edgeLabel}`;
        case 'edge-ref':   return `edge-ref:${kind.edgeLabel}@${kind.parentId}`;
        case 'node-ref':   return `node-ref:${kind.nodeLabel}@${kind.parentId}`;
    }
}

// ─── Tree item ────────────────────────────────────────────────────────────────

export class ChgOutlineItem extends vscode.TreeItem {
    constructor(
        displayLabel: string,
        public readonly itemKind: ChgItemKind,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(displayLabel, collapsibleState);
        this.id = kindToId(itemKind);
        this.contextValue = itemKind.tag;

        switch (itemKind.tag) {
            case 'node':
                // this.iconPath = new vscode.ThemeIcon('circle-outline');
                this.tooltip = `Node: ${itemKind.nodeLabel}`;
                break;
            case 'edge':
                // this.iconPath = new vscode.ThemeIcon('symbol-boolean');
                this.tooltip = `Edge: ${itemKind.edgeLabel}`;
                break;
            case 'node-ref':
                if (itemKind.missing) {
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
                    this.tooltip = `Node "${itemKind.nodeLabel}" is not in the hypergraph`;
                } else {
                    this.iconPath = new vscode.ThemeIcon(
                        itemKind.role === 'target' ? 'circle-filled' : 'circle-outline'
                    );
                    this.tooltip = `Node: ${itemKind.nodeLabel}`;
                }
                break;
            case 'edge-ref':
                this.iconPath = new vscode.ThemeIcon(
                    itemKind.role === 'leading' ? 'debug-step-into' : 'debug-step-out'
                );
                this.tooltip = `Edge: ${itemKind.edgeLabel}`;
                break;
            case 'nodes-root':
            case 'edges-root':
                break;
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEdgeLabel(edge: ChgEdge): string {
    const sources = edge.sources.map(s => s.label).join(', ');
    return `${edge.label}: {${sources}} \u2192 ${edge.target ?? '?'}`;
}

export function parseChgData(text: string): ChgData | null {
    try {
        const raw: any = JSON.parse(text);

        // Support both nested { hypergraph: { nodes, edges } } and flat { nodes, edges }
        const hg = raw.hypergraph ?? raw;

        const nodes: ChgNode[] = [];
        if (Array.isArray(hg.nodes)) {
            for (const n of hg.nodes) {
                if (typeof n?.label === 'string') {
                    const isConst = n.is_constant ?? n.constant;
                    nodes.push({
                        label:       n.label,
                        value:       n.value,
                        is_constant: isConst,
                        description: n.description,
                        units:       n.units,
                        constant:    isConst,
                    });
                }
            }
        }

        const edges: ChgEdge[] = [];
        if (Array.isArray(hg.edges)) {
            for (const e of hg.edges) {
                if (typeof e?.label !== 'string') { continue; }
                const sources: ChgSource[] = [];
                const rawSources = e.source_nodes ?? e.sources;
                if (Array.isArray(rawSources)) {
                    rawSources.forEach((s: unknown, i: number) => {
                        sources.push({ handle: String(i), label: String(s) });
                    });
                } else if (rawSources && typeof rawSources === 'object') {
                    for (const [handle, label] of Object.entries(rawSources)) {
                        sources.push({ handle, label: String(label) });
                    }
                }
                edges.push({
                    label:    e.label,
                    weight:   e.weight ?? e.cost,
                    constant: e.constant,
                    sources,
                    target:   typeof e.target === 'string' ? e.target : '',
                    rel:     e.rel,
                });
            }
        }

        // Parse frames
        const frames: Record<string, Record<string, unknown[]>> = {};
        const frameNames: string[] = [];
        if (raw.frames && typeof raw.frames === 'object') {
            for (const [frameName, frameData] of Object.entries(raw.frames)) {
                if (frameData && typeof frameData === 'object') {
                    frames[frameName] = {};
                    for (const [nodeLabel, values] of Object.entries(frameData as any)) {
                        frames[frameName][nodeLabel] = Array.isArray(values) ? values as unknown[] : [values];
                    }
                    frameNames.push(frameName);
                }
            }
        }

        return { nodes, edges, frames, frameNames };
    } catch (err) {
        console.error('[CHG] parse error:', err);
        return null;
    }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class ChgOutlineProvider implements vscode.TreeDataProvider<ChgOutlineItem> {
    private readonly _onDidChangeTreeData =
        new vscode.EventEmitter<ChgOutlineItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private data: ChgData | null = null;

    // Returns true if parsing succeeded, false on bad JSON (data unchanged).
    loadFromDocument(document: vscode.TextDocument): boolean {
        const parsed = parseChgData(document.getText());
        if (parsed !== null) {
            this.data = parsed;
        }
        this._onDidChangeTreeData.fire();
        return parsed !== null;
    }

    loadFromPath(filePath: string): boolean {
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            return this.loadFromText(text);
        } catch {
            this._onDidChangeTreeData.fire();
            return false;
        }
    }

    private loadFromText(text: string): boolean {
        const parsed = parseChgData(text);
        if (parsed !== null) {
            this.data = parsed;
        }
        this._onDidChangeTreeData.fire();
        return parsed !== null;
    }

    getData(): ChgData | null { return this.data; }

    clear(): void {
        this.data = null;
        this._onDidChangeTreeData.fire();
    }

    // ── TreeDataProvider ────────────────────────────────────────────────────

    getTreeItem(element: ChgOutlineItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ChgOutlineItem): ChgOutlineItem[] {
        if (!this.data) {
            return [];
        }

        const { nodes, edges } = this.data;

        if (!element) {
            return [
                new ChgOutlineItem('Nodes', { tag: 'nodes-root' }, vscode.TreeItemCollapsibleState.Expanded),
                new ChgOutlineItem('Edges', { tag: 'edges-root' }, vscode.TreeItemCollapsibleState.Expanded),
            ];
        }

        switch (element.itemKind.tag) {
            case 'nodes-root':
                return nodes.map(n => {
                    const hasEdges = edges.some(
                        e => e.target === n.label || e.sources.some(s => s.label === n.label)
                    );
                    return new ChgOutlineItem(
                        n.label,
                        { tag: 'node', nodeLabel: n.label },
                        hasEdges
                            ? vscode.TreeItemCollapsibleState.Collapsed
                            : vscode.TreeItemCollapsibleState.None
                    );
                });

            case 'edges-root':
                return edges.map(e =>
                    new ChgOutlineItem(
                        formatEdgeLabel(e),
                        { tag: 'edge', edgeLabel: e.label },
                        vscode.TreeItemCollapsibleState.Collapsed
                    )
                );

            // Leading edge-refs first, then trailing — no intermediate group items.
            case 'node': {
                const { nodeLabel } = element.itemKind;
                const leadingRefs = edges
                    .filter(e => e.target === nodeLabel)
                    .map(e => new ChgOutlineItem(
                        formatEdgeLabel(e),
                        { tag: 'edge-ref', edgeLabel: e.label, parentId: `lead:${nodeLabel}`, role: 'leading' },
                        vscode.TreeItemCollapsibleState.None
                    ));
                const trailingRefs = edges
                    .filter(e => e.sources.some(s => s.label === nodeLabel))
                    .map(e => new ChgOutlineItem(
                        formatEdgeLabel(e),
                        { tag: 'edge-ref', edgeLabel: e.label, parentId: `trail:${nodeLabel}`, role: 'trailing' },
                        vscode.TreeItemCollapsibleState.None
                    ));
                return [...leadingRefs, ...trailingRefs];
            }

            // Source node-refs then target node-ref; missing refs shown with error icon.
            case 'edge': {
                const { edgeLabel } = element.itemKind;
                const edge = edges.find(e => e.label === edgeLabel);
                if (!edge) { return []; }
                const nodeSet = new Set(nodes.map(n => n.label));
                const sourceRefs = edge.sources.map(src =>
                    new ChgOutlineItem(
                        src.label,
                        { tag: 'node-ref', nodeLabel: src.label, parentId: `src:${edgeLabel}:${src.handle}`, role: 'source', missing: !nodeSet.has(src.label) },
                        vscode.TreeItemCollapsibleState.None
                    )
                );
                const targetRef = new ChgOutlineItem(
                    edge.target,
                    { tag: 'node-ref', nodeLabel: edge.target, parentId: `tgt:${edgeLabel}`, role: 'target', missing: edge.target !== '' && !nodeSet.has(edge.target) },
                    vscode.TreeItemCollapsibleState.None
                );
                return [...sourceRefs, targetRef];
            }

            default:
                return [];
        }
    }
}
