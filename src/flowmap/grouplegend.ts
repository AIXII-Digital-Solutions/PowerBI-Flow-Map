/**
 * Group (secondary-grouping / colour) legend — a collapsible corner box, ported from
 * the PowerBI-RealTimePos-Map reference (.aircraft-legend*). It appears only when a
 * secondary-grouping (Color) field is bound. Each row is a group swatch + label and is
 * clickable to cross-filter that group (plain / Ctrl-toggle / Shift handled by the visual).
 */
export interface LegendGroup {
    key: string;
    color: string;
    label: string;
}

export interface LegendOptions {
    show: boolean;
    position: 'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft';
    orientation: 'vertical' | 'horizontal';
    expanded: boolean;
    width: number;
    fontSize: number;
    title: string;
}

export class GroupLegend {
    private readonly _root: HTMLElement;
    private readonly _header: HTMLButtonElement;
    private readonly _body: HTMLElement;
    private readonly _list: HTMLElement;
    private _userToggled = false;

    /** Set by the visual — (groupKey, event) → select that group. */
    public onSelect: (key: string, ev: MouseEvent) => void = null;

    constructor(container: HTMLElement) {
        const root = this._root = document.createElement('div');
        root.className = 'flowmap-legend';
        root.style.display = 'none';

        const header = this._header = document.createElement('button');
        header.type = 'button';
        header.className = 'flowmap-legend-header';
        header.textContent = 'Legend';
        header.addEventListener('click', e => {
            e.stopPropagation();
            this._userToggled = true;
            root.classList.toggle('expanded');
        });

        const body = this._body = document.createElement('div');
        body.className = 'flowmap-legend-body';
        const list = this._list = document.createElement('div');
        list.className = 'flowmap-legend-list';
        body.appendChild(list);

        root.appendChild(header);
        root.appendChild(body);
        container.appendChild(root);
    }

    /** Rebuild the legend from the current groups + settings + selected set. */
    public update(groups: LegendGroup[], opts: LegendOptions, selected: Set<string>): void {
        if (!opts.show || !groups.length) {
            this._root.style.display = 'none';
            return;
        }
        this._root.style.display = '';
        this._header.textContent = (opts.title || '').trim() || 'Legend';
        // Preserve the user's expand/collapse across rebuilds; only follow the setting
        // until the user first toggles it this session.
        const wasExpanded = this._root.classList.contains('expanded');
        this._root.className = 'flowmap-legend pos-' + opts.position +
            (opts.orientation === 'horizontal' ? ' orient-horizontal' : '');
        this._root.classList.toggle('expanded', this._userToggled ? wasExpanded : !!opts.expanded);
        this._root.style.width = opts.orientation === 'horizontal'
            ? '' : Math.max(90, Math.min(420, opts.width || 130)) + 'px';
        this._root.style.fontSize = (opts.fontSize || 11) + 'px';

        this._list.textContent = '';
        for (const g of groups) {
            const row = document.createElement('div');
            row.className = 'flowmap-legend-row' + (selected.has(g.key) ? ' selected' : '');
            row.setAttribute('data-group', g.key);
            row.addEventListener('click', e => {
                e.stopPropagation();
                this.onSelect && this.onSelect(g.key, e as MouseEvent);
            });
            const sw = document.createElement('span');
            sw.className = 'flowmap-legend-swatch';
            sw.style.background = g.color;
            const nm = document.createElement('span');
            nm.className = 'flowmap-legend-name';
            nm.textContent = g.label;
            row.appendChild(sw);
            row.appendChild(nm);
            this._list.appendChild(row);
        }
    }

    /** Sync only the .selected row highlight (cheap, no rebuild). */
    public refreshSelected(selected: Set<string>): void {
        const rows = this._list.querySelectorAll('.flowmap-legend-row');
        for (let i = 0; i < rows.length; i++) {
            const el = rows[i] as HTMLElement;
            el.classList.toggle('selected', selected.has(el.getAttribute('data-group')));
        }
    }
}
