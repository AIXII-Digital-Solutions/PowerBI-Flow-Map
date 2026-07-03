/**
 * Map controller — Leaflet + MapLibre GL vector basemap, mirroring the basemap of
 * PowerBI-RealTimePos-Map (CARTO dark-matter / positron vector styles, recoloured
 * water + land per theme, our SDF glyphs for basemap labels, Dark/Light switch,
 * bounded vertical panning, infinite horizontal).
 *
 * It keeps the exact public surface the flow renderer expects from the former Bing
 * controller — a `.map` shim exposing pixel projection (viewport-center-relative by
 * default, top-left for popups), zoom, size, listeners and an overlay root element —
 * so the SVG/canvas flow overlay, pins and pies keep working unchanged. Only the
 * basemap engine and projection source changed (Bing → Leaflet).
 */
import * as L from "leaflet";
import "@maplibre/maplibre-gl-leaflet";

import { ILocation, IBound } from './converter';
import { anchorPixel, bound, anchor, area } from './converter';
import { IPoint, keys, clamp } from '../type';
import { ISelex, selex } from '../d3';
import { GLYPHS, GLYPH_EMPTY, GLYPH_FONTSTACK } from './glyphs';

export type MapStyle = 'dark' | 'light';

/** How a projected pixel is anchored: 'viewport' = relative to viewport centre (flow
 * overlay), 'control' = relative to the top-left of the map (HTML popups). */
export type PixelRef = 'viewport' | 'control';
export const PixelReference: { viewport: PixelRef, control: PixelRef } = { viewport: 'viewport', control: 'control' };

/** The subset of the old `Microsoft.Maps.Map` surface the flow renderer relies on,
 * now backed by a Leaflet map. */
export interface IMapShim {
  getWidth(): number;
  getHeight(): number;
  getZoom(): number;
  getCenter(): ILocation;
  getZoomRange(): { min: number, max: number };
  tryLocationToPixel(loc: ILocation, ref?: PixelRef): IPoint;
  tryPixelToLocation(p: IPoint, ref?: PixelRef): ILocation;
  getRootElement(): HTMLElement;
  setView(v: { center?: ILocation, zoom?: number }): void;
  setOptions(o: { disablePanning?: boolean, disableZooming?: boolean }): void;
}

export interface IMapFormat {
  style: MapStyle;
  followTheme: boolean;
  autoFit: boolean;
  pan: boolean;
  zoom: boolean;
  landDark: string;
  waterDark: string;
  landLight: string;
  waterLight: string;
  labelOpacity: number;
}

export class MapFormat implements IMapFormat {
  style: MapStyle = 'dark';
  followTheme = true;
  autoFit = true;
  pan = true;
  zoom = true;
  landDark = '#262626';
  waterDark = '#141417';
  landLight = '#d4dadc';
  waterLight = '#ffffff';
  labelOpacity = 60;

  public static build(...fmts: any[]): MapFormat {
    const ret = new MapFormat();
    for (const f of fmts.filter(v => v)) {
      for (const key in ret) {
        if (key in f) {
          ret[key] = f[key];
        }
      }
    }
    return ret;
  }
}

export interface IListener {
  transform?(ctl: Controller, pzoom: number, end?: boolean): void;
  resize?(ctl: Controller): void;
}

// CARTO GL vector styles (free, attribution required) — we only recolour water + land.
const STYLE_URLS: Record<MapStyle, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const WORLD_LAT = 85.05;
const PAN_BOUNDS = L.latLngBounds([[-WORLD_LAT, -1e6], [WORLD_LAT, 1e6]]);
const FIT_BOUNDS = L.latLngBounds([[-WORLD_LAT, -180], [WORLD_LAT, 180]]);

interface GLMap {
  isStyleLoaded: () => boolean;
  getStyle: () => { layers?: Array<Record<string, unknown>> } | undefined;
  setStyle: (style: string) => void;
  setPaintProperty: (id: string, prop: string, value: unknown) => void;
  setLayoutProperty: (id: string, prop: string, value: unknown) => void;
  on: (ev: string, cb: () => void) => void;
}
type GLLayer = L.Layer & { getMaplibreMap: () => GLMap };

