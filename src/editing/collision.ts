import type { FeatureCollection } from 'geojson';
import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping';
import { isValidCoordinate, type LngLat } from '../geojson';
import { fromLocalMetres, localFrame, toLocalMetres } from '../local-frame';

/** Area below which a clipping result is treated as a shared edge or point touch. */
const MIN_OVERLAP_AREA = 1e-12;

/** Signed area of a ring via the shoelace formula; sign depends on winding. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Closes an open ring into a polygon-clipping Polygon (single outer ring). */
function toClosedPolygon(ring: LngLat[]): Polygon {
  const closed: Ring = ring.map(([lng, lat]) => [lng, lat] as [number, number]);
  if (closed.length > 0) {
    const first = closed[0];
    const last = closed[closed.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      closed.push([first[0], first[1]]);
    }
  }
  return [closed];
}

/**
 * True when rings `a` and `b` share a positive-area region. Shared edges and
 * single-point touches (which yield zero-area results) are not overlaps.
 */
export function ringsOverlap(a: LngLat[], b: LngLat[]): boolean {
  if (a.length < 3 || b.length < 3) {
    return false;
  }

  const result = polygonClipping.intersection(toClosedPolygon(a), toClosedPolygon(b));
  for (const polygon of result) {
    for (const ring of polygon) {
      if (Math.abs(signedArea(ring)) > MIN_OVERLAP_AREA) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Rotates a footprint ring by `rotationDeg` about its centroid, mirroring
 * ThreeBuildingsLayer.rotatePointsAboutCentroid so the collision candidate
 * matches the mesh that is actually extruded.
 *
 * The layer rotates in the local metre frame (x=east, y=north) about the
 * centroid of the metre points, counter-clockwise for positive degrees. This
 * reproduces that transform: it converts each vertex to local east/north metres
 * relative to `center`, rotates about the metre centroid, then converts back to
 * lng/lat with the exact inverse of the same frame.
 */
export function rotateRingAboutCentroid(
  ring: LngLat[],
  rotationDeg: number,
  center: LngLat,
): LngLat[] {
  if (rotationDeg === 0 || ring.length === 0) {
    return ring;
  }

  // Same lng/lat <-> metre frame the 3D layer extrudes in (see local-frame.ts).
  const frame = localFrame(center);
  const toMetres = ([lng, lat]: LngLat): [number, number] => toLocalMetres(frame, lng, lat);
  const toLngLat = (east: number, north: number): LngLat => fromLocalMetres(frame, east, north);

  const metres = ring.map(toMetres);
  let centroidEast = 0;
  let centroidNorth = 0;
  for (const [east, north] of metres) {
    centroidEast += east;
    centroidNorth += north;
  }
  centroidEast /= metres.length;
  centroidNorth /= metres.length;

  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return metres.map(([east, north]) => {
    const dx = east - centroidEast;
    const dy = north - centroidNorth;
    return toLngLat(
      centroidEast + dx * cos - dy * sin,
      centroidNorth + dx * sin + dy * cos,
    );
  });
}

/** Lng/lat bounding box of a ring as [minLng, minLat, maxLng, maxLat]. */
function ringBounds(ring: LngLat[]): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Returns the ids of `others` whose rings overlap the candidate ring.
 *
 * A cheap bounding-box test runs first, so the exact (and expensive) polygon
 * intersection only runs for the few buildings next to the candidate instead of
 * for every loaded backend building on every mouse move.
 */
export function findConflicts(
  candidate: LngLat[],
  others: ReadonlyArray<{ id: string; ring: LngLat[] }>,
): string[] {
  const conflicts: string[] = [];
  if (candidate.length < 3) {
    return conflicts;
  }
  const [minLng, minLat, maxLng, maxLat] = ringBounds(candidate);
  for (const other of others) {
    const [oMinLng, oMinLat, oMaxLng, oMaxLat] = ringBounds(other.ring);
    if (oMaxLng < minLng || oMinLng > maxLng || oMaxLat < minLat || oMinLat > maxLat) {
      continue;
    }
    if (ringsOverlap(candidate, other.ring)) {
      conflicts.push(other.id);
    }
  }
  return conflicts;
}

/** Drops a duplicated closing point if the ring is explicitly closed. */
function openRing(ring: LngLat[]): LngLat[] {
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

/**
 * Walks Polygon and MultiPolygon features, mirroring
 * ThreeBuildingsLayer.addGeoJSONBuildings (Polygon -> coordinates[0],
 * MultiPolygon -> each polygon's [0]), and returns their outer rings as
 * LngLat arrays with synthesised ids.
 */
export function extractBackendRings(
  geojson: FeatureCollection,
): { id: string; ring: LngLat[] }[] {
  const rings: { id: string; ring: LngLat[] }[] = [];

  geojson.features.forEach((feature, featureIndex) => {
    const geometry = feature.geometry;
    const polygons = geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];

    polygons.forEach((polygon, polygonIndex) => {
      const outer = polygon[0];
      if (!outer) {
        return;
      }

      const ring: LngLat[] = [];
      for (const coordinate of outer) {
        if (isValidCoordinate(coordinate)) {
          ring.push([coordinate[0], coordinate[1]]);
        }
      }

      const opened = openRing(ring);
      if (opened.length >= 3) {
        rings.push({ id: `backend-${featureIndex}-${polygonIndex}`, ring: opened });
      }
    });
  });

  return rings;
}
