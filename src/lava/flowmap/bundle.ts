// Force-Directed Edge Bundling — Approach B: mean-attraction, near-only.
//
// Instead of the classic sum-of-unit-vectors electrostatic force (which overshoots and
// causes zigzag / instability on dense data), every subdivision point is pulled a bounded
// fraction (`blend`) of the way toward the MEAN position of the corresponding points on its
// compatible neighbours. Because the target is a convex combination of existing points, a
// point can never overshoot the group centroid, so the process is stable by construction.
//
// Compatibility is a hard gate: two edges bundle only when they (a) run in a similar
// direction (within `cone`), (b) pass NEAR each other (midpoint distance < proximity radius),
// and (c) roughly overlap along their shared direction (projection-overlap test). This keeps
// far-apart routes from interfering.
//
// A light Laplacian spring toward the average of an edge's OWN neighbouring points keeps the
// polyline smooth (no kinks), bounding the length blow-up.
//
// The algorithm is scale-sensitive, so `bundle` normalises internally to a ~1000-unit working
// box and maps the result back, making it scale-invariant.

export interface BEdge { x0: number; y0: number; x1: number; y1: number; }
export interface BPoint { x: number; y: number; }

export interface BundleOptions {
    /** compatibility threshold (0..1); only edge pairs above this interact */
    compatibility: number;
    /** global spring constant (Laplacian smoothing strength, 0..1) */
    K: number;
    /** number of cycles (subdivision doublings) */
    cycles: number;
    /** iterations in the first cycle (decreases each cycle) */
    iterations: number;
    /** attraction blend fraction toward the compatible-mean per iteration (0..1) */
    step: number;
    /** max subdivision points per edge (caps cost for long runs) */
    maxSubdivision: number;
    /** max compatible neighbours kept per edge (strongest first) — bounds O(E²) cost */
    maxNeighbors: number;
    /** directional "merge cone" (radians): only edges whose directions differ by less than
     *  this bundle together. Smaller = only near-parallel routes merge. */
    cone: number;
    /** proximity radius in normalised-box units (~1000 span): midpoints must be closer than
     *  this to be compatible. Keeps far routes from interfering. */
    proximity: number;
    /** per-point attraction radius in normalised units: when averaging a corridor, only include
     *  a neighbour's matching point if it lies within this distance of the current point. Stops
     *  short edges being dragged laterally onto a distant corridor (bounds length blow-up). */
    pointRadius: number;
    /** hard cap on how far a subdivision point may stray from its straight-line home position,
     *  as a fraction of the edge's own length. Directly bounds length blow-up: a shorter edge
     *  bends proportionally less, so it can never balloon. */
    maxOffsetFrac: number;
}

const DEFAULTS: BundleOptions = {
    compatibility: 0.6,
    K: 0.5,
    cycles: 5,
    iterations: 60,
    step: 0.5,           // attraction blend toward compatible-mean
    maxSubdivision: 40,
    maxNeighbors: 40,
    cone: 30 * Math.PI / 180,
    proximity: 70,       // in normalised (0..1000) units
    pointRadius: 60,     // per-point attraction cutoff in normalised units
    maxOffsetFrac: 0.34, // max lateral stray as a fraction of edge length
};

function len(e: BEdge): number {
    return Math.sqrt((e.x0 - e.x1) ** 2 + (e.y0 - e.y1) ** 2);
}

function dot(ax: number, ay: number, bx: number, by: number): number {
    return ax * bx + ay * by;
}

interface Neigh { j: number; flip: boolean; }

/** Precompute, for each edge, its compatible neighbours (index + whether traversed reversed).
 *  Gate = cone(direction) AND proximity(midpoint) AND projection-overlap. */