/** Serve our bundled CoFoSansMono SDF glyphs to MapLibre (basemap labels in our font). */
function glyphTransformRequest(url: string, resourceType?: string): { url: string } | undefined {
  if (resourceType !== 'Glyphs') {
    return undefined;
  }
  const match = /\/([^/]+)\.pbf(?:$|\?)/.exec(url);
  const range = match ? match[1] : '';
  const b64 = GLYPHS[range] || GLYPH_EMPTY;
  return { url: `data:application/x-protobuf;base64,${b64}` };
}

export class Controller {
  private _div: HTMLDivElement;        // the #view element
  private _mapDiv: HTMLDivElement;     // Leaflet container (basemap)
  private _overlay: HTMLDivElement;    // fixed viewport overlay (canvas + svg)
  private _lmap: L.Map = null;
  private _gl: GLLayer = null;
  private _fmt: IMapFormat;
  private _svg: ISelex;
  private _svgroot: ISelex;
  private _canvas: ISelex;
  private _shim: IMapShim;
  private _listener = [] as IListener[];
  private _zoom = 2;
  private _applyTimers: number[] = [];
  private _styleControl: HTMLElement = null;
  private _styleButtons = {} as Record<MapStyle, HTMLButtonElement>;

  /** Set by the visual to persist the on-map style switch. */
  public onStyleChanged: (style: MapStyle) => void = null;

  private _onBgClick: () => void = null;
  /** Register a handler for clicks on the empty basemap (used to clear selection). */
  public onBackgroundClick(cb: () => void): void { this._onBgClick = cb; }

  public get map(): IMapShim { return this._shim; }
  public get format() { return this._fmt; }
  public get svg() { return this._svgroot; }
  public get canvas() { return this._canvas; }

  constructor(id: string) {
    this._fmt = new MapFormat();
    const div = this._div = selex(id).node<HTMLDivElement>();
    if (!div.style.position) {
      div.style.position = 'relative';
    }
    // Basemap container (Leaflet + GL) fills the view.
    this._mapDiv = document.createElement('div');
    this._mapDiv.className = 'flowmap-basemap';
    this._mapDiv.style.width = '100%';
    this._mapDiv.style.height = '100%';
    div.appendChild(this._mapDiv);

    // Overlay holding the flow canvas + svg. Detached from the Leaflet transform panes
    // so it stays fixed to the viewport; the flow re-projects every move/zoom frame.
    this._overlay = document.createElement('div');
    this._overlay.className = 'flowmap-overlay';
    const config = (root: ISelex) => root.att.tabIndex(-1)
      .sty.pointer_events('none').sty.position('absolute').sty.visibility('inherit').sty.user_select('none');
    this._canvas = config(selex(this._overlay).append('canvas'));
    this._svg = config(selex(this._overlay).append('svg'));
    this._svgroot = this._svg.append('g').att.id('root');

    this._shim = this._buildShim();
  }

