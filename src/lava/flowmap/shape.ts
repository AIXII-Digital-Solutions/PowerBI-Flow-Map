import { ILocation, IBound, Converter, IMapShim } from '../map';
import { Func, StringMap, values } from '../type';
import { Key, IPathPoint, IPoint, ILayout, IPath, layout } from './algo';
import { bundle as fdeb, BEdge } from './bundle';
import { extent } from 'd3-array';
import { arc } from './arc';
import { ISelex } from '../d3';

import { $state } from './app';

const map20 = new Converter(20);

function pointConverter(level: number) {
    var zoom = $state.mapctl.map.getZoom();
    if (zoom === level) {
        return null;
    }
    let factor = map20.factor(zoom);
    return (input: IPathPoint, output: number[]) => {
        output[0] = input[0] * factor;
        output[1] = input[1] * factor;
    };
}

class LinePath implements IPath {
    id: Key;
    leafs: Key[];

    private _width: number;
    private _path = '';
    
    constructor(path: string, key: number, public weight: number) {
        this.id = key;
        this._width = weight;
        this.leafs = [key];
        this._path = path;
    }

    d(tran?: (input: IPathPoint, output: number[]) => void): string {
        return this._path;
    }
    
    width(scale?: Func<number, number>): number {
        if (scale) {
            this._width = scale(this.weight);
        }
        return this._width;
    }
    minLatitude: number;
    maxLatitude: number;
}

/** One merged corridor segment: the stretch of bundled geometry shared by `leafs` routes.
 *  Its weight is the SUM of those routes' weights, so a shared corridor draws as ONE thick trunk
 *  that thins where routes peel off — the Flow silhouette, on edge-bundled geometry. */
class BundlePath implements IPath {
    public readonly id: Key;
    public leafs: Key[];
    public weight = 0;
    private _width = 0;
    private _path: string;
    constructor(id: string, path: string, leafs: Key[]) {
        this.id = id;
        this._path = path;
        this.leafs = leafs;
    }
    public d(): string {
        return this._path;
    }
    public width(scale?: Func<number, number>): number {
        if (scale) {
            this._width = scale(this.weight);
        }
        return this._width;
    }
}

class helper {
    public static initPaths(root: ISelex, shape: IShape) {
        let conv = pointConverter(null);
        const data = shape.paths();
        root.selectAll('*').remove();
        // Wide, invisible "hit" path under each visible one so thin lines are easy to
        // hover/click. Cheap on pan (the whole group is translated, not each path); the
        // extra d update only happens on zoom.
        root.selectAll('.hit').data(data).enter().append('path')
            .att.class('hit flow').att.d(p => p.d(conv))
            .att.fill('none').att.stroke('#fff').att.stroke_opacity(0).att.stroke_linecap('round');
        root.selectAll('.base').data(data).enter().append('path')
            .att.class('base flow').att.d(p => p.d(conv))
            .att.stroke_linecap('round').att.fill('none');
    }

    public static line(src: ILocation, tlocs: ILocation[], trows: number[], weis: number[]) {
        let all = tlocs.concat(src);
        let bound = map20.points(all);
        let spnt = bound.points.pop();
        let pre = 'M ' + Math.round(spnt.x) + ' ' + Math.round(spnt.y);
        let paths = {} as StringMap<LinePath>;
        let row2tar = {} as StringMap<ILocation>;
        for (let i = 0; i < bound.points.length; i++) {
            row2tar[i] = tlocs[i];
            let tpnt = bound.points[i], trow = trows[i];
            var str = pre + ' L ' + Math.round(tpnt.x) + ' ' + Math.round(tpnt.y);
            paths[trow] = new LinePath(str, trow, weis[i]);
        }
        return { paths, bound: bound as IBound };
    }