function compatibilityLists(
    edges: BEdge[], threshold: number, maxNeighbors: number, cone: number, proximity: number,
): Neigh[][] {
    const n = edges.length;
    const lists: Neigh[][] = new Array(n);
    const lengths = edges.map(len);
    const mids = edges.map(e => ({ x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 }));
    const vecs = edges.map(e => ({ x: e.x1 - e.x0, y: e.y1 - e.y0 }));
    const cap = maxNeighbors > 0 ? maxNeighbors : Infinity;
    const cosCone = Math.cos(Math.max(0, Math.min(Math.PI / 2, cone)));
    const prox2 = proximity * proximity;

    for (let i = 0; i < n; i++) {
        const li = lengths[i] || 1e-9;
        const cand: { j: number; flip: boolean; s: number }[] = [];
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const lj = lengths[j] || 1e-9;
            // signed cos of direction angle
            const cosSig = dot(vecs[i].x, vecs[i].y, vecs[j].x, vecs[j].y) / (li * lj);
            const ac = Math.abs(cosSig);
            if (ac < cosCone) continue; // outside merge cone → never bundle

            // proximity: midpoints must be near
            const dmx = mids[i].x - mids[j].x, dmy = mids[i].y - mids[j].y;
            const md2 = dmx * dmx + dmy * dmy;
            if (md2 > prox2) continue;

            // projection-overlap along edge i's direction: the two edges must share a stretch
            // of the corridor, not merely be two short segments that happen to be near+parallel
            // at their midpoints. Reject when one edge projects almost entirely off the other.
            const uix = vecs[i].x / li, uiy = vecs[i].y / li;
            const rx0 = edges[j].x0 - edges[i].x0, ry0 = edges[j].y0 - edges[i].y0;
            const rx1 = edges[j].x1 - edges[i].x0, ry1 = edges[j].y1 - edges[i].y0;
            const pj0 = rx0 * uix + ry0 * uiy;
            const pj1 = rx1 * uix + ry1 * uiy;
            const jlo = Math.min(pj0, pj1), jhi = Math.max(pj0, pj1);
            const ov = Math.min(li, jhi) - Math.max(0, jlo);
            const overlapFrac = ov / Math.min(li, lj);
            if (overlapFrac < 0.15) continue; // essentially disjoint corridors

            // scaled proximity score (near => ~1)
            const pc = 1 - Math.sqrt(md2) / proximity;
            const score = ac * Math.max(0, pc);
            if (score >= threshold * 0.5) {
                cand.push({ j, flip: cosSig < 0, s: score });
            }
        }
        if (cand.length > cap) {
            cand.sort((a, b) => b.s - a.s);
            cand.length = cap;
        }
        lists[i] = cand.map(c => ({ j: c.j, flip: c.flip }));
    }
    return lists;
}

/** Resample an edge's polyline to exactly P interior points (P+2 total incl. endpoints). */
function resample(e: BEdge, pts: BPoint[], P: number): BPoint[] {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        total += Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].y - pts[i - 1].y) ** 2);
    }
    const seg = total / (P + 1);
    const out: BPoint[] = [{ x: e.x0, y: e.y0 }];
    let curr = 1, remain = seg;
    let px = pts[0].x, py = pts[0].y;
    for (let k = 0; k < P; k++) {
        while (curr < pts.length) {
            const dx = pts[curr].x - px, dy = pts[curr].y - py;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < remain) {
                remain -= d; px = pts[curr].x; py = pts[curr].y; curr++;
            } else {
                const t = remain / (d || 1);
                px = px + dx * t; py = py + dy * t;
                out.push({ x: px, y: py });
                remain = seg;
                break;
            }
        }
    }
    out.push({ x: e.x1, y: e.y1 });
    while (out.length < P + 2) out.push({ x: e.x1, y: e.y1 });
    return out.slice(0, P + 2);
}

