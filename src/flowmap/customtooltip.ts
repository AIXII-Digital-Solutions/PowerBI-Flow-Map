/**
 * Custom hover tooltip (bold header + "label: value" rows + optional colour swatch),
 * styled like the PowerBI-RealTimePos-Map reference. Replaces the plain Power BI service
 * tooltip so the header can be bold and rows laid out label:value. Positioned near the
 * cursor with edge-flip; a short hide delay avoids flicker when moving between the
 * visible line and its wide hit-buffer.
 */
export interface TipRow {
    label: string;
    value: string;
    color?: string;
}

export class CustomTooltip {
    private readonly _el: HTMLElement;
    private readonly _header: HTMLElement;
    private readonly _body: HTMLElement;
    private _hideTimer: number = null;

    constructor(container: HTMLElement) {
        const el = this._el = document.createElement('div');
        el.className = 'flowmap-tooltip';
        this._header = document.createElement('div');
        this._header.className = 'flowmap-tooltip-header';
        this._body = document.createElement('div');
        this._body.className = 'flowmap-tooltip-body';
        el.appendChild(this._header);
        el.appendChild(this._body);
        container.appendChild(el);
    }

    public show(header: string, rows: TipRow[]): void {
        if (this._hideTimer) {
            window.clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }
        this._header.textContent = header || '';
        this._header.style.display = header ? '' : 'none';
        this._body.textContent = '';
        for (const row of rows) {
            const r = document.createElement('div');
            r.className = 'flowmap-tooltip-row';
            const lbl = document.createElement('span');
            lbl.className = 'flowmap-tooltip-label';
            if (row.color) {
                const sw = document.createElement('span');
                sw.className = 'flowmap-tooltip-swatch';
                sw.style.background = row.color;
                lbl.appendChild(sw);
            }
            lbl.appendChild(document.createTextNode(row.label || ''));
            const val = document.createElement('span');
            val.className = 'flowmap-tooltip-value';
            val.textContent = row.value == null ? '' : row.value + '';
            r.appendChild(lbl);
            r.appendChild(val);
            this._body.appendChild(r);
        }
        this._el.classList.add('visible');
    }

    /** Position near the cursor (client coords), flipping away from the right/bottom edge. */
    public move(clientX: number, clientY: number, container: HTMLElement): void {
        const rect = container.getBoundingClientRect();
        const pad = 14;
        let x = clientX - rect.left + pad;
        let y = clientY - rect.top + pad;
        const tw = this._el.offsetWidth, th = this._el.offsetHeight;
        if (x + tw > rect.width) {
            x = clientX - rect.left - tw - pad;
        }
        if (y + th > rect.height) {
            y = clientY - rect.top - th - pad;
        }
        this._el.style.left = Math.max(2, x) + 'px';
        this._el.style.top = Math.max(2, y) + 'px';
    }

    public hide(): void {
        if (this._hideTimer) {
            window.clearTimeout(this._hideTimer);
        }
        this._hideTimer = window.setTimeout(() => this._el.classList.remove('visible'), 60);
    }
}
