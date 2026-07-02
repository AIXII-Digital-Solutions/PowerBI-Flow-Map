import { Setting } from '../pbi/numberFormat';

export class Format {
    legend = {
        show: true,
        position: 'top' as 'top' | 'bot',
        fontSize: 12,
        color: true,
        width: true,
        color_default: false,
        width_default: false,
        color_label: '',
        width_label: ''
    };

    // "Flow lines" card — merges the former Visual style + Color + Width objects.
    // color*/width* are prefixed so the two encodings can share one object (and one
    // per-item persist store) without property-name collisions.
    flow = {
        // style
        style: null as 'straight' | 'flow' | 'arc',//depends
        direction: 'out' as 'in' | 'out',
        limit: 5,
        // color
        colorCustomize: true,
        colorAutofill: false,
        colorItem: { solid: { color: '#01B8AA' } },
        colorMin: { solid: { color: '#99e3dd' } },
        colorMax: { solid: { color: '#015c55' } },
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
        scale: 25,
        label: 'none' as 'none' | 'all' | 'manual' | 'hide',
        labelOpacity: 50,
        labelColor: { solid: { color: '#888888' } }
    };
}

class ValueFormat extends Setting {
    sort = 'des' as 'asc' | 'des';
    top = 10;
}