  private _buildShim(): IMapShim {
    const self = this;
    const size = () => self._lmap ? self._lmap.getSize() : L.point(self._mapDiv.clientWidth || 1, self._mapDiv.clientHeight || 1);
    return {
      getWidth: () => size().x,
      getHeight: () => size().y,
      getZoom: () => self._lmap ? self._lmap.getZoom() : self._zoom,
      getCenter: () => {
        const c = self._lmap ? self._lmap.getCenter() : L.latLng(20, 0);
        return { latitude: c.lat, longitude: c.lng };
      },
      getZoomRange: () => ({
        min: self._lmap ? self._lmap.getMinZoom() : 1,
        max: self._lmap ? self._lmap.getMaxZoom() : 19
      }),
      tryLocationToPixel: (loc, ref) => {
        const p = self._lmap.latLngToContainerPoint(L.latLng(loc.latitude, loc.longitude));
        if (ref === 'control') {
          return { x: p.x, y: p.y };
        }
        const s = size();
        return { x: p.x - s.x / 2, y: p.y - s.y / 2 };
      },
      tryPixelToLocation: (p, ref) => {
        let cx = p.x, cy = p.y;
        if (ref !== 'control') {
          const s = size();
          cx += s.x / 2;
          cy += s.y / 2;
        }
        const ll = self._lmap.containerPointToLatLng(L.point(cx, cy));
        return { latitude: ll.lat, longitude: ll.lng };
      },
      getRootElement: () => self._overlay,
      setView: v => {
        if (!self._lmap) { return; }
        const c = v.center || self.map.getCenter();
        const z = v.zoom === undefined ? self._lmap.getZoom() : v.zoom;
        self._lmap.setView([c.latitude, c.longitude], z, { animate: false });
      },
      setOptions: o => {
        if (!self._lmap) { return; }
        if (o.disablePanning !== undefined) {
          o.disablePanning ? self._lmap.dragging.disable() : self._lmap.dragging.enable();
        }
        if (o.disableZooming !== undefined) {
          const on = !o.disableZooming;
          const toggle = (h: { enable: () => void, disable: () => void }) => h && (on ? h.enable() : h.disable());
          toggle(self._lmap.scrollWheelZoom);
          toggle(self._lmap.touchZoom);
          toggle(self._lmap.doubleClickZoom);
          toggle(self._lmap.boxZoom);
          const zc = self._lmap.zoomControl && self._lmap.zoomControl.getContainer();
          if (zc) {
            zc.style.display = on ? '' : 'none';
          }
        }
      }
    };
  }

  // -------- projection helpers used by the flow renderer --------

  public location(p: IPoint): ILocation {
    return this._shim.tryPixelToLocation(p);
  }

  public setCenterZoom(center: ILocation, zoom: number) {
    if (!this._lmap) { return; }
    const { min, max } = this._shim.getZoomRange();
    zoom = Math.min(max, 20, Math.max(min, 1, zoom));
    this._lmap.setView([center.latitude, center.longitude], zoom, { animate: false });
  }

  public pixel(loc: ILocation | IBound, ref?: PixelRef): IPoint {
    if ((loc as IBound).anchor) {
      return anchorPixel(this._shim, loc as IBound);
    }
    return this._shim.tryLocationToPixel(loc as ILocation, ref);
  }

  public anchor(locs: ILocation[]) { return anchor(locs); }
  public area(locs: ILocation[], level = 20) { return area(locs, level); }
  public bound(locs: ILocation[]): IBound { return bound(locs); }

  public add(v: IListener) { this._listener.push(v); return this; }

