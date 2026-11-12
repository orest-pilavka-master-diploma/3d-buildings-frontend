import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat } from '../geojson';

/**
 * Number of samples taken along each edge of the screen rectangle (including the
 * two corners). A denser perimeter better captures the curved far edge of the
 * trapezoid a tilted camera sees. 5 gives a 5x5-equivalent perimeter.
 */
const EDGE_SAMPLES = 5;

/**
 * HIGH-PITCH GUARD — top-of-screen clamp.
 *
 * At pitch ~65 the top rows of the canvas look toward the horizon, where
 * `map.unproject` returns points that race off to infinity. We therefore never
 * sample above this fraction of the canvas height measured from the TOP: the top
 * sampling row is placed at `TOP_SAMPLE_FRACTION * height` (the upper ~18% of the
 * screen is skipped), so no probe is taken in the horizon band.
 *
 * This clamp is PITCH-DEPENDENT (see {@link PITCH_CLAMP_THRESHOLD_DEG}): the
 * horizon band only appears under tilt, so in the flat 2D view (pitch ~0) the
 * whole screen is sampled and the top edge is not under-fetched.
 */
const TOP_SAMPLE_FRACTION = 0.18;

/**
 * Pitch (degrees) at or above which the {@link TOP_SAMPLE_FRACTION} top-row
 * clamp applies. Below this the camera is close enough to flat that the top of
 * the screen still projects to usable ground, so the full canvas height is
 * sampled. KNOB: lower to start guarding the horizon at a gentler tilt.
 */
const PITCH_CLAMP_THRESHOLD_DEG = 30;

/**
 * HIGH-PITCH GUARD — far-distance clamp (metres).
 *
 * A second safety net: any unprojected corner whose planar distance from the map
 * centre exceeds this many metres is treated as "beyond the visible ground" and
 * pulled back toward the centre to this radius. This catches the few probes that
 * still land implausibly far even after the top-row clamp.
 */
const MAX_GROUND_METRES = 6000;

const EARTH_RADIUS = 6_378_137;

/** Approximate planar distance in metres between two lng/lat points. */
function planarMetres(a: LngLat, b: LngLat): number {
  const latRad = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const east = ((b[0] - a[0]) * Math.PI) / 180 * EARTH_RADIUS * Math.cos(latRad);
  const north = ((b[1] - a[1]) * Math.PI) / 180 * EARTH_RADIUS;
  return Math.hypot(east, north);
}

/** Moves `point` toward `centre` so it sits at most `maxMetres` away from it. */
function clampToRadius(point: LngLat, centre: LngLat, maxMetres: number): LngLat {
  const distance = planarMetres(centre, point);
  if (distance <= maxMetres || distance === 0) {
    return point;
  }
  const ratio = maxMetres / distance;
  return [
    centre[0] + (point[0] - centre[0]) * ratio,
    centre[1] + (point[1] - centre[1]) * ratio,
  ];
}

/**
 * Projects the on-screen viewport to a ground polygon in `[lng, lat]` order,
 * respecting bearing (rotation) and pitch.
 *
 * It does NOT use `map.getBounds()`: at pitch 65 / bearing -55 the north-aligned
 * bbox wildly overstates what is visible. Instead it samples the screen
 * rectangle in CSS-pixel space (corners plus midpoints along each edge),
 * unprojects each sample to lng/lat, and returns them perimeter-ordered so the
 * result is the visible trapezoid.
 *
 * HIGH-PITCH GUARDS (see {@link TOP_SAMPLE_FRACTION} and {@link MAX_GROUND_METRES}):
 * the top sampling row is capped below the horizon band, and any sample landing
 * farther than {@link MAX_GROUND_METRES} from the map centre is clamped back
 * toward the centre.
 *
 * @param map the MapLibre map
 * @returns the perimeter-ordered visible ground polygon, or `[]` when unavailable
 */
export function visibleGroundPolygon(map: MapLibreMap): LngLat[] {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (width <= 0 || height <= 0) {
    return [];
  }

  const centreLngLat = map.getCenter();
  const centre: LngLat = [centreLngLat.lng, centreLngLat.lat];

  // The sampled rectangle spans the full width. Under tilt we start the top row
  // below the horizon band (TOP_SAMPLE_FRACTION); near-flat views (pitch below
  // PITCH_CLAMP_THRESHOLD_DEG, e.g. the 2D toggle) have no horizon to guard, so
  // the full canvas height is sampled and the top edge is not under-fetched.
  const clampTop = map.getPitch() >= PITCH_CLAMP_THRESHOLD_DEG;
  const top = clampTop ? height * TOP_SAMPLE_FRACTION : 0;
  const bottom = height;
  const left = 0;
  const right = width;

  /** Unprojects a CSS-pixel point and applies the far-distance clamp. */
  const sample = (x: number, y: number): LngLat => {
    const lngLat = map.unproject([x, y]);
    return clampToRadius([lngLat.lng, lngLat.lat], centre, MAX_GROUND_METRES);
  };

  const perimeter: LngLat[] = [];
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  // Top edge: left -> right.
  for (let i = 0; i < EDGE_SAMPLES; i += 1) {
    perimeter.push(sample(lerp(left, right, i / (EDGE_SAMPLES - 1)), top));
  }
  // Right edge: top -> bottom (skip the shared corner).
  for (let i = 1; i < EDGE_SAMPLES; i += 1) {
    perimeter.push(sample(right, lerp(top, bottom, i / (EDGE_SAMPLES - 1))));
  }
  // Bottom edge: right -> left (skip the shared corner).
  for (let i = 1; i < EDGE_SAMPLES; i += 1) {
    perimeter.push(sample(lerp(right, left, i / (EDGE_SAMPLES - 1)), bottom));
  }
  // Left edge: bottom -> top (skip both shared corners).
  for (let i = 1; i < EDGE_SAMPLES - 1; i += 1) {
    perimeter.push(sample(left, lerp(bottom, top, i / (EDGE_SAMPLES - 1))));
  }

  return perimeter;
}

/**
 * Expands a polygon outward from its centroid by `marginPct` so a ring of
 * just-offscreen tiles preloads. A `marginPct` of 0.2 pushes each vertex 20%
 * farther from the centroid.
 *
 * @param polygon perimeter-ordered `[lng, lat]` vertices
 * @param marginPct fractional outward expansion (e.g. 0.2 for +20%)
 * @returns the expanded polygon, or the input unchanged when it is degenerate
 */
export function expandPolygonAboutCentroid(
  polygon: ReadonlyArray<LngLat>,
  marginPct: number,
): LngLat[] {
  if (polygon.length < 3 || marginPct <= 0) {
    return [...polygon];
  }

  let centroidLng = 0;
  let centroidLat = 0;
  for (const [lng, lat] of polygon) {
    centroidLng += lng;
    centroidLat += lat;
  }
  centroidLng /= polygon.length;
  centroidLat /= polygon.length;

  const scale = 1 + marginPct;
  return polygon.map(([lng, lat]) => [
    centroidLng + (lng - centroidLng) * scale,
    centroidLat + (lat - centroidLat) * scale,
  ]);
}
