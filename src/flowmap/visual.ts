import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;
import VisualObjectInstance = powerbi.VisualObjectInstance;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import { Persist, Context, tooltip, Fill } from "../pbi";
import { visualObjects as numberObjects, build as numberFormat } from '../pbi/numberFormat';
import { coords } from '../pbi/misc';
import { Format } from "./format";

import { override, groupBy, StringMap, Func, copy, values, sort, dict } from '../lava/type';
import { selex } from "../lava/d3";
import { MapFormat, ILocation, MapStyle } from "../lava/map";
import * as app from '../lava/flowmap/app';
import { keys, sum } from "d3";
import { event as d3event } from 'd3-selection';
import { GroupLegend } from './grouplegend';
import { CustomTooltip } from './customtooltip';
import { setBundleAlpha } from '../lava/flowmap/algo';

type Role = 'Origin' | 'Dest' | 'width' | 'color' | 'OLati' | 'OLong' | 'DLati' | 'DLong' | 'OName' | 'DName' | 'Tooltip' | 'FilterBy';
type Read<T> = Func<number, T>;
type Ctx = Context<Role, Format>;

const persist = {
    map: new Persist<[ILocation, number]>('persist', 'map'),
    manual: new Persist<StringMap<ILocation>>('persist', 'manual'),
    banner: new Persist<string[]>('persist', 'banner')
} as const;

class helper {
    private static _items(ctx: Ctx, role: Role = 'Tooltip'): Read<string[]> {
        const conv = numberFormat(ctx.meta.valueFormat);
        const values = (ctx.roles.columns(role) || []).map(c => c.values);
        return r => values.map(c => typeof c[r] === 'number' ? conv(+c[r]) : c[r] + '');
    }

    private static _tips(ctx: Ctx, rows: number[], name: Read<string>, header: string, value: Read<string[]>) {
        const tops = helper._top(ctx, rows), color = ctx.cat('color') && ctx.meta.flow.colorCustomize;
        const rowToColor = (r: number) => color ? app.$state.color(r) : undefined;
        const result = tops.map(r => tooltip.item(value(r).join(', '), name(r), header, rowToColor(r)));
        if (tops.length < rows.length) {
            result.push(tooltip.item(`(${rows.length - tops.length} more)`, `...`, header, color ? '#00000000' : undefined));
        }
        return result;
    }

    /** Flight count for a set of rows: sum of the Width field when it is a numeric
     * measure (Width = number of flights), otherwise the number of records. */
    private static _count(ctx: Ctx, rows: number[]): string {
        let n: number;
        if (ctx.cat('width') && ctx.type('width').numeric) {
            const vals = ctx.nums('width');
            n = rows.reduce((s, r) => s + (+vals[r] || 0), 0);
        }
        else {
            n = rows.length;
        }
        return numberFormat(ctx.meta.valueFormat)(n);
    }

    /** Friendly row name: the OName/DName field when present & non-null, else the raw
     * Origin/Dest value (so the header never shows "→ null" for blank name columns). */
    private static _name(ctx: Ctx, nameRole: Role, baseRole: Role): Read<string> {
        const nameFn = ctx.cat(nameRole) ? ctx.key(nameRole) : null;
        const baseFn = ctx.key(baseRole);
        return r => {
            if (nameFn) {
                const v = nameFn(r);
                if (v !== null && v !== undefined && v !== '' && v !== 'null') { return v; }
            }
            return baseFn(r);
        };
    }

    /** Tooltip label: drop Power BI's aggregation prefix ("First Master Series" →
     * "Master Series") and append a colon. */
    private static _label(name: string): string {
        const clean = (name || '').replace(/^(First|Last|Count|Sum|Average|Avg|Min|Max|Median|Variance|Standard deviation)( of)?\s+/i, '').trim();
        return (clean || name || '') + ':';
    }

    public static pieTooltip(rows: number[], type: 'in' | 'out', ctx: Ctx): VisualTooltipDataItem[] {
        const src = helper._name(ctx, 'OName', 'Origin');
        const tar = helper._name(ctx, 'DName', 'Dest');
        const [header, name] = type === 'out' ? [src(rows[0]), tar] : [tar(rows[0]), src];
        // Header = this location; then how many flights depart from / arrive at it.
        const count = tooltip.item(helper._count(ctx, rows), type === 'out' ? 'Departures:' : 'Arrivals:', header);
        if (!ctx.cat('Tooltip')) {
            return [count];
        }
        const items = helper._items(ctx), names = ctx.columns('Tooltip').map(c => helper._label(c.source.displayName));
        if (rows.length === 1) {
            return [count].concat(items(rows[0]).map((v, i) => tooltip.item(v, names[i], header)));
        }
        else {
            return [count].concat(helper._tips(ctx, rows, name, header, items));
        }
    }

    public static description(role: Role, ctx: Ctx): Read<string> {
        if (!ctx.roles.exist(role)) {
            return null;
        }
        const items = helper._items(ctx, role);
        return r => items(r).join(', ');
    }

    private static _top(ctx: Ctx, rows: number[]) {
        const { sort, top } = ctx.meta.valueFormat, w = app.$state.config.weight.conv;
        if (w) {
            // Copy first: `rows` is a live model array (pie.rows / path.leafs), and Array.sort
            // mutates in place — sorting it here would reorder the model as a hover side-effect.
            rows = sort === 'des' ? rows.slice().sort((a, b) => w(b) - w(a)) : rows.slice().sort((a, b) => w(a) - w(b));
        }
        return +top >= rows.length ? rows : rows.slice(0, +top);
    }