  public fitView(areas: IBound[], backupCenter?: ILocation) {
    if (!this._lmap) { return; }
    areas = (areas || []).filter(a => !!a);
    if (areas.length === 0) {
      if (backupCenter) {
        this._lmap.setView([backupCenter.latitude, backupCenter.longitude], this._lmap.getZoom(), { animate: false });
      }
      return;
    }
    let n = -Infinity, s = Infinity, w = Infinity, e = -Infinity;
    for (const a of areas) {
      const { anchor: an, margin } = a;
      n = Math.max(n, an.latitude + margin.north);
      s = Math.min(s, an.latitude - margin.south);
      w = Math.min(w, an.longitude - margin.west);
      e = Math.max(e, an.longitude + margin.east);
    }
    n = clamp(n, -WORLD_LAT, WORLD_LAT);
    s = clamp(s, -WORLD_LAT, WORLD_LAT);
    const bounds = L.latLngBounds([s, w], [n, e]);
    if (bounds.isValid()) {
      this._lmap.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: false });
    }
    this._viewChange(false);
  }

  // -------- lifecycle --------

  restyle(fmt: Partial<IMapFormat>, then?: (m: IMapShim) => void): Controller {
    then = then || (() => { });
    const dirty = {} as Partial<IMapFormat>;
    for (const k in fmt) {
      if (fmt[k] !== this._fmt[k]) {
        dirty[k] = this._fmt[k] = fmt[k];
      }
    }
    if (!this._lmap) {
      this._create();
      this._applyFormat(true, null);
      this._resize();
      then(this._shim);
      return this;
    }
    if (keys(dirty).length === 0) {
      return this;
    }
    this._applyFormat(false, dirty);
    then(null);
    return this;
  }

  private _create(): void {
    const map = this._lmap = L.map(this._mapDiv, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: true,
      maxZoom: 19,
      worldCopyJump: false,
      preferCanvas: false,
      maxBounds: PAN_BOUNDS,
      maxBoundsViscosity: 1.0,
      // Discrete zoom keeps the custom flow overlay pixel-aligned with the basemap
      // (Leaflet's smooth zoom would transform only its own panes, not our overlay).
      zoomAnimation: false,
      markerZoomAnimation: false,
      fadeAnimation: true
    });
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution(MAP_ATTRIBUTION);

    const theme: MapStyle = this._fmt.style === 'light' ? 'light' : 'dark';
    this._gl = (L as unknown as { maplibreGL: (o: unknown) => GLLayer }).maplibreGL({
      style: STYLE_URLS[theme],
      attributionControl: false,
      transformRequest: glyphTransformRequest
    });
    this._gl.addTo(map);
    this._gl.getMaplibreMap().on('style.load', () => this._scheduleApply());

    // Overlay lives inside the Leaflet container but outside the transformed map-pane,
    // below the zoom control (z 1000) and above the basemap. Painted flow paths capture
    // hover; empty overlay area is pointer-events:none so drag reaches the map.
    const container = map.getContainer();
    this._overlay.style.position = 'absolute';
    this._overlay.style.left = '0';
    this._overlay.style.top = '0';
    this._overlay.style.width = '100%';
    this._overlay.style.height = '100%';
    this._overlay.style.zIndex = '450';
    this._overlay.style.pointerEvents = 'none';
    container.appendChild(this._overlay);

    this._buildStyleControl(container);

    map.on('move', () => this._viewChange(false));
    map.on('moveend', () => this._viewChange(true));
    map.on('zoom', () => this._viewChange(false));
    map.on('zoomend', () => this._viewChange(true));
    map.on('viewreset', () => this._viewChange(false));
    map.on('resize', () => this._resize());
    // Click on empty basemap (not on a flow/bubble, which stop propagation) → clear selection.
    map.on('click', () => this._onBgClick && this._onBgClick());

    // Power BI resizes the container without a window resize event and the visual's
    // update() bails out early on resize, so drive Leaflet's invalidateSize ourselves.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this._resize());
      ro.observe(this._div);
    }

    this._applyMinZoom();
    this._zoom = map.getZoom();
  }

  private _applyFormat(initial: boolean, dirty: Partial<IMapFormat> | null): void {
    if (initial || (dirty && 'style' in dirty)) {
      this._setStyle(this._fmt.style);
    } else {
      this._scheduleApply();
    }
    if (initial || (dirty && ('pan' in dirty))) {
      this._shim.setOptions({ disablePanning: !this._fmt.pan });
    }
    if (initial || (dirty && ('zoom' in dirty))) {
      this._shim.setOptions({ disableZooming: !this._fmt.zoom });
    }
    if (initial || (dirty && ('pan' in dirty || 'zoom' in dirty))) {
      // Leaflet's keyboard handler pans (arrows) and zooms (+/-); disable it unless both
      // pan and zoom are allowed, so "lock view" (pan=off, zoom=off) truly locks the map.
      const keyboardOn = this._fmt.pan && this._fmt.zoom;
      if (this._lmap && this._lmap.keyboard) {
        keyboardOn ? this._lmap.keyboard.enable() : this._lmap.keyboard.disable();
      }
    }
    this._setStyleControlVisible(!this._fmt.followTheme);
    this._syncStyleButtons();
  }

  private _setStyle(style: MapStyle): void {
    const theme: MapStyle = style === 'light' ? 'light' : 'dark';
    this._fmt.style = style;
    if (this._gl) {
      try {
        this._gl.getMaplibreMap().setStyle(STYLE_URLS[theme]);
      } catch {
        /* GL map not ready — the style.load binding re-applies on load */
      }
    }
    this._scheduleApply();
    this._syncStyleButtons();
  }

  /** Apply the recolour now and retry a few times — the GL style/sources can load late. */
  private _scheduleApply(): void {
    this._applyBasemap();
    for (const t of this._applyTimers) {
      window.clearTimeout(t);
    }
    this._applyTimers = [80, 300, 900, 2000].map(ms => window.setTimeout(() => this._applyBasemap(), ms));
  }

  /** Recolour the stock CARTO GL style: land = the "background" layer, ocean = "water"
   * layers; basemap labels get our font + a faded opacity. */
  private _applyBasemap(): void {
    if (!this._gl) { return; }
    const gl = this._gl.getMaplibreMap();
    if (!gl.isStyleLoaded()) { return; }
    const dark = this._fmt.style !== 'light';
    const land = dark ? this._fmt.landDark : this._fmt.landLight;
    const water = dark ? this._fmt.waterDark : this._fmt.waterLight;
    const opacity = Math.max(0, Math.min(1, (this._fmt.labelOpacity || 0) / 100));
    const style = gl.getStyle();
    const layers = style && style.layers ? style.layers : [];
    for (const layer of layers) {
      const id = layer.id as string;
      const type = layer.type as string;
      if (type === 'background') {
        gl.setPaintProperty(id, 'background-color', land);
      } else if (type === 'symbol') {
        try {
          gl.setLayoutProperty(id, 'text-font', [GLYPH_FONTSTACK]);
          gl.setPaintProperty(id, 'text-opacity', opacity);
        } catch {
          /* icon-only symbol layer — no text-font / text-opacity to set */
        }
      } else if ((layer['source-layer'] as string | undefined) === 'water') {
        if (type === 'fill') {
          gl.setPaintProperty(id, 'fill-color', water);
        } else if (type === 'line') {
          gl.setPaintProperty(id, 'line-color', water);
        }
      }
    }
  }

  // -------- on-map Dark/Light switcher --------

  private _buildStyleControl(container: HTMLElement): void {
    const control = document.createElement('div');
    control.className = 'flowmap-style-control';
    L.DomEvent.disableClickPropagation(control);
    L.DomEvent.disableScrollPropagation(control);
    const defs: Array<[MapStyle, string]> = [['dark', 'Dark'], ['light', 'Light']];
    for (const [style, label] of defs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = style === this._fmt.style ? 'active' : '';
      L.DomEvent.on(btn, 'click', e => {
        L.DomEvent.stop(e);
        this._setStyle(style);
        this.onStyleChanged && this.onStyleChanged(style);
      });
      this._styleButtons[style] = btn;
      control.appendChild(btn);
    }
    this._styleControl = control;
    container.appendChild(control);
  }

  private _syncStyleButtons(): void {
    for (const key in this._styleButtons) {
      const btn = this._styleButtons[key as MapStyle];
      btn.className = key === this._fmt.style ? 'active' : '';
    }
  }

  private _setStyleControlVisible(visible: boolean): void {
    if (this._styleControl) {
      this._styleControl.style.display = visible ? '' : 'none';
    }
  }

  // -------- viewport / listeners --------

  private _viewChange(end: boolean): void {
    if (!this._lmap) { return; }
    const zoom = this._lmap.getZoom();
    for (const l of this._listener) {
      l.transform && l.transform(this, this._zoom, end);
    }
    this._zoom = zoom;
  }

  private _resize(): void {
    if (!this._lmap) { return; }
    this._lmap.invalidateSize(false);
    const w = this._shim.getWidth(), h = this._shim.getHeight();
    this._svg.att.width('100%').att.height('100%');
    this._canvas && this._canvas.att.size(w, h);
    this._svgroot.att.translate(w / 2, h / 2);
    this._applyMinZoom();
    for (const l of this._listener) {
      l.resize && l.resize(this);
    }
  }

  /** Constrain min zoom so the world always fills the viewport vertically (no empty bands). */
  private _applyMinZoom(): void {
    const z = this._lmap.getBoundsZoom(FIT_BOUNDS, true);
    if (Number.isFinite(z) && z > 0) {
      this._lmap.setMinZoom(Math.min(z, 19));
    }
  }
}

/** Compatibility helper (re-exported through the barrel) — project a location to a pixel. */
export function pixel(map: IMapShim, loc: ILocation, ref?: PixelRef): IPoint {
  return map.tryLocationToPixel(loc, ref);
}
