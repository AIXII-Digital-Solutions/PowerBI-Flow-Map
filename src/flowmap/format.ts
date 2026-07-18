import { Setting } from '../pbi/numberFormat';

export class Format {
    // The corner legend for the secondary (Color) grouping. Shown in the format pane as
    // "Legend" (the old top/bottom colour+width bar and its "Legend" card were removed).
    groupLegend = {
        show: true,
        position: 'topLeft' as 'topRight' | 'topLeft' | 'bottomRight' | 'bottomLeft',
        orientation: 'vertical' as 'vertical' | 'horizontal',
        expanded: false,
        width: 130,
        fontSize: 11,
        title: ''
    };

    // "Flow lines" card — merges the former Visual style + Color + Width objects.
    // color*/width* are prefixed so the two encodings can share one object (and one
    // per-item persist store) without property-name collisions.
    flow = {
        // style
        // Default to the bundled spider ("flow") so routes merge into shared trunks and
        // branch out — the route-map look. Users can switch to great-circle / corridors.
        style: 'flow' as 'flow' | 'arc' | 'bundle',
        direction: 'out' as 'in' | 'out',
        // Show an on-canvas Origin/Destination switch (default from `direction`).
        directionControl: false,
        // Bundle by source ON by default: group every route from a hub into shared trunks
        // regardless of the Color field (otherwise a high-cardinality Color splits each hub
        // into single-route spiders → radial). Branches stay individually coloured.
        limit: 10,
        bundleBySource: true,
        // Spiral angle via visual.ts: 50 → 18° (the original flowmap default), 70 → ~21°.
        // Raised to 70 so nearby routes share ONE trunk further out = less clutter by default.
        bundleStrength: 70,
        // "Corridors" merge cone (degrees): routes whose directions differ by less than this
        // fuse into shared corridors; smaller = only near-parallel routes merge.
        bundleCone: 40,
        // "Corridors" merge radius (% of the view): two routes fuse only if they pass this close
        // to each other — the "only merge lines near each other" control.
        bundleRadius: 7,
        // "Corridors" (edge-bundling) only: when ON and a Color field is present, bundle each
        // colour separately instead of merging all routes into shared corridors.
        bundleSplitColor: false,
        animate: false,
        // Show an on-canvas button to toggle the animation (default from `animate`).
        animateControl: false,
        // Corner each on-canvas button is pinned to (independent, so they never overlap each other).
        // Defaults are the bottom corners so they clear the legend (top-left) and the Power BI
        // header chrome (top-right); the user can move either to any corner.
        directionControlPosition: 'bottomLeft' as 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
        animateControlPosition: 'bottomRight' as 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
        // color — distinct palette colour per secondary group by default (autofill on);
        // turn autofill off + set the default colour to make all group lines one colour.
        colorCustomize: true,
        colorAutofill: true,
        // AIXII brand palette defaults (matches AI-XII_PowerBI_Theme_Light.json). With a Color
        // field + autofill the per-group colours come from the report theme's dataColors via
        // host.colorPalette; these apply when there's no Color field / for the numeric gradient.
        colorItem: { solid: { color: '#D40000' } },
        colorMin: { solid: { color: '#EA8080' } },
        colorMax: { solid: { color: '#9F0000' } },
        // width
        widthCustomize: true,
        widthItem: 2,
        widthScale: 'linear' as 'linear' | 'log' | 'none',
        widthMin: 2,
        widthMax: 10,
        widthUnit: null as number//depends
    };

    // "Map" card — Leaflet + MapLibre GL basemap (mirrors PowerBI-RealTimePos-Map) plus
    // the former Advanced object (manual point placement / pin visibility).
    map = {
        style: 'dark' as 'dark' | 'light',
        followTheme: true,
        autoFit: true,
        pan: true,
        zoom: true,
        landDark: { solid: { color: '#262626' } },
        waterDark: { solid: { color: '#141417' } },
        landLight: { solid: { color: '#d4dadc' } },
        waterLight: { solid: { color: '#ffffff' } },
        labelOpacity: 60,
        relocate: false,
        located: true,
        unlocated: true
    };

    valueFormat = new ValueFormat();

    bubble = {
        for: null as 'none' | 'origin' | 'dest' | 'both',//depends
        slice: null as boolean,//depends
        bubbleColor: { solid: { color: '#888888' } },
        scaleOut: 25,
        scaleIn: 15,
        label: 'none' as 'none' | 'all' | 'manual' | 'hide',
        labelOpacity: 50,
        labelColor: { solid: { color: '#888888' } }
    };
}

class ValueFormat extends Setting {
    sort = 'des' as 'asc' | 'des';
    top = 10;
}