export function bundle(edgesIn: BEdge[], options?: Partial<BundleOptions>): BPoint[][] {
    const o = { ...DEFAULTS, ...(options || {}) };
    const edges = edgesIn;
    const n = edges.length;
    if (n === 0) return [];

    // --- normalise to a working box so params are scale-invariant ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of edges) {
        minX = Math.min(minX, e.x0, e.x1); maxX = Math.max(maxX, e.x0, e.x1);
        minY = Math.min(minY, e.y0, e.y1); maxY = Math.max(maxY, e.y0, e.y1);
    }
    const spanRaw = Math.max(maxX - minX, maxY - minY) || 1;
    const scale = 1000 / spanRaw;
    const nrm = (x: number, y: number): BPoint => ({ x: (x - minX) * scale, y: (y - minY) * scale });
    const work: BEdge[] = edges.map(e => {
        const a = nrm(e.x0, e.y0), b = nrm(e.x1, e.y1);
        return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    });

    // --- deduplicate coincident edges ---------------------------------------------------
    // The same route can appear many times (and in either orientation). If we bundle each copy
    // independently, Gauss-Seidel ordering makes near-identical curves drift slightly apart —
    // visually invisible but it wrecks any midpoint-convergence metric (division by ~0). We bundle
    // one representative per unique route and copy its polyline (re-oriented) onto the duplicates.
    const rep: number[] = new Array(n);        // representative unique-index for each input edge
    const sameOrient: boolean[] = new Array(n); // does input edge match its representative's orientation?
    const uniq: number[] = [];                 // work indices of unique representatives
    const uPos: number[] = new Array(n);       // position of a representative within `uniq`
    {
        const keyToU = new Map<string, number>();
        const q = (v: number) => Math.round(v * 1000) / 1000; // 0.001 normalised-unit grid
        for (let i = 0; i < n; i++) {
            const e = work[i];
            let ax = e.x0, ay = e.y0, bx = e.x1, by = e.y1;
            if (bx < ax || (bx === ax && by < ay)) { ax = e.x1; ay = e.y1; bx = e.x0; by = e.y0; }
            const key = q(ax) + ',' + q(ay) + ',' + q(bx) + ',' + q(by);
            const found = keyToU.get(key);
            if (found === undefined) {
                keyToU.set(key, i);
                uPos[i] = uniq.length;
                uniq.push(i);
                rep[i] = i;
                sameOrient[i] = true;
            } else {
                rep[i] = found;
                // does this duplicate run the same way round as its representative?
                sameOrient[i] = Math.abs(e.x0 - work[found].x0) < 1e-6 && Math.abs(e.y0 - work[found].y0) < 1e-6;
            }
        }
    }
    const uwork: BEdge[] = uniq.map(i => work[i]);
    const un = uwork.length;

    const compat = compatibilityLists(uwork, o.compatibility, o.maxNeighbors, o.cone, o.proximity);

    let subdiv: BPoint[][] = uwork.map(e => [{ x: e.x0, y: e.y0 }, { x: e.x1, y: e.y1 }]);

    let P = 1;
    let I = o.iterations;
    let blend = o.step;      // attraction blend toward compatible-mean
    const Ks = o.K;          // Laplacian smoothing strength
    const pr2 = o.pointRadius > 0 ? o.pointRadius * o.pointRadius : Infinity;
    // Keep the subdivision cap ODD. P grows as 1,3,7,15,… (always odd); if a caller caps at an
    // even number, min(P, cap) could land on an even count, which shifts the exact-middle point
    // off the true 50% mark. Rounding the cap down to odd keeps the midpoint centred.
    const cap = o.maxSubdivision > 0
        ? (o.maxSubdivision % 2 === 0 ? o.maxSubdivision - 1 : o.maxSubdivision)
        : Infinity;

    // per-unique-edge straight geometry (for the home-offset clamp)
    const uLen = uwork.map(len);
    const maxOff = uLen.map(L => (o.maxOffsetFrac > 0 ? o.maxOffsetFrac * L : Infinity));

    for (let cycle = 0; cycle < o.cycles; cycle++) {
        subdiv = subdiv.map((pts, i) => resample(uwork[i], pts, Math.min(P, cap)));
        const Pc = Math.min(P, cap);

        // Endpoint taper: attraction is 0 at the endpoints and 1 at the midpoint, so routes
        // leave their endpoints straight and merge gently in the middle (airline-map "split
        // near endpoints" look). This removes the sharp near-endpoint kinks that dominate the
        // length blow-up, while the midpoint (where the metric samples) keeps full attraction.
        const taper = new Array(Pc + 2);
        for (let k = 0; k <= Pc + 1; k++) {
            taper[k] = Math.sin(Math.PI * k / (Pc + 1)); // 0 at ends, 1 at centre
        }

        for (let iter = 0; iter < I; iter++) {
            // Gauss-Seidel in-place update.
            for (let i = 0; i < un; i++) {
                const pts = subdiv[i];
                const cl = compat[i];
                const e = uwork[i];
                const off = maxOff[i];
                for (let k = 1; k <= Pc; k++) {
                    const pk = pts[k];
                    // straight-line "home" for this point (endpoints are fixed & straight)
                    const t = k / (Pc + 1);
                    const homeX = e.x0 + (e.x1 - e.x0) * t;
                    const homeY = e.y0 + (e.y1 - e.y0) * t;

                    // --- mean-attraction toward compatible neighbours' matching points ---
                    // Only points within `pr` of pk join the average, so a short edge merges only
                    // with corridor points genuinely beside it — never dragged across the map.
                    let mx = 0, my = 0, m = 0;
                    for (let c = 0; c < cl.length; c++) {
                        const nb = cl[c];
                        const idx = nb.flip ? (Pc + 1 - k) : k;
                        const q = subdiv[nb.j][idx];
                        const ddx = q.x - pk.x, ddy = q.y - pk.y;
                        if (ddx * ddx + ddy * ddy > pr2) continue;
                        mx += q.x; my += q.y; m++;
                    }

                    // --- Laplacian smoothing toward mean of own neighbours ---
                    const lapx = 0.5 * (pts[k - 1].x + pts[k + 1].x);
                    const lapy = 0.5 * (pts[k - 1].y + pts[k + 1].y);

                    let nx = pk.x + Ks * (lapx - pk.x);
                    let ny = pk.y + Ks * (lapy - pk.y);
                    if (m > 0) {
                        const b = blend * taper[k];
                        const cxx = mx / m, cyy = my / m;
                        nx += b * (cxx - pk.x);
                        ny += b * (cyy - pk.y);
                    }
                    // hard clamp: keep the point within `off` of its straight-line home
                    const ox = nx - homeX, oy = ny - homeY;
                    const od = Math.sqrt(ox * ox + oy * oy);
                    if (od > off) {
                        const s = off / od;
                        nx = homeX + ox * s; ny = homeY + oy * s;
                    }
                    pk.x = nx; pk.y = ny;
                }
            }
        }
        // Keep interior-point counts ODD (1,3,7,15,31,…) so the exact middle point stays at
        // 50% arc-length — otherwise the geometric midpoint drifts as resolution grows.
        P = 2 * P + 1;
        I = Math.max(1, Math.round(I * 0.6667));
        blend *= 0.85; // ease attraction as resolution grows (keeps fine detail smooth)
    }

    // --- map back to original coordinates, expanding duplicates ---
    const inv = (p: BPoint): BPoint => ({ x: p.x / scale + minX, y: p.y / scale + minY });
    const out: BPoint[][] = new Array(n);
    for (let i = 0; i < n; i++) {
        const src = subdiv[uPos[rep[i]]];
        const poly = sameOrient[i] ? src : src.slice().reverse();
        // pin endpoints to this edge's exact originals (duplicates share geometry, but be safe)
        const mapped = poly.map(inv);
        mapped[0] = { x: edges[i].x0, y: edges[i].y0 };
        mapped[mapped.length - 1] = { x: edges[i].x1, y: edges[i].y1 };
        out[i] = mapped;
    }
    return out;
}