    private static _uniq(arr: string[]): string[] {
        const seen = {} as StringMap<boolean>, out = [] as string[];
        for (const v of arr) {
            if (!seen[v]) { seen[v] = true; out.push(v); }
        }
        return out;
    }

    public static pathTooltip(ctx: Ctx, rows: number[], type: 'in' | 'out'): VisualTooltipDataItem[] {
        const src = helper._name(ctx, 'OName', 'Origin');
        const tar = helper._name(ctx, 'DName', 'Dest');
        // A bundled "flow" trunk edge fans out to many rows, so name the endpoints by how
        // many distinct origins / destinations they cover — not just the first row's pair.
        const srcs = helper._uniq(rows.map(src)), tars = helper._uniq(rows.map(tar));
        const sPart = srcs.length === 1 ? srcs[0] : srcs.length + ' origins';
        const tPart = tars.length === 1 ? tars[0] : tars.length + ' destinations';
        const header = sPart + ' → ' + tPart;
        const count = tooltip.item(helper._count(ctx, rows), 'Flights:', header);
        if (!ctx.cat('Tooltip')) {
            const result = [count];
            if (type === 'out' && tars.length > 1) {
                result.push(tooltip.item(tars.join(', '), 'To:', header));
            }
            else if (type === 'in' && srcs.length > 1) {
                result.push(tooltip.item(srcs.join(', '), 'From:', header));
            }
            return result;
        }
        const items = helper._items(ctx), names = ctx.columns('Tooltip').map(c => helper._label(c.source.displayName));
        if (rows.length === 1) {
            return [count].concat(items(rows[0]).map((v, i) => tooltip.item(v, names[i], header)));
        }
        else {
            const name = type === 'out' ? tar : src;
            return [count].concat(helper._tips(ctx, rows, name, header, items));
        }
    }
}
export class Visual implements IVisual {
    private _target: HTMLElement;
    private _ctx = null as Ctx;
    private _cfg = null as app.Config;
    private _selectionManager: powerbi.extensibility.ISelectionManager;
    private _selRows: number[] | null = null;
    private _suppressClear = false;
    private _groupLegend: GroupLegend;
    private _tip: CustomTooltip;
    private _selGroups = new Set<string>();
    constructor(options: VisualConstructorOptions) {
        if (!options) {
            return;
        }
        selex(this._target = options.element).sty.cursor('default');
        this._target.style.position = this._target.style.position || 'relative';
        tooltip.init(options);
        this._selectionManager = options.host.createSelectionManager();
        this._groupLegend = new GroupLegend(this._target);
        this._groupLegend.onSelect = (key, e) => this._onLegendClick(key, e);
        this._tip = new CustomTooltip(this._target);
        const ctx = this._ctx = new Context(options.host, new Format());
        ctx.fmt.flow.bind('width', "widthItem", "widthCustomize");
        ctx.fmt.flow.bind("color", "colorItem", 'colorCustomize', 'colorAutofill', k => <Fill>{ solid: { color: ctx.palette(k) } });
        this._buildMapControls();
        app.events.flow.pathInited = group => {
            group.on('mouseover.tip', (arg: any) => this._showTip(helper.pathTooltip(this._ctx, arg.leafs as number[], this._cfg ? this._cfg.direction : ctx.meta.flow.direction)))
                .on('mousemove.tip', () => this._moveTip())
                .on('mouseout.tip', () => this._tip.hide())
                .on('click', (p: any) => this._onMarkClick(p.leafs as number[]));
        };
        app.events.popup.onChanged = addrs => persist.banner.write(addrs, 10);
        app.events.pin.onDrag = (addr, loc) => {
            persist.manual.value({})[addr] = this._cfg.injections[addr] = loc;
        };
        app.events.pie.onPieCreated = group => {
            group.on('mouseover.tip', (arg: any) => { this._showTip(helper.pieTooltip(arg.rows, arg.type, this._ctx)); })
                .on('mousemove.tip', () => this._moveTip())
                .on('mouseout.tip', () => this._tip.hide())
                // The browser does not always generate a 'click' on a bubble — the SVG node can be
                // rebuilt (reshape) between mousedown and mouseup, which cancels the synthetic click.
                // mousedown+mouseup always fire, so detect the click ourselves: same bubble, pointer
                // barely moved between press and release → treat as a click.
                .on('mousedown.sel', (p: any) => {
                    const e = d3event as MouseEvent;
                    this._pieDownAddr = p && p.addr;
                    this._pieDownX = e ? e.clientX : 0;
                    this._pieDownY = e ? e.clientY : 0;
                })
                // Click a hub bubble → select EVERY route touching that location (its
                // departures AND arrivals), not just this bubble's single direction.
                .on('mouseup.sel', (p: any) => {
                    const e = d3event as MouseEvent;
                    const addr = p && p.addr;
                    const wasDown = this._pieDownAddr;
                    this._pieDownAddr = null;
                    if (!addr || addr !== wasDown) { return; }
                    const moved = e ? Math.abs(e.clientX - this._pieDownX) + Math.abs(e.clientY - this._pieDownY) : 0;
                    if (moved > 6) { return; } // a drag that happened to end on this bubble, not a click
                    this._onMarkClick(app.hubRows(addr));
                });
        };
    }

    private _pieDownAddr: string = null;
    private _pieDownX = 0;
    private _pieDownY = 0;