    public static arc(src: ILocation, tlocs: ILocation[], trows: number[], weis: number[]) {
        let slon = src.longitude, slat = src.latitude;
        let scoord = { x: 0, y: slat }, tcoord = { x: 0, y: 0 };
        let all = tlocs.concat(src);
        // let yext = extent(all, p => p.latitude);
        let bound = $state.mapctl.bound(all);
        let anchor = bound.anchor;
        anchor.latitude = slat;
        let alon = anchor.longitude;
        let bias = map20.x(slon) - map20.x(alon);
        if (Math.abs(alon - slon) > 180) {
            if (alon > slon) {
                bias = map20.x(slon + 360 - alon - 180);
            }
            else {
                bias = 0 - map20.x(alon + 360 - slon - 180);
            }
        }
        let paths = {} as StringMap<LinePath>;
        let row2tar = {} as StringMap<ILocation>;
        let minlat = Number.POSITIVE_INFINITY;
        let maxlat = Number.NEGATIVE_INFINITY;
        for (var i = 0, len = tlocs.length; i < len; i++) {
            let t = tlocs[i], tlon = t.longitude, trow = trows[i];
            row2tar[trow] = t;
            let miny = Number.POSITIVE_INFINITY;
            let maxy = Number.NEGATIVE_INFINITY;
            tcoord.y = t.latitude;
            if (Math.abs(tlon - slon) < 180) {
                tcoord.x = tlon - slon;
            }
            else {
                if (tlon < slon) {
                    tcoord.x = 360 - slon + tlon;
                }
                else {
                    tcoord.x = tlon - slon - 360;
                }
            }
            var cnt = Math.max(Math.round(Math.abs(tcoord.x / 4)), 10);
            var coords = arc(scoord, tcoord, cnt);
            var sx = map20.x(0), sy = map20.y(scoord.y);
            var str = 'M ' + Math.round(bias) + ' 0';
            for (var pair of coords) {
                let [px, py] = pair;
                if (py < miny) {
                    miny = py;
                }
                if (py > maxy) {
                    maxy = py;
                }
                var dx = Math.round(map20.x(px) - sx + bias);
                var dy = Math.round(map20.y(py) - sy);
                str += ' L ' + dx + ' ' + dy;
            }
            var apath = new LinePath(str, trow, weis[i]);
            minlat = Math.min(minlat, miny);
            maxlat = Math.max(maxlat, maxy);
            apath.minLatitude = miny;
            apath.maxLatitude = maxy;
            paths[trow] = apath;
        }
        bound.margin.north = maxlat - slat;
        bound.margin.south = slat - minlat;
        return { paths, bound };
    }

    /** Force-directed edge bundling, drawn like Flow. One polyline per route merely stacks
     *  overlapping lines, so instead the bundled geometry is collapsed into shared segments: at
     *  every subdivision level the routes' points are clustered, routes travelling through the
     *  same clusters become ONE segment carrying all of them, and consecutive levels with the
     *  same membership chain into a single polyline. Width then comes from the summed weight
     *  (see BundleShape.calc) — a thick common trunk that splits into thin branches near the
     *  endpoints, across hubs, which the spider tree cannot do. */
    public static bundle(srcLocs: ILocation[], tarLocs: ILocation[], trows: number[], opts: any) {
        const idx = [] as number[];
        for (let i = 0; i < trows.length; i++) {
            if (srcLocs[i] && tarLocs[i]) idx.push(i);
        }
        const all = [] as ILocation[];
        for (const i of idx) { all.push(srcLocs[i]); all.push(tarLocs[i]); }
        const bound = map20.points(all);
        const pts = bound.points;
        const edges = [] as BEdge[];
        for (let k = 0; k < idx.length; k++) {
            const s = pts[2 * k], t = pts[2 * k + 1];
            edges.push({ x0: s.x, y0: s.y, x1: t.x, y1: t.y });
        }
        const paths = [] as BundlePath[];
        const routed = fdeb(edges, opts);
        const n = routed.length;
        if (!n) {
            return { paths, bound };
        }
        const levels = routed[0].length;

        // Cluster tolerance: a small slice of the drawn extent. FDEB parks bundled points right
        // on top of each other, so a coarse grid is enough to spot "same corridor".
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const p of pts) {
            mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x);
            mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y);
        }
        // Cluster tolerance, tied to the user's Merge radius so one slider governs both which
        // routes FDEB pulls together and how tightly they must run to count as one trunk. FDEB
        // only closes the gap by roughly half, so the tolerance has to be a real fraction of the
        // merge radius — measured: ~0.7x lands on the sweet spot (about half the segments shared,
        // fattest trunk carrying ~80 routes) without snapping unrelated routes together.
        const span = (Math.max(mxx - mnx, mxy - mny) || 1);
        const prox = (opts && +opts.proximity > 0) ? +opts.proximity : 70;
        const cell = span * (prox / 1000) * 0.7;

        // Per level: the cluster each route sits in + each cluster's mean point. The two end
        // levels key on the exact point instead, so a route always starts/ends on its own airport
        // (identical airports still share a cluster; different ones never get averaged together).
        const keyAt = [] as string[][];
        const midAt = [] as StringMap<{ x: number, y: number, n: number }>[];
        for (let k = 0; k < levels; k++) {
            const ends = (k === 0 || k === levels - 1);
            const keys = new Array<string>(n);
            const cs = {} as StringMap<{ x: number, y: number, n: number }>;
            for (let e = 0; e < n; e++) {
                const p = routed[e][k];
                const key = ends
                    ? Math.round(p.x) + ',' + Math.round(p.y)
                    : Math.round(p.x / cell) + ',' + Math.round(p.y / cell);
                keys[e] = key;
                const c = cs[key] || (cs[key] = { x: 0, y: 0, n: 0 });
                c.x += p.x; c.y += p.y; c.n++;
            }
            for (const key in cs) { cs[key].x /= cs[key].n; cs[key].y /= cs[key].n; }
            keyAt.push(keys); midAt.push(cs);
        }

        // Emit ONE segment per level step per distinct cluster pair, carrying every route that
        // makes that step. Chaining steps into longer polylines was tried and measured: cluster
        // membership flickers as routes drift between cells, so runs kept breaking and each route
        // shattered into ~5 stubs that each carried a single route — every line came out equally
        // thin. Drawing per step instead keeps the summed width exact; the stubs meet on shared
        // cluster centres and round linecaps join them into one continuous trunk.
        for (let k = 0; k < levels - 1; k++) {
            const groups = {} as StringMap<number[]>;
            for (let e = 0; e < n; e++) {
                const key = keyAt[k][e] + '>' + keyAt[k + 1][e];
                (groups[key] || (groups[key] = [])).push(e);
            }
            for (const key in groups) {
                const members = groups[key];
                const head = members[0];
                const a = midAt[k][keyAt[k][head]], b = midAt[k + 1][keyAt[k + 1][head]];
                const str = 'M ' + Math.round(a.x) + ' ' + Math.round(a.y)
                    + ' L ' + Math.round(b.x) + ' ' + Math.round(b.y);
                paths.push(new BundlePath('b' + paths.length, str, members.map(e => trows[idx[e]])));
            }
        }
        return { paths, bound };
    }
}

