import * as vscode from 'vscode';
import { ChgData } from './chgOutlineProvider';

export type SelectedKind = 'NODE' | 'EDGE' | 'PATH' | null;

export class ChgState {
    private _kind: SelectedKind = null;
    private _label: string | null = null;
    private _data: ChgData | null = null;
    private _currentFrame: string | null = null;

    private readonly _onSelectionChange = new vscode.EventEmitter<void>();
    readonly onSelectionChange = this._onSelectionChange.event;

    private readonly _onDataChange = new vscode.EventEmitter<void>();
    readonly onDataChange = this._onDataChange.event;

    private _layout: string = 'grid';
    private readonly _onLayoutChange = new vscode.EventEmitter<string>();
    readonly onLayoutChange = this._onLayoutChange.event;

    private readonly _onFrameChange = new vscode.EventEmitter<string | null>();
    readonly onFrameChange = this._onFrameChange.event;

    get kind(): SelectedKind { return this._kind; }
    get label(): string | null { return this._label; }
    get data(): ChgData | null { return this._data; }
    get layout(): string { return this._layout; }
    get currentFrame(): string | null { return this._currentFrame; }

    setSelection(kind: SelectedKind, label: string | null): void {
        this._kind = kind;
        this._label = label;
        this._onSelectionChange.fire();
    }

    setData(data: ChgData | null): void {
        this._data = data;
        // Auto-initialize _currentFrame to the first available frame if needed.
        if (data && data.frameNames.length > 0) {
            if (!this._currentFrame || !data.frameNames.includes(this._currentFrame)) {
                this._currentFrame = data.frameNames[0];
            }
        } else if (!data) {
            this._currentFrame = null;
        }
        this._onDataChange.fire();
    }

    setLayout(layout: string): void {
        this._layout = layout;
        this._onLayoutChange.fire(layout);
    }

    /** VCHG_CURRENT_FRAME – the currently active frame for non-constant node values. */
    setCurrentFrame(frame: string | null): void {
        this._currentFrame = frame;
        this._onFrameChange.fire(frame);
    }

    clearSelection(): void {
        this.setSelection(null, null);
    }
}
