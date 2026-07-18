import { Func } from '../type';
import { $state } from './app';
import { IShape, build, buildBundle } from './shape';
import { IPath } from './algo';
import { ISelex } from '../d3';
import { IListener, IBound, ILocation, IMapShim } from '../map';

let root: ISelex;

export const events = {
    hover: null as Func<number[], void>,
    pathInited: null as Func<ISelex<IPath>, void>
}

class VisualFlow {
     rows: number[];
    
    public get bound() {
        return this._shape.bound;
    }
  
    public get source() {
        return this._shape.source;
    }

    reweight(weight: Func<number, number>) {
        return this._shape.calc(weight);
    }

    private _tRoot: ISelex;
    private _sRoot: ISelex;
    private _shape: IShape;
    constructor(d3: ISelex, rows: number[]) {
        this._tRoot = d3.datum(this).att.class('vflow anchor');
        this._sRoot = this._tRoot.append('g').att.class('scale');
        this.rows = rows;
        this._relayout();
    }

    remove() {
        // Kill any pending hover timer — otherwise it fires after teardown and calls
        // events.hover() with row indices from the destroyed layout.
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        this._tRoot.remove();
    }

    /** Highlight ONE route rather than the whole spider: a route is exactly the set of path
     *  segments whose `leafs` contain a selected row — i.e. its branch plus the trunk chain it
     *  travels back to the hub. Every other segment (sibling branches, unrelated trunks) dims,
     *  so clicking a branch shows that single origin→destination path.
     *
     *  Kept cheap on purpose: a spider that holds none of the selection dims as ONE group node,
     *  so only the flow the route actually runs through pays any per-segment cost. Selections
     *  touch only the visible `.base` paths (never the invisible `.hit` twins).
     */
    public highlight(set: { has(v: number): boolean } | null) {
        if (!set) {
            this._tRoot.classed('dimmed', false);
            this._undimPaths();
            return;
        }
        if (!this.rows.some(r => set.has(r))) {
            this._tRoot.classed('dimmed', true);   // one write for the whole spider
            this._undimPaths();
            return;
        }
        this._tRoot.classed('dimmed', false);
        const base = this._base();
        if (base) {
            base.classed('dimmed', p => !(p.leafs as number[]).some(l => set.has(+l)));
            this._pathsDimmed = true;
        }
    }

    /** Visible paths of this flow, cached — re-querying the DOM on every click is what made
     *  select/clear feel sluggish. Invalidated on relayout. */
    private _basePaths: ISelex<IPath> = null;
    private _pathsDimmed = false;
    private _base(): ISelex<IPath> {
        if (!this._basePaths && this._shape) {
            this._basePaths = this._sRoot.selectAll<IPath>('.base');
        }
        return this._basePaths;
    }
    private _undimPaths(): void {
        if (this._pathsDimmed) {
            const base = this._base();
            base && base.classed('dimmed', false);
            this._pathsDimmed = false;
        }
    }

    public reformat(recolor: boolean, rewidth: boolean) {
        if (recolor) {
            const paths = this._sRoot.selectAll<IPath>('.base');
            if ($state.config.style === 'flow') {
                if ($state.config.bundleBySource) {
                    // All routes from this source share trunks; colour each edge by a
                    // representative leaf row so branches keep their group colour.
                    paths.att.stroke(p => $state.color(+p.leafs[0]));
                }
                else {
                    const color = $state.color(this.rows[0]);
                    paths.att.stroke(color);
                }
            }
            else {
                paths.att.stroke(p => $state.color(+p.id));
            }
        }
        if (rewidth && this._shape) {
            this._shape.rewidth();
        }
    }
    
    private _hoverTimer = null as number;
    private _hoverState = null as any;
    private _onover = (p: IPath) => {
        const rows = p.leafs as number[];
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        if (this._hoverState !== p.id && this._hoverState) {
            this._hoverState = null;
            events.hover && events.hover(null);
        }
        if (this._hoverState === null) {
            this._hoverTimer = window.setTimeout(() => {
                if (this._hoverState) {
                    events.hover && events.hover(null);
                }
                events.hover && events.hover(rows);
                this._hoverState = p.id;
                this._hoverTimer = null;
            }, 300);
        }
    };

    private _onout = () => {
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        this._hoverTimer = window.setTimeout(() => {
            if (this._hoverState) {
                this._hoverState = null;
                events.hover && events.hover(null);
            }
            this._hoverTimer = null;
        }, 100);
    };

    private _relayout() {
        this._shape = this._build();
        this._basePaths = null;      // paths were re-created — drop the cached selection
        this._pathsDimmed = false;
        if (!this._shape) {
            return;
        }
        let all = this._sRoot
            .selectAll<IPath>('.flow')
            .on('mouseover', this._onover)
            .on('mouseout', this._onout);
        
        this._translate();
        events.pathInited && events.pathInited(all);
    }

    transform(map: IMapShim, pzoom: number) {
        if (this._shape) {
            this._shape.transform(map, pzoom);
            this._translate();
        }
    }

    private _translate() {
        this._tRoot.att.translate($state.mapctl.pixel(this._shape.bound));
    }

    private _build() {
        if ($state.config.style === 'bundle') {
            return buildBundle(this._sRoot, this.rows);
        }
        const source = $state.loc($state.config.source(this.rows[0]));
        const weights = this.rows.map(r => Math.max($state.config.weight.conv(r), 0));
        const targets = this.rows.map(r => $state.loc($state.config.target(r)));
        return build($state.config.style as 'straight' | 'flow' | 'arc', this._sRoot, source, targets, this.rows, weights);
    }
}

export function init(d3: ISelex): IListener {
    const rect = d3.append('rect');
    const remask = () => rect.att.width($state.mapctl.map.getWidth())
        .att.height($state.mapctl.map.getHeight())
        .att.x(0 - $state.mapctl.map.getWidth() / 2)
        .att.y(0 - $state.mapctl.map.getHeight() / 2)
        .att.fill_opacity(0.01)
        .sty.pointer_events('none');
    root = d3.append('g');
    return {
        transform: (ctl, pzoom) => {
            flows.forEach(v => v.transform(ctl.map, pzoom));
            // remask() intentionally NOT called here: the hit-mask rect only depends on the
            // viewport size, which is unchanged during pan/zoom — rewriting its 6 attributes
            // (each a Leaflet getSize() read) every move frame was pure waste. Only resize changes it.
        },
        resize: () => remask()
    }
}

export function add(rows: number[]) {
    flows.push(new VisualFlow(root.append('g'), rows));
}

export function clear() {
    for (const v of flows) {
        v.remove();
    }
    flows = [];
}

export function bounds(): IBound[] {
    return flows.map(f => f.bound);
}

export function sources(): ILocation[] {
  return flows.map(f => f.source);
}

let flows = [] as VisualFlow[];

export function reweight(weight: Func<number, number>): number[] {
    let exts = flows.map(v => v.reweight(weight));
    let min = Math.min(...exts.map(e => e[0]));
    let max = Math.max(...exts.map(e => e[1]));
    return [min, max];
}

export function reformat(recolor: boolean, rewidth: boolean) {
    for (let f of flows) {
        f.reformat(recolor, rewidth);
    }
}

/** Dim every path segment that is not part of a selected route (null/empty restores all). */
export function highlight(rows: number[] | null) {
    const set = rows && rows.length ? new Set<number>(rows) : null;
    for (const v of flows) {
        v.highlight(set);
    }
}