    /** Click on a flow/bubble → cross-filter its rows and dim the rest (Ctrl/Shift = add). */
    private _onMarkClick(rows: number[]): void {
        const e = d3event as MouseEvent;
        if (e && e.stopPropagation) {
            e.stopPropagation();
        }
        // A flow/bubble click is not a group selection — drop any legend group highlight.
        this._selGroups = new Set<string>();
        this._groupLegend && this._groupLegend.refreshSelected(this._selGroups);
        // The paired basemap 'click' fires right after — suppress it so it doesn't clear.
        this._suppressClear = true;
        window.setTimeout(() => { this._suppressClear = false; }, 60);
        const multi = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
        this._selRows = (multi && this._selRows) ? this._selRows.concat(rows) : rows.slice();
        app.highlight(this._selRows);
        this._selectionManager.select(this._rowIds(this._selRows), false);
    }

    /** Fill + show the custom tooltip from a VisualTooltipDataItem list (header + rows). */
    private _showTip(items: VisualTooltipDataItem[]): void {
        if (!items || !items.length) {
            return;
        }
        const header = items[0].header || '';
        const rows = items.map(it => ({
            label: it.displayName || '',
            value: (it.value === null || it.value === undefined) ? '' : it.value + '',
            color: it.color
        }));
        this._tip.show(header, rows);
        this._moveTip();
    }

    private _moveTip(): void {
        const e = d3event as MouseEvent;
        if (e && this._target) {
            this._tip.move(e.clientX, e.clientY, this._target);
        }
    }

    private _clearSelection(): void {
        if (this._suppressClear) {
            return;
        }
        this._selRows = null;
        this._selGroups = new Set<string>();
        this._groupLegend && this._groupLegend.refreshSelected(this._selGroups);
        app.highlight(null);
        this._selectionManager.clear();
    }

    /** Toggle the "flying dashes" flow animation from the Flow lines → Animate flow setting. */
    private _applyAnimate(): void {
        const on = !!this._ctx.config('flow', 'animate');
        this._target && this._target.classList.toggle('flowmap-animated', on);
        // Match the tooltip (and other chrome) to the basemap theme.
        const dark = app.$state.mapctl ? app.$state.mapctl.format.style !== 'light' : true;
        this._target && this._target.classList.toggle('flowmap-dark', dark);
    }

    // -------- on-canvas Group-by / Animate controls --------
    // Two INDEPENDENT controls, each pinned to its own corner, built OUTSIDE the Leaflet container
    // (siblings of the map) so the map cannot swallow their clicks. Each click persists its setting,
    // so it survives a report reload and the format pane stays in sync. Same panel/height/font as
    // the corner legend and the zoom control.
    private _dirCtl: HTMLDivElement = null;
    private _animCtl: HTMLDivElement = null;
    private _dirButtons: { [k in 'out' | 'in']?: HTMLButtonElement } = {};
    private _animBtn: HTMLButtonElement = null;

    private _buildMapControls(): void {
        if (this._dirCtl || !this._target) { return; }

        // Group-by: a two-segment Origin / Destination switch.
        const dir = this._dirCtl = document.createElement('div');
        dir.className = 'flowmap-map-control flowmap-dir-control';
        dir.style.display = 'none'; // hidden until _syncMapControls decides, so it never flashes
        const dirDefs: Array<['out' | 'in', string]> = [['out', 'Origin'], ['in', 'Destination']];
        for (const [val, label] of dirDefs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.onclick = e => {
                e.stopPropagation();
                this._ctx.persist('flow', 'direction', val); // reset rebuilds the trees with the new hub
            };
            this._dirButtons[val] = btn;
            dir.appendChild(btn);
        }
        this._target.appendChild(dir);

        // Animate: a single on/off toggle.
        const anim = this._animCtl = document.createElement('div');
        anim.className = 'flowmap-map-control flowmap-anim-control';
        anim.style.display = 'none';
        const btn = this._animBtn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Animate';
        btn.onclick = e => {
            e.stopPropagation();
            this._ctx.persist('flow', 'animate', !this._ctx.config('flow', 'animate'));
        };
        anim.appendChild(btn);
        this._target.appendChild(anim);
    }

    private static _CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
    /** Pin a control to a corner via inline styles (top/bottom + left/right). `off` is the distance
     *  from the horizontal edge — computed so the control clears whatever already sits there. */
    private _placeInline(el: HTMLElement, top: boolean, left: boolean, off: number): void {
        el.style.top = top ? '10px' : '';
        el.style.bottom = top ? '' : '28px';
        el.style.left = left ? off + 'px' : '';
        el.style.right = left ? '' : off + 'px';
    }