export interface IShape {
    rewidth(): void;
    calc(weight: (row: number) => number): number[];
    transform(map: IMapShim, pzoom: number): void;
    bound: IBound;
    source: ILocation;
    paths(): IPath[];
}

export function build(type: 'straight' | 'flow' | 'arc', d3: ISelex, src: ILocation, tars: ILocation[], trows: number[], weis: number[]): IShape {
    switch (type) {
        case 'flow':
            return new FlowShape(d3, src, tars, trows, weis);
        case 'arc':
            const arc = helper.arc(src, tars, trows, weis);
            return new LineShape(d3, src, arc.paths, arc.bound);
        case 'straight':
            // Internal-only fallback for large datasets (not a user-facing Type).
            const line = helper.line(src, tars, trows, weis);
            return new LineShape(d3, src, line.paths, line.bound);
    }
}

/** Corridors drawn with the Flow silhouette. Geometry is fixed in level-20 coords, so a zoom
 *  just rescales the group (no per-path rebuild); each merged segment's width is the summed
 *  weight of the routes it carries, which is what produces the thick trunk / thin branches. */
class BundleShape implements IShape {
    public readonly d3: ISelex;
    public readonly bound: IBound;
    public readonly source: ILocation;
    private _paths: BundlePath[];

    constructor(d3: ISelex, src: ILocation, paths: BundlePath[], bound: IBound) {
        this.source = src;
        this.d3 = d3;
        this._paths = paths;
        this.bound = bound;
        helper.initPaths(d3, this);
    }

    paths(): IPath[] {
        return this._paths;
    }

    calc(weight: (row: number) => number): number[] {
        for (const p of this._paths) {
            let w = 0;
            for (const l of p.leafs) { w += Math.max(weight(+l), 0); }
            p.weight = w;
        }
        return extent(this._paths.map(p => p.weight));
    }

    rewidth() {
        const factor = map20.factor($state.mapctl.map.getZoom());
        const width = (v: number) => $state.width(v) / factor;
        this.d3.att.scale(factor);
        this.d3.selectAll<IPath>('.base').att.stroke_width(p => p.width(width));
    }

