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

type Role = 'Origin' | 'Dest' | 'width' | 'color' | 'OLati' | 'OLong' | 'DLati' | 'DLong' | 'OName' | 'DName' | 'Tooltip' | 'Label';
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

    public static pieTooltip(rows: number[], type: 'in' | 'out', ctx: Ctx): VisualTooltipDataItem[] {
        const src = ctx.cat('OName') ? ctx.key('OName') : ctx.key('Origin');
        const tar = ctx.cat('DName') ? ctx.key('DName') : ctx.key('Dest');
        const [header, name] = type === 'out' ? [src(rows[0]), tar] : [tar(rows[0]), src];
        // Header = this location; then how many flights depart from / arrive at it.
        const count = tooltip.item(helper._count(ctx, rows), type === 'out' ? 'Departures' : 'Arrivals', header);
        if (!ctx.cat('Tooltip')) {
            return [count];
        }
        const items = helper._items(ctx), names = ctx.columns('Tooltip').map(c => c.source.displayName);
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
            rows = sort === 'des' ? rows.sort((a, b) => w(b) - w(a)) : rows.sort((a, b) => w(a) - w(b));
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
        const src = ctx.cat('OName') ? ctx.key('OName') : ctx.key('Origin');
        const tar = ctx.cat('DName') ? ctx.key('DName') : ctx.key('Dest');
        // A bundled "flow" trunk edge fans out to many rows, so name the endpoints by how
        // many distinct origins / destinations they cover — not just the first row's pair.
        const srcs = helper._uniq(rows.map(src)), tars = helper._uniq(rows.map(tar));
        const sPart = srcs.length === 1 ? srcs[0] : srcs.length + ' origins';
        const tPart = tars.length === 1 ? tars[0] : tars.length + ' destinations';
        const header = sPart + ' → ' + tPart;
        const count = tooltip.item(helper._count(ctx, rows), 'Flights', header);
        if (!ctx.cat('Tooltip')) {
            const result = [count];
            if (type === 'out' && tars.length > 1) {
                result.push(tooltip.item(tars.join(', '), 'To', header));
            }
            else if (type === 'in' && srcs.length > 1) {
                result.push(tooltip.item(srcs.join(', '), 'From', header));
            }
            return result;
        }
        const items = helper._items(ctx), names = ctx.columns('Tooltip').map(c => c.source.displayName);
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
        const ctx = this._ctx = new Context(options.host, new Format());
        ctx.fmt.flow.bind('width', "widthItem", "widthCustomize");
        ctx.fmt.flow.bind("color", "colorItem", 'colorCustomize', 'colorAutofill', k => <Fill>{ solid: { color: ctx.palette(k) } });
        ctx.fmt.legend.bind('width', 'width_label', 'width', 'width_default', '');
        ctx.fmt.legend.bind('color', 'color_label', 'color', 'color_default', '');
        app.events.flow.pathInited = group => {
            tooltip.add(group, arg => helper.pathTooltip(this._ctx, arg.data.leafs as number[], ctx.meta.flow.direction));
            group.on('click', (p: any) => this._onMarkClick(p.leafs as number[]));
        };
        app.events.popup.onChanged = addrs => persist.banner.write(addrs, 10);
        app.events.pin.onDrag = (addr, loc) => {
            persist.manual.value({})[addr] = this._cfg.injections[addr] = loc;
        };
        app.events.pie.onPieCreated = group => {
            tooltip.add(group, arg => helper.pieTooltip(arg.data.rows, arg.data.type, this._ctx));
            group.on('click', (p: any) => this._onMarkClick(p.rows as number[]));
        };
    }

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
            return;
        }
        const colorFn = ctx.fmt.flow.item('colorItem');
        const rows = cat.distincts();
        const labels = cat.row2label(rows);
        const groups = rows.map(r => ({ key: cat.key(r), color: colorFn(r) + '', label: (labels[r] || '') + '' }));
        this._groupLegend.update(groups, opts, this._selGroups);
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
        this._selectionManager.select(this._rowIds(rows), false);
        this._groupLegend.refreshSelected(groups);
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

    private _rowIds(rows: number[]): powerbi.visuals.ISelectionId[] {
        const ctx = this._ctx;
        const ok = ctx.cat('Origin') ? ctx.cat('Origin').key : (_: number) => '';
        const dk = ctx.cat('Dest') ? ctx.cat('Dest').key : (_: number) => '';
        const seen = {} as StringMap<boolean>;
        const ids = [] as powerbi.visuals.ISelectionId[];
        for (const r of rows) {
            const k = ok(r) + '' + dk(r);
            if (seen[k]) { continue; }
            seen[k] = true;
            ids.push(this._rowId(r));
        }
        return ids;
    }

    private _buildLegendLabels(role: 'color' | 'width'): StringMap<string> {
        const ctx = this._ctx, legend = ctx.fmt.legend;
        const autofill = role === 'color' ? 'color_default' : 'width_default';
        const label = role === 'color' ? 'color_label' : 'width_label';
        const itemProp = role === 'color' ? 'colorItem' : 'widthItem';
        const custProp = role === 'color' ? 'colorCustomize' : 'widthCustomize';
        if (!legend.config(role)) {
            return {};//hide
        }
        const cat = ctx.cat(role);
        if (!cat || !ctx.meta.flow[custProp]) {
            const txt = (legend.config(label) || '').trim();
            return txt ? { [ctx.config('flow', itemProp)]: txt } : {};
        }
        else if (cat.type.numeric) {
            return null;//smooth
        }
        else {
            //has cat && distinct
            const labels = ctx.labels(ctx.binding('flow', itemProp), legend.special(label));
            if (legend.config(autofill)) {
                return dict(labels, r => r.key, r => r.value || r.name);
            }
            else {
                return dict(labels.filter(a => a.value), r => r.key, r => r.value);
            }
        }
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
        /* #region  legend */
        override(ctx.meta.legend, config.legend);
        config.legend.colorLabels = this._buildLegendLabels('color');
        config.legend.widthLabels = this._buildLegendLabels('width');
        /* #endregion */

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

        /* #region  source, target, label */
        config.source = ctx.key('Origin');
        config.target = ctx.key('Dest');
        config.popup = {
            description: helper.description('Label', ctx),
            origin: ctx.cat('OName') ? ctx.key('OName') : config.source,
            destination: ctx.cat('DName') ? ctx.key('DName') : config.target
        };

        let sourceRole = 'Origin' as Role;
        let groups = null as number[][];

        //swith source/target
        if (ctx.meta.flow.direction === 'in') {
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
        if (config.style === null) {
            if (config.color.max) {
                config.style = ctx.rows().length < 512 ? 'arc' : 'straight';
            }
            else {
                groups = values(groupBy(ctx.rows(), ctx.key(sourceRole, 'color')));
                if (keys(groups).length <= ctx.meta.flow.limit) {
                    config.style = 'flow';
                }
                else {
                    config.style = ctx.rows().length < 512 ? 'arc' : 'straight';
                }
            }
        }
        else if (config.style === 'flow') {
            if (config.color.max) {
                config.style = ctx.rows().length < 512 ? 'arc' : 'straight';
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
            config.bubble.for = ctx.meta.flow.direction !== 'in' ? 'dest' : 'origin';
        }
        if (config.bubble.for === 'origin' || config.bubble.for === 'both') {
            config.bubble.out = ctx.key('Origin');
        }
        if (config.bubble.for === 'dest' || config.bubble.for === 'both') {
            config.bubble.in = ctx.key('Dest');
        }
        /* #endregion */

        /* #region  collect groups and valid rows */
        let rows = ctx.rows();
        if (config.style === 'flow') {
            if (!groups) {
                groups = values(groupBy(ctx.rows(), ctx.key(sourceRole, 'color')));
            }
            const weights = groups.map(g => sum(g, i => config.weight.conv(i)));
            groups = sort(groups, (_, i) => weights[i]);
            if (ctx.meta.flow.limit < groups.length) {
                groups = groups.slice(0, ctx.meta.flow.limit);
                rows = [].concat(...groups);
            }
        }
        else {
            groups = values(groupBy(ctx.rows(), ctx.key(sourceRole)));
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
        const ctx = this._ctx.update(view);
        const reset = (config: app.Config) => app.reset(config, () => ctx.meta.map.autoFit && app.tryFitView());
        if (!this._inited) {
            this._initing = true;
            const mapFmt = this._mapFormat();
            app.init(this._target, mapFmt, persist.banner.value() || [], ctl => {
                ctl.onStyleChanged = style => this._ctx.persist('map', 'style', style);
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
        }
        else {
            if (ctx.isResizeVisualUpdateType(options)) {
                return;
            }
            const config = this._cfg = this._config(), fmt = ctx.fmt;
            // followTheme: a runtime report-theme change does NOT mark the "map" object
            // dirty (the theme comes from host.colorPalette, not metadata.objects.map), so
            // push the freshly theme-derived basemap style whenever it actually changed.
            if (ctx.meta.map.followTheme && app.$state.mapctl && app.$state.mapctl.format.style !== config.map.style) {
                app.repaint(config, 'map');
            }
            if (ctx.dirty()) {
                // Flow lines: type/grouping change → full reset; colour/width → repaint flows.
                if (fmt.flow.dirty(['style', 'direction', 'limit'])) {
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
                if (fmt.legend.dirty()) {
                    app.repaint(config, 'legend');
                }
                if (fmt.map.dirty(['style', 'followTheme', 'pan', 'zoom', 'landDark', 'waterDark', 'landLight', 'waterLight', 'labelOpacity', 'autoFit'])) {
                    if (fmt.map.dirty(['style', 'followTheme', 'pan', 'zoom', 'landDark', 'waterDark', 'landLight', 'waterLight', 'labelOpacity'])) {
                        app.repaint(config, 'map');
                    }
                    fmt.map.dirty('autoFit') === 'on' && app.tryFitView();
                }
            }
            else {
                reset(config);
            }
            this._updateLegend();
        }
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
            case 'legend':
                return fmt.legend.dumper()
                    .metas(['show', 'position', 'fontSize'])
                    .labels(fmt.flow.binding('colorItem'), 'color_label')
                    .labels(fmt.flow.binding('widthItem'), 'width_label', d => d.metas(['width']))
                    .result;
            case 'flow': {
                const d = fmt.flow.dumper();
                // style / grouping
                d.metas(['style'], cfg).metas(cfg.style === 'flow', ['direction', 'limit']);
                d.metas(['animate']);
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
                            .metas(both || cfg.bubble.for === 'dest', ['labelColor'])
                            .metas(both || cfg.bubble.for === 'origin', ['labelColor'])
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