    /** Sync each on-canvas control's visibility, corner and active state. Controls that land on the
     *  same corner as the legend (or as each other) are pushed SIDEWAYS so nothing overlaps. */
    private _syncMapControls(): void {
        if (!this._dirCtl) { return; }
        const ctx = this._ctx;
        const dark = app.$state.mapctl ? app.$state.mapctl.format.style !== 'light' : true;
        const dirShown = !!ctx.config('flow', 'directionControl');
        const animShown = !!ctx.config('flow', 'animateControl');
        this._dirCtl.style.display = dirShown ? '' : 'none';
        this._animCtl.style.display = animShown ? '' : 'none';
        this._dirCtl.classList.toggle('flowmap-control-dark', dark);
        this._animCtl.classList.toggle('flowmap-control-dark', dark);

        if (dirShown || animShown) {
            const dirPos = (ctx.config('flow', 'directionControlPosition') as string) || 'bottomLeft';
            const animPos = (ctx.config('flow', 'animateControlPosition') as string) || 'bottomRight';
            // Is the corner legend currently on screen, and where + how wide? A shown control at its
            // corner starts just past it.
            const legendEl = this._target.querySelector('.flowmap-legend') as HTMLElement;
            const legendVisible = !!legendEl && legendEl.offsetParent !== null;
            const legendPos = legendVisible ? ((ctx.config('groupLegend', 'position') as string) || 'topLeft') : null;
            const legendW = legendVisible ? legendEl.offsetWidth : 0;
            const dirW = dirShown ? this._dirCtl.offsetWidth : 0;   // offsetWidth needs display != none (set above)
            const animW = animShown ? this._animCtl.offsetWidth : 0;
            const GAP = 8;
            for (const corner of Visual._CORNERS) {
                const left = corner === 'topLeft' || corner === 'bottomLeft';
                const top = corner === 'topLeft' || corner === 'topRight';
                // topLeft base clears the zoom control; the legend always sits at 44 (left) / 12 (right).
                let cursor = left ? (corner === 'topLeft' ? 44 : 12) : 12;
                if (legendPos === corner) { cursor = (left ? 44 : 12) + legendW + GAP; }
                if (dirShown && dirPos === corner) { this._placeInline(this._dirCtl, top, left, cursor); cursor += dirW + GAP; }
                if (animShown && animPos === corner) { this._placeInline(this._animCtl, top, left, cursor); cursor += animW + GAP; }
            }
        }

        const dir = this._cfg ? this._cfg.direction : ctx.config('flow', 'direction');
        this._dirButtons.out && this._dirButtons.out.classList.toggle('active', dir === 'out');
        this._dirButtons.in && this._dirButtons.in.classList.toggle('active', dir === 'in');
        this._animBtn && this._animBtn.classList.toggle('active', !!ctx.config('flow', 'animate'));
    }

    /** Rebuild the corner group legend from the current secondary (Color) grouping. */
    private _updateLegend(): void {
        if (!this._groupLegend) {
            return;
        }
        this._applyAnimate();
        const ctx = this._ctx;
        const opts = {
            show: ctx.config('groupLegend', 'show'),
            position: ctx.config('groupLegend', 'position') as any,
            orientation: ctx.config('groupLegend', 'orientation') as any,
            expanded: ctx.config('groupLegend', 'expanded'),
            width: +ctx.config('groupLegend', 'width'),
            fontSize: +ctx.config('groupLegend', 'fontSize'),
            title: ctx.config('groupLegend', 'title')
        };
        const cat = ctx.cat('color');
        if (!cat || ctx.type('color').numeric || !ctx.meta.flow.colorCustomize) {
            this._groupLegend.update([], opts, new Set<string>());
        }
        else {
            const colorFn = ctx.fmt.flow.item('colorItem');
            const rows = cat.distincts();
            const labels = cat.row2label(rows);
            const groups = rows.map(r => ({ key: cat.key(r), color: colorFn(r) + '', label: (labels[r] || '') + '' }));
            this._groupLegend.update(groups, opts, this._selGroups);
        }
        // After the legend set its own display/position — so controls can dodge it sideways.
        this._syncMapControls();
    }