    transform(map: IMapShim, pzoom: number) {
        // Pan (zoom unchanged): the scale factor and every stroke-width are identical to the
        // previous frame, and VisualFlow._translate already repositions the group. Skip the
        // O(paths) rewidth — only a zoom actually changes it. Mirrors FlowShape's guard.
        if (map.getZoom() === pzoom) { return; }
        this.rewidth();
    }
}

/** Build a globally edge-bundled ("Corridors") shape from a set of rows (each = one edge). */
export function buildBundle(d3: ISelex, rows: number[]): IShape {
    const cfg = $state.config;
    const srcLocs = rows.map(r => $state.loc(cfg.source(r)));
    const tarLocs = rows.map(r => $state.loc(cfg.target(r)));
    const b = cfg.bundle;
    const opts = {
        compatibility: b.compatibility, K: b.K, cycles: b.cycles, iterations: b.iterations,
        step: b.step, maxSubdivision: b.maxSubdivision, maxNeighbors: b.maxNeighbors,
        cone: b.cone, proximity: b.proximity, pointRadius: b.pointRadius, maxOffsetFrac: b.maxOffsetFrac,
    };
    const { paths, bound } = helper.bundle(srcLocs, tarLocs, rows, opts);
    return new BundleShape(d3, bound.anchor, paths, bound);
}

class FlowShape implements IShape {
    public readonly d3: ISelex;
    public readonly bound: IBound;
    private _layout: ILayout;
    private _row2tar = {} as StringMap<ILocation>;
    public readonly source: ILocation;
    constructor(d3: ISelex, src: ILocation, tars: ILocation[], trows: number[], weis?: number[]) {
        this.source = src;
        const area = map20.points([src].concat(tars));
        const points = area.points;
        const source = points.shift() as IPoint;
        source.key = $state.config.source(trows[0]);
        for (let i = 0; i < points.length; i++){
            (points[i] as IPoint).key = trows[i];
            this._row2tar[trows[i]] = tars[i];
        }
        this._layout = layout(source, points, weis);
        helper.initPaths(d3, this);
        this.d3 = d3;
        this.bound = area;
    }

    paths(): IPath[] {
        return this._layout.paths();
    }

    calc(weight: (row: number) => number): number[] {
        weight && this._layout.build(weight);
        return extent(this._layout.paths().map(p => p.weight));
    }

    rewidth() {
        const conv = pointConverter(null);
        // ORDER MATTERS: width() sets each path's sideways taper offset (offset[2] =
        // parentWidth/2 - selfWidth/2); d() then READS that offset to spread the curve so a
        // trunk tapers into its branches. The original runs width-before-d; reversing it (as
        // this fork briefly did for the .hit split) drew every curve with offset 0 → thin
        // centred lines with no trunk taper. Width on .base sets the shared path objects'
        // offset; d on all paths (.base + .hit share the same data) reads it.
        this.d3.selectAll<IPath>('.base').att.stroke_width(p => p.width($state.width));
        this.d3.selectAll<IPath>('path').att.d(p => p.d(conv));
    }

    transform(map: IMapShim, pzoom: number) {
        const conv = pointConverter(pzoom);
        conv && this.d3.selectAll<IPath>('.flow').att.d(p => p.d(conv));
    }
}

class LineShape implements IShape {
    public readonly d3: ISelex;
    public readonly bound: IBound;
    public readonly source: ILocation;

    private _row2Path = {} as StringMap<LinePath>;

    constructor(d3: ISelex, src: ILocation, row2Path: StringMap<LinePath>, bound: IBound) {
        this.source = src;
        this.d3 = d3;
        this._row2Path = row2Path;
        this.bound = bound;
        helper.initPaths(d3, this);
    }

    calc(weight: (row: number) => number): number[] {
        if (weight) {
            for (let r in this._row2Path) {
                let path = this._row2Path[r];
                path.weight = weight(+r);
            }
        }
        return extent(values(this._row2Path).map(p => p.weight));
    }

    rewidth() {
        const factor = map20.factor($state.mapctl.map.getZoom());
        const width = (v: number) => $state.width(v) / factor;
        this.d3.att.scale(factor);
        this.d3.selectAll<IPath>('.base').att.stroke_width(p => p.width(width));
    }

    transform(map: IMapShim, pzoom: number) {
        this.rewidth();
    }

    paths(): IPath[] {
        return values(this._row2Path);
    }
}