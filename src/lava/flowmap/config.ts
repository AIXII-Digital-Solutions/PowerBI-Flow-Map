import { StringMap } from "../type";
import { ILocation, MapFormat } from "../map";
import { Setting } from "../../pbi/numberFormat";

type Func<T = string> = (i: number) => T;
export class Config {
    error = null as string;
    advance = {
        relocate: false,
        located: true,
        unlocated: true
    };
    // 'straight' is NOT a user-selectable Type (removed from the UI) — it stays only as the
    // cheap internal fallback for large datasets, where rendering every route as an arc is slow.
    style = null as 'straight' | 'flow' | 'arc' | 'bundle';
    /** Effective grouping end: 'out' = group by Origin, 'in' = group by Destination. Resolved
     *  from the GroupBy field when supplied, else the Group by setting. */
    direction = 'out' as 'in' | 'out';
    bundleBySource = false;
    // "Corridors" mean-attraction edge-bundling parameters (see lava/flowmap/bundle.ts),
    // filled from the Bundle strength / Merge cone / Merge radius settings.
    bundle = {
        compatibility: 0.6, K: 0.5, cycles: 5, iterations: 90, step: 0.5,
        maxSubdivision: 37, maxNeighbors: 60, cone: 40 * Math.PI / 180,
        proximity: 70, pointRadius: 60, maxOffsetFrac: 0.34, splitColor: false
    };
    source = null as Func;
    target = null as Func;
    groups = null as number[][];
    color = null as Func<number | string> & { min?: string, max?: string };//row=>value || row=>color
    weight = null as
        { conv: Func<number>; min: number; max: number; scale: 'linear' | 'log'; } |
        { conv: Func<number>; unit: number; scale: 'none' } |
        { conv: Func<number>; scale: null }
    popup = {
        description: null as Func,
        origin: null as Func,
        destination: null as Func
    };
    legend = {
        show: false,
        fontSize: 12,
        position: 'top' as 'top' | 'bottom',
        color: true,
        width: true,
        colorLabels: {} as StringMap<string>,
        widthLabels: {} as StringMap<string>
    };

    map = new MapFormat();

    bubble = {
        for: null as 'none' | 'origin' | 'dest' | 'both',//depends
        slice: null as boolean,//depends
        bubbleColor: { solid: { color: '#888888' } },
        scaleOut: 25,
        scaleIn: 15,
        label: 'none' as 'none' | 'all' | 'manual' | 'hide',
        labelOpacity: 50,
        labelColor: { solid: { color: '#888888' } },
        in: null as Func,
        out: null as Func
    };
    
    injections = {} as StringMap<ILocation>;

    numberSorter = { sort: 'des' as 'asc' | 'des', top: 10 }

    numberFormat = new Setting();
}