    /** Click a legend row → cross-filter that group (plain / Ctrl toggle / re-click clears). */
    private _onLegendClick(key: string, e: MouseEvent): void {
        // Legend rows stopPropagation and live outside the Leaflet container, so no
        // basemap 'click' follows — do NOT set _suppressClear here (it would neuter the
        // plain re-click-to-clear path, which routes through _clearSelection).
        const ctx = this._ctx, cat = ctx.cat('color');
        if (!cat) {
            return;
        }
        const multi = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));
        if (multi) {
            this._selGroups.has(key) ? this._selGroups.delete(key) : this._selGroups.add(key);
        }
        else {
            if (this._selGroups.size === 1 && this._selGroups.has(key)) {
                this._clearSelection();
                return;
            }
            this._selGroups = new Set<string>([key]);
        }
        const groups = this._selGroups;
        const rows = ctx.rows().filter(r => groups.has(cat.key(r)));
        this._selRows = rows;
        app.highlight(rows);
        // Cross-filter by the COLOR group itself — one selection id per legend group — not by
        // every (Origin,Dest) pair in it. A big group holds thousands of pairs; passing thousands
        // of ids to selectionManager.select made the Power BI host (not just the map) hang while it
        // serialized and applied them. One id per group filters the same rows near-instantly.
        this._selectionManager.select(this._groupSelectionIds(groups, cat), false);
        this._groupLegend.refreshSelected(groups);
    }

    /** One selection id per selected legend group, built from the Color category — so clicking a
     *  legend row cross-filters by that colour value with a single id per group instead of one per
     *  route. Picks the first row of each group as the representative. */
    private _groupSelectionIds(groups: Set<string>, cat: { column: any, key: (r: number) => string }): powerbi.visuals.ISelectionId[] {
        const ctx = this._ctx;
        if (!cat || !cat.column) { return []; }
        const ids = [] as powerbi.visuals.ISelectionId[];
        const seen = {} as StringMap<boolean>;
        for (const r of ctx.rows()) {
            const k = cat.key(r);
            if (!groups.has(k) || seen[k]) { continue; }
            seen[k] = true;
            ids.push(ctx.host.createSelectionIdBuilder().withCategory(cat.column, r).createSelectionId());
        }
        return ids;
    }

    /** Composite (Origin, Dest) selection id for a row — filters that exact O→D pair. */
    private _rowId(row: number): powerbi.visuals.ISelectionId {
        const ctx = this._ctx;
        let b = ctx.host.createSelectionIdBuilder();
        const o = ctx.cat('Origin'), d = ctx.cat('Dest');
        if (o && o.column) { b = b.withCategory(o.column as any, row); }
        if (d && d.column) { b = b.withCategory(d.column as any, row); }
        return b.createSelectionId();
    }

    /** (Origin,Dest) -> selection id, cached. Clicking a thick trunk means hundreds of distinct
     *  pairs, and rebuilding a selection id for each one on every click is what made selecting
     *  stutter. The Origin/Dest column object is the cache token: Power BI hands over fresh
     *  columns with each new dataView, so the cache self-invalidates and never returns a stale id. */
    private _idCache = {} as StringMap<powerbi.visuals.ISelectionId>;
    private _idCacheToken: any = null;
    private _idCacheTokenD: any = null;

    private _rowIds(rows: number[]): powerbi.visuals.ISelectionId[] {
        const ctx = this._ctx;
        const oCat = ctx.cat('Origin'), dCat = ctx.cat('Dest');
        // Invalidate if EITHER column object changed — keying only on Origin would keep stale ids
        // built against an old Dest column if Power BI swapped just that one.
        const oTok = (oCat && oCat.column) || null, dTok = (dCat && dCat.column) || null;
        if (this._idCacheToken !== oTok || this._idCacheTokenD !== dTok) {
            this._idCache = {};
            this._idCacheToken = oTok;
            this._idCacheTokenD = dTok;
        }
        const ok = oCat ? oCat.key : (_: number) => '';
        const dk = dCat ? dCat.key : (_: number) => '';
        const seen = {} as StringMap<boolean>;
        const ids = [] as powerbi.visuals.ISelectionId[];
        for (const r of rows) {
            const k = ok(r) + '' + dk(r);
            if (seen[k]) { continue; }
            seen[k] = true;
            let id = this._idCache[k];
            if (!id) { id = this._idCache[k] = this._rowId(r); }
            ids.push(id);
        }
        return ids;
    }

    /** Build the Leaflet/MapLibre basemap format from the "map" settings object,
     * unwrapping colour fills and (optionally) picking Dark/Light from the report theme. */
    private _mapFormat(): MapFormat {
        const ctx = this._ctx, m = new MapFormat();
        m.style = ctx.config('map', 'style') as MapStyle;
        m.followTheme = ctx.config('map', 'followTheme');
        m.autoFit = ctx.config('map', 'autoFit');
        m.pan = ctx.config('map', 'pan');
        m.zoom = ctx.config('map', 'zoom');
        m.landDark = ctx.config('map', 'landDark');
        m.waterDark = ctx.config('map', 'waterDark');
        m.landLight = ctx.config('map', 'landLight');
        m.waterLight = ctx.config('map', 'waterLight');
        m.labelOpacity = ctx.config('map', 'labelOpacity');
        if (m.followTheme) {
            const palette = ctx.host.colorPalette as any;
            const hex = palette && palette.background && palette.background.value;
            if (hex) {
                m.style = this._isDark(hex) ? 'dark' : 'light';
            }
        }
        return m;
    }

    private _isDark(hex: string): boolean {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
        if (!m) { return true; }
        const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }

    private _config(): app.Config {
        const config = new app.Config(), ctx = this._ctx;
        // The top/bottom colour+width legend bar was removed; the Legend class now only renders
        // error/issue text. Force its colour/width bars off and keep it anchored to the top.
        config.legend.color = false;
        config.legend.width = false;
        config.legend.position = 'top';
        config.legend.colorLabels = {};
        config.legend.widthLabels = {};

        /* #region  numberSorter, numberFormat */
        override(ctx.meta.valueFormat, config.numberSorter);
        override(ctx.meta.valueFormat, config.numberFormat);
        /* #endregion */

        if (!ctx.cat('Origin')) {
            config.error = '"Origin" field is required.';
        }
        else if (!ctx.cat('Dest')) {
            config.error = '"Destination" field is required.'
        }

        /* #region  source, target */
        config.source = ctx.key('Origin');
        config.target = ctx.key('Dest');
        config.popup = {
            description: null,
            origin: ctx.cat('OName') ? ctx.key('OName') : config.source,
            destination: ctx.cat('DName') ? ctx.key('DName') : config.target
        };

        let sourceRole = 'Origin' as Role;
        let groups = null as number[][];

        /* #region grouping direction + limit (from settings) */
        const direction = ctx.meta.flow.direction;
        config.direction = direction;
        const limit = +ctx.meta.flow.limit;
        // "Filter by" field: restrict the map to the routes it marks, BEFORE grouping — a measure
        // that returns BLANK for unwanted pairs drops them; a plain column (e.g. City Pairs) has a
        // value on every row it survives with, so it simply carries the report's filter context.
        let baseRows = ctx.rows();
        const fCat = ctx.cat('FilterBy');
        if (fCat && fCat.column) {
            const fv = fCat.data;
            baseRows = baseRows.filter(r => {
                const v = fv[r];
                return v !== null && v !== undefined && v !== '' && v !== false;
            });
        }
        /* #endregion */

        //swith source/target
        if (direction === 'in') {
            [config.source, config.target] = [config.target, config.source];
            sourceRole = 'Dest';
        }
        /* #endregion */

        /* #region  color */
        if (!ctx.cat('color') || !ctx.meta.flow.colorCustomize) {
            const color = ctx.config('flow', 'colorItem');
            config.color = _ => color;
        }
        else if (ctx.type('color').numeric) {
            const values = ctx.nums('color');
            config.color = r => values[r];
            config.color.min = ctx.config('flow', 'colorMin');
            config.color.max = ctx.config('flow', 'colorMax');
        }
        else {
            config.color = ctx.fmt.flow.item('colorItem');
        }
        /* #endregion */

        /* #region  update style */
        config.style = ctx.meta.flow.style;
        const bySource = !!ctx.meta.flow.bundleBySource;
        config.bundleBySource = bySource;
        // Bundle strength 0..100 (higher = more merging). In this spiral tree a SMALLER
        // spiral angle lets more branches join (see algo._tryJoin), so strength maps inversely
        // to the angle: 0 → ~28° (loose/radial), 100 → ~6° (tight shared trunks).
        const bsRaw = +ctx.meta.flow.bundleStrength;
        const bs = isFinite(bsRaw) ? Math.max(0, Math.min(100, bsRaw)) : 50;
        // Bundle strength → spiral angle. HIGHER strength = LARGER angle = the joint where two
        // branches meet sits further out (near the leaves), so nearby routes share ONE trunk
        // almost all the way and only split near their destinations (they "merge into one").
        // Lower = joints near the hub = they split early. Default 50 → 18° (Math.PI/10), the
        // original flowmap's tuned angle. Range 10°..26°.
        setBundleAlpha((10 + 0.16 * bs) * Math.PI / 180);
        // Corridors (edge-bundling): strength -> how far a route bends into a shared corridor
        // (maxOffsetFrac) + iterations; cone -> directional tolerance; radius (% of the view) ->
        // how near two routes must pass to be allowed to merge.
        config.bundle.iterations = Math.round(60 + bs * 0.6);      // 60..120
        config.bundle.maxOffsetFrac = 0.22 + bs * 0.0016;          // 0.22..0.38
        const coneRaw = +ctx.meta.flow.bundleCone;
        config.bundle.cone = (isFinite(coneRaw) ? Math.max(10, Math.min(90, coneRaw)) : 40) * Math.PI / 180;
        const proxRaw = +ctx.meta.flow.bundleRadius;
        const proxPct = isFinite(proxRaw) ? Math.max(2, Math.min(30, proxRaw)) : 7;
        config.bundle.proximity = proxPct * 10;                    // % of the 1000-unit box
        config.bundle.pointRadius = proxPct * 9;
        config.bundle.splitColor = !!ctx.meta.flow.bundleSplitColor;
        if (config.style === null) {
            if (config.color.max) {
                config.style = baseRows.length < 512 ? 'arc' : 'straight';
            }
            else {
                groups = values(groupBy(baseRows, (bySource ? ctx.key(sourceRole) : ctx.key(sourceRole, 'color'))));
                if (keys(groups).length <= limit) {
                    config.style = 'flow';
                }
                else {
                    config.style = baseRows.length < 512 ? 'arc' : 'straight';
                }
            }
        }
        else if (config.style === 'flow') {
            if (config.color.max) {
                config.style = baseRows.length < 512 ? 'arc' : 'straight';
            }
        }
        /* #endregion */

        /* #region  width */
        if (!ctx.cat('width') || ctx.type('width').numeric) {
            const { widthMax: max, widthMin: min, widthItem: item, widthUnit: unit, widthScale: scale } = ctx.meta.flow;
            if (config.style !== 'flow' && !ctx.cat('width')) {
                config.weight = { conv: _ => item, scale: null };
            }
            else {
                const values = ctx.nums('width'), conv: Read<number> = (values ? r => values[r] : _ => 1);
                config.weight = scale === 'none' ? { conv, unit, scale: 'none' } : { conv, scale, max, min };
            }
        }
        else {
            //has width column and is discrete
            if (ctx.meta.flow.widthCustomize) {
                config.weight = { conv: ctx.fmt.flow.item('widthItem'), scale: null };
            }
            else {
                const width = ctx.meta.flow.widthItem;
                config.weight = { conv: _ => width, scale: null };
            }
        }
        /* #endregion */

        /* #region  update bubble.for if null */
        copy(ctx.meta.bubble, config.bubble);
        if (config.bubble.for === null) {
            // Show a bubble at BOTH ends by default, so every route endpoint has a dot.
            config.bubble.for = 'both';
        }
        if (config.bubble.for === 'origin' || config.bubble.for === 'both') {
            config.bubble.out = ctx.key('Origin');
        }
        if (config.bubble.for === 'dest' || config.bubble.for === 'both') {
            config.bubble.in = ctx.key('Dest');
        }
        /* #endregion */

        /* #region  collect groups and valid rows */
        let rows = baseRows;
        if (config.style === 'bundle') {
            // Corridors: one global edge set (or one per colour when "keep colours apart").
            // Cap the edge count so the O(E^2) bundling stays responsive.
            const BUNDLE_CAP = 450;
            let brows = baseRows.slice();
            if (brows.length > BUNDLE_CAP) {
                brows = sort(brows, r => -config.weight.conv(r)).slice(0, BUNDLE_CAP);
            }
            rows = brows;
            if (config.bundle.splitColor && ctx.cat('color')) {
                groups = values(groupBy(brows, ctx.key('color')));
            }
            else {
                groups = [brows];
            }
        }
        else if (config.style === 'flow') {
            if (!groups) {
                groups = values(groupBy(baseRows, (bySource ? ctx.key(sourceRole) : ctx.key(sourceRole, 'color'))));
            }
            const weights = groups.map(g => sum(g, i => config.weight.conv(i)));
            // Heaviest first, so the Limit keeps the BUSIEST hubs (the original sorted ascending
            // and kept the lightest — which hides the dominant hub on multi-origin data).
            groups = sort(groups, (_, i) => -weights[i]);
            if (limit < groups.length) {
                groups = groups.slice(0, limit);
                rows = [].concat(...groups);
            }
        }
        else {
            groups = values(groupBy(baseRows, ctx.key(sourceRole)));
        }
        /* #endregion */

        /* #region  update bubble.slice if null */
        if (config.bubble.slice === null) {
            let mark = {}, cnt = 0;
            for (const r of rows) {
                const color = config.color(r);
                if (!(color in mark)) {
                    mark[color] = true;
                    if (cnt++ > 32) {
                        config.bubble.slice = false;
                        break;
                    }
                }
            }
            if (config.bubble.slice !== false) {
                config.bubble.slice = true;
            }
        }
        /* #endregion */


        config.map = this._mapFormat();

        // Keyless: locations come only from coordinate columns and manual relocate.
        config.injections = coords(ctx, 'Origin', 'OLati', 'OLong', coords(ctx, 'Dest', 'DLati', 'DLong', {}));
        copy(persist.manual.value({}), config.injections);

        config.advance.relocate = ctx.meta.map.relocate;
        config.advance.located = ctx.meta.map.located;
        config.advance.unlocated = ctx.meta.map.unlocated;
        config.groups = groups;
        return config;
    }

    private _inited = false;
    private _initing = false;

    public update(options: VisualUpdateOptions) {
        const view = options.dataViews && options.dataViews[0] || {} as powerbi.DataView;
        if (Persist.update(view)) {
            return;
        }
        if (this._initing) {
            return;
        }
        // A dataView without metadata/categorical (Power BI can send one during teardown or an
        // error state) would make Context.update dereference missing fields and throw, killing
        // the whole render. Nothing to draw — skip this cycle.
        if (!view.metadata || !view.categorical) {
            return;
        }
        const ctx = this._ctx.update(view);
        const reset = (config: app.Config) => app.reset(config, () => ctx.meta.map.autoFit && app.tryFitView());
        if (!this._inited) {
            this._initing = true;
            const mapFmt = this._mapFormat();
            app.init(this._target, mapFmt, persist.banner.value() || [], ctl => {
                ctl.onStyleChanged = style => {
                    this._ctx.persist('map', 'style', style);
                    this._target.classList.toggle('flowmap-dark', style !== 'light');
                };
                ctl.onBackgroundClick(() => this._clearSelection());
                const [center, zoom] = persist.map.value() || [null, null];
                center && ctl.setCenterZoom(center, zoom);
                ctl.add({ transform: (c, p, e) => e && persist.map.write([c.map.getCenter(), c.map.getZoom()], 400) });
                this._initing = false;
                if (center) {
                    app.reset(this._cfg = this._config());
                }
                else {
                    reset(this._cfg = this._config());
                }
                this._updateLegend();
            });
            this._inited = true;
            this._dataChanged(view); // prime the baseline so the first selection echo is a no-op
        }
        else {
            if (ctx.isResizeVisualUpdateType(options)) {
                return;
            }
            const config = this._cfg = this._config(), fmt = ctx.fmt;
            // Refresh the data fingerprint every update (not only in the else branch) so that after
            // a format-driven reset the next selection echo still compares equal and is skipped.
            const dataChanged = this._dataChanged(view);
            // followTheme: a runtime report-theme change does NOT mark the "map" object
            // dirty (the theme comes from host.colorPalette, not metadata.objects.map), so
            // push the freshly theme-derived basemap style whenever it actually changed.
            if (ctx.meta.map.followTheme && app.$state.mapctl && app.$state.mapctl.format.style !== config.map.style) {
                app.repaint(config, 'map');
            }
            if (ctx.dirty()) {
                // Flow lines: anything that changes the spider geometry (type, grouping,
                // limit, bundle mode/strength) needs a full reset to rebuild the trees;
                // colour/width only repaint the existing flows.
                if (fmt.flow.dirty(['style', 'direction', 'limit', 'bundleBySource', 'bundleStrength', 'bundleCone', 'bundleRadius', 'bundleSplitColor'])) {
                    reset(config);
                }
                else if (fmt.flow.dirty()) {
                    app.repaint(config, 'flow');
                }
                // Map card also holds Relocate/Known/Unknown (the former Advanced object).
                if (fmt.map.dirty(['relocate', 'located', 'unlocated'])) {
                    if (fmt.map.dirty('relocate') === 'off') {
                        persist.manual.write(persist.manual.value() || {}, 10);
                    }
                    reset(config);
                }
                if (fmt.bubble.dirty()) {
                    app.repaint(config, 'bubble');
                }
                if (fmt.valueFormat.dirty()) {
                    app.repaint(config, 'banner');
                }
                // groupLegend changes are picked up by the unconditional _updateLegend() below.
                if (fmt.map.dirty(['style', 'followTheme', 'pan', 'zoom', 'landDark', 'waterDark', 'landLight', 'waterLight', 'labelOpacity', 'autoFit'])) {
                    if (fmt.map.dirty(['style', 'followTheme', 'pan', 'zoom', 'landDark', 'waterDark', 'landLight', 'waterLight', 'labelOpacity'])) {
                        app.repaint(config, 'map');
                    }
                    fmt.map.dirty('autoFit') === 'on' && app.tryFitView();
                }
            }
            else if (this._dataChanged(view)) {
                // No format object is dirty and the underlying data actually changed (a slicer or
                // page filter added/removed rows) — rebuild the trees for the new data.
                reset(config);
            }
            else {
                // Data and format are both unchanged, so this update is only the echo of a
                // selection/cross-filter (our own or another visual's) or a cosmetic re-run.
                // Rebuilding every spiral tree here was pure waste and, for a big legend-group
                // selection, took long enough to look like a hang. Keep the current render and
                // just re-assert our local highlight so it survives the echo.
                this._selRows && app.highlight(this._selRows);
            }
            this._updateLegend();
        }
    }

    /** Cheap structural+content fingerprint of the dataView, to tell a real data change (rows
     *  added/removed by a slicer) apart from a selection/highlight echo that carries identical
     *  data. Samples a few values per column so it is O(columns), not O(rows). */
    private _dataSig: string = null;
    private _dataChanged(view: powerbi.DataView): boolean {
        const cat = view && view.categorical;
        let sig = '';
        if (cat) {
            const cols = ([] as any[]).concat(cat.categories || [], cat.values || []);
            const n = (cat.categories && cat.categories[0] && cat.categories[0].values.length) || 0;
            sig = n + '|';
            for (const c of cols) {
                const vals = c.values || [];
                const qn = (c.source && c.source.queryName) || '';
                sig += qn + ':' + vals.length + ':' + vals[0] + ',' + vals[vals.length >> 1] + ',' + vals[vals.length - 1] + ';';
            }
        }
        const changed = sig !== this._dataSig;
        this._dataSig = sig;
        return changed;
    }

    public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): VisualObjectInstance[] {
        const oname = options.objectName as keyof Format, ctx = this._ctx, fmt = ctx.fmt, cfg = this._cfg;
        // Relocate mode collapses the pane to just the point-placement controls (Map card).
        if (ctx.meta.map.relocate) {
            if (oname !== 'map') {
                return null;
            }
            return fmt.map.dumper().metas(['relocate', 'located', 'unlocated']).result;
        }
        switch (oname) {
            case 'map':
                return fmt.map.dumper()
                    .metas(['style', 'followTheme', 'autoFit', 'pan', 'zoom', 'landDark', 'waterDark', 'landLight', 'waterLight', 'labelOpacity', 'relocate'])
                    .result;
            case 'flow': {
                const d = fmt.flow.dumper();
                // style / grouping. directionControl toggles the on-canvas Origin/Destination switch;
                // its position dropdown appears only once the switch is turned on.
                const groupingStyle = cfg.style === 'flow' || cfg.style === 'bundle';
                d.metas(['style'], cfg as any) // cfg.style may be the internal 'straight' fallback
                    .metas(cfg.style === 'flow', ['direction', 'directionControl', 'limit', 'bundleBySource', 'bundleStrength'])
                    .metas(cfg.style === 'bundle', ['direction', 'directionControl', 'bundleStrength', 'bundleCone', 'bundleRadius', 'bundleSplitColor']);
                d.metas(groupingStyle && !!ctx.meta.flow.directionControl, ['directionControlPosition']);
                d.metas(['animate', 'animateControl']);
                d.metas(!!ctx.meta.flow.animateControl, ['animateControlPosition']);
                // color
                d.metas(['colorItem']);
                if (ctx.cat('color')) {
                    if (ctx.type('color').numeric) {
                        d.metas('colorCustomize', ['colorMin', 'colorMax']);
                    }
                    else {
                        d.items('colorItem');
                    }
                }
                // width
                const w = cfg.weight as any;
                const wpref = { widthScale: w.scale, widthUnit: w.unit, widthMin: w.min, widthMax: w.max };
                if (cfg.weight.scale === null) {
                    // Distinct/default width: one "Line width" box + per-item rows (items()
                    // no-ops when there is no Width field). Covers the no-field case too.
                    d.metas(['widthItem']).items('widthItem');
                }
                else if (cfg.weight.scale === 'none') {
                    d.metas(['widthScale', 'widthUnit'], wpref);
                }
                else {
                    d.metas(['widthScale', 'widthMin', 'widthMax'], wpref);
                }
                return d.result;
            }
            case 'valueFormat':
                return fmt.valueFormat.dumper().metas(['sort', 'top'])
                    .add(numberObjects(ctx.meta.valueFormat, oname))
                    .result;
            case 'bubble':
                const bubble = fmt.bubble.dumper().metas(['for'], cfg.bubble);
                if (ctx.meta.bubble.for !== 'none') {
                    bubble.metas(['scaleOut', 'scaleIn', 'slice'], cfg.bubble);
                    if (!cfg.bubble.slice) {
                        bubble.metas(['bubbleColor']);
                    }
                    bubble.metas(['label']);
                    if (ctx.meta.bubble.label !== 'hide' && ctx.meta.bubble.label !== 'none') {
                        const both = ctx.meta.bubble.for === 'both';
                        bubble.metas(['labelOpacity'])
                            // Emit labelColor ONCE — the old two-line form added it twice when
                            // for==='both', producing a duplicate row in the format pane.
                            .metas(both || cfg.bubble.for === 'dest' || cfg.bubble.for === 'origin', ['labelColor'])
                    }
                }
                return bubble.result;
            default:
                // Any object not handled above (e.g. the hidden "persist" storage object).
                const mgr = (fmt as any)[oname];
                return mgr ? mgr.dumper().default : null;
        }
    }
}