import { StringMap, Func, keys, dict, remap, groupBy } from '../type';
import { values } from 'd3';
import { sum } from 'd3-array';
import { IListener } from '../map';
import { ISelex } from '../d3';
import { $state } from './app';

export class Pie {
    public readonly addr: string;
    public readonly d3: ISelex;
    public readonly type: 'out' | 'in';
    public rows: number[];
    public readonly total: number;

    constructor(root: ISelex, addr: string, rows: number[], type: 'out' | 'in') {
        this.addr = addr;
        this.type = type;
        this.d3 = root.datum(this).att.class('pie');
        const weight = $state.config.weight.conv;
        this.total = sum(rows, r => weight(r));
        this.rows = rows;
    }


    reshape() {
        this.d3.selectAll('*').remove();
        const slice = $state.config.bubble.slice, weight = $state.config.weight.conv;
        if (!slice) {
            const color = $state.config.bubble.bubbleColor.solid.color;
            this.d3.append('circle').att.class('mask').att.fill(color)
                .att.stroke_opacity(0.8).att.stroke('white');
        }
        else {
            const groups = groupBy(this.rows, $state.color);
            const colors = keys(groups);
            if (colors.length === 1) {
                this.d3.append('circle').att.class('mask').att.fill(colors[0])
                    .att.stroke_opacity(0.8).att.stroke('white');
            }
            else {
                let slices = this.d3.append('g').att.class('slice');
                this.d3.append('circle').att.class('mask')
                    .att.fill('none').att.stroke('white')
                    .att.stroke_width(1).att.stroke_opacity(0.8);
                let unit = 1 / this.total * 2 * Math.PI;
                let angles = colors.map(c => sum(groups[c], r => weight(r)) * unit);
                var start = 0 - Math.PI / 2;
                for (var i = 0; i < angles.length; i++) {
                    var path = ['M 0 0'] as any[];
                    var sx = Math.cos(start);
                    var sy = Math.sin(start);
                    start += angles[i];
                    var ex = Math.cos(start);
                    var ey = Math.sin(start);
                    path.push('L', sx, sy);
                    path.push('A', 1, 1, 0);
                    path.push(angles[i] > Math.PI ? 1 : 0, 1, ex, ey, 'Z');
                    slices.append('path').att.d(path.join(' '))
                        .att.fill(colors[i]);
                }
            }
        }
        // Arrival (in) bubbles get a small white centre dot so they read as distinct
        // from the solid departure (out) bubbles — "similar but slightly different".
        if (this.type === 'in') {
            this.d3.append('circle').att.class('inner').att.fill('white')
                .att.fill_opacity(0.9).att.stroke('none');
        }
        this.d3.att.translate($state.mapctl.pixel($state.loc(this.addr)));
    }

    private _radius = 1;
    radius(radius?: number): number {
        if (radius === undefined) {
            return this._radius;
        }
        radius = radius || this._radius;
        this.d3.selectAll('.slice').att.scale(radius);
        this.d3.selectAll('.mask').att.r(radius);
        this.d3.selectAll('.inner').att.r(radius * 0.42);
        return this._radius = radius;
    }
}

let root: ISelex;

export const events = {
    onPieCreated: null as Func<ISelex<Pie>, void>
}

export function init(d3: ISelex): IListener {
    root = d3;
    return { transform: () => root.selectAll<Pie>('.pie').att.translate(p => $state.pixel(p.addr)) };
}

export function clear(): void {
    root.selectAll('*').remove();
    _rows = [];
    origins = {};
    destins = {};
}

export function get(key: string): Pie {
    if (key.split(' ')[0] === 'in') {
        return destins[key.substr('in '.length)];
    }
    else {
        return origins[key.substr('out '.length)];
    }
}

export function all() {
    return root.selectAll<Pie>('.pie');
}

/** Every route that touches a location, both directions: departures (its origin bubble) plus
 *  arrivals (its destination bubble). Clicking a hub selects all of them, not just one leg. */
export function connected(addr: string): number[] {
    const o = origins[addr], d = destins[addr];
    if (!o) { return d ? d.rows.slice() : []; }
    if (!d) { return o.rows.slice(); }
    const seen = {} as StringMap<boolean>, out = [] as number[];
    for (const r of o.rows) { if (!seen[r]) { seen[r] = true; out.push(r); } }
    for (const r of d.rows) { if (!seen[r]) { seen[r] = true; out.push(r); } }
    return out;
}

let _rows = [] as number[];
export function reset(data: number[]) {
    _rows = data;
    root.selectAll('*').remove();
    origins = {}; destins = {}; // separate objects — `a = b = {}` would alias one map to both
    if ($state.config.bubble.out) {
        origins = build(groupBy(data, $state.config.bubble.out), 'out');
    }
    if ($state.config.bubble.in) {
        destins = build(groupBy(data, $state.config.bubble.in), 'in');
    }
    root.selectAll<Pie>('.pie').sort((a, b) => b.total - a.total);
    events.onPieCreated && events.onPieCreated(root.selectAll<Pie>('.pie'));
    resetRadius();
}

let origins = {} as StringMap<Pie>;
let destins = {} as StringMap<Pie>;

function build(groups: StringMap<number[]>, type: 'in' | 'out') {
    return remap(groups, (addr, rows) => {
        let pie = new Pie(root.append('g'), addr, rows, type);
        pie.reshape();
        return pie;
    });
}

function resetRadius() {
    const width = $state.width;
    // The bigger coefficient always belongs to the HUB end — the one being grouped by. Grouping
    // by Origin: departures are the hubs (big), arrivals are the leaves (small). Grouping by
    // Destination: it flips — arrivals become the hubs (big) and departures the leaves (small).
    // Either way the radius still grows with the bubble's own total (flights in/out of it).
    const hub = $state.config.bubble.scaleOut / 10;
    const leaf = $state.config.bubble.scaleIn / 10;
    const byDest = $state.config.direction === 'in';
    const outFactor = byDest ? leaf : hub;
    const inFactor = byDest ? hub : leaf;
    const radius = (w: number, factor: number) => Math.sqrt(width(w)) * factor + 2;
    for (const pie of values(origins)) {
        pie.radius(radius(pie.total, outFactor));
    }
    for (const pie of values(destins)) {
        pie.radius(radius(pie.total, inFactor));
    }
}

/** Dim every bubble whose rows are not in `rows` (null/empty restores all). */
export function highlight(rows: number[] | null) {
    if (!root) {
        return;
    }
    if (!rows || rows.length === 0) {
        root.selectAll<Pie>('.pie').classed('dimmed', false).classed('selected', false);
        return;
    }
    const set = new Set<number>(rows);
    root.selectAll<Pie>('.pie')
        .classed('dimmed', p => !p.rows.some(r => set.has(r)))
        .classed('selected', p => p.rows.some(r => set.has(r)));
}

export function hover(addrs: string[]) {
    if (addrs) {
        const marks = dict(addrs);
        root.selectAll<Pie>('.mask').att.stroke(p => p.addr in marks ? '#333' : 'white');
    }
    else {
        root.selectAll<Pie>('.mask').att.stroke('white');
    }
}