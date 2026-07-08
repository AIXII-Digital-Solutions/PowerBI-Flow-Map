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

    /** Force-directed edge bundling: build one polyline LinePath per (src→tar) edge. */
    public static bundle(srcLocs: ILocation[], tarLocs: ILocation[], trows: number[], weis: number[], opts: any) {
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
        const routed = fdeb(edges, opts);
        const paths = {} as StringMap<LinePath>;
        for (let k = 0; k < idx.length; k++) {
            const poly = routed[k], row = trows[idx[k]];
            let str = 'M ' + Math.round(poly[0].x) + ' ' + Math.round(poly[0].y);
            for (let m = 1; m < poly.length; m++) {
                str += ' L ' + Math.round(poly[m].x) + ' ' + Math.round(poly[m].y);
            }
            paths[row] = new LinePath(str, row, weis[idx[k]]);
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
            const line = helper.line(src, tars, trows, weis);
            return new LineShape(d3, src, line.paths, line.bound);
    }
}

/** Build a globally edge-bundled ("Corridors") shape from a set of rows (each = one edge). */
export function buildBundle(d3: ISelex, rows: number[]): IShape {
    const cfg = $state.config;
    const srcLocs = rows.map(r => $state.loc(cfg.source(r)));
    const tarLocs = rows.map(r => $state.loc(cfg.target(r)));
    const weis = rows.map(r => Math.max(cfg.weight.conv(r), 0));
    const b = cfg.bundle;
    const opts = {
        compatibility: b.compatibility, K: b.K, cycles: b.cycles, iterations: b.iterations,
        step: b.step, maxSubdivision: b.maxSubdivision, maxNeighbors: b.maxNeighbors,
        cone: b.cone, proximity: b.proximity, pointRadius: b.pointRadius, maxOffsetFrac: b.maxOffsetFrac,
    };
    const { paths, bound } = helper.bundle(srcLocs, tarLocs, rows, weis, opts);
    return new LineShape(d3, bound.anchor, paths, bound);
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