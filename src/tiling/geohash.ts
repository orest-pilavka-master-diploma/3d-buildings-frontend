import type { LngLat } from '../geojson';

/**
 * Hand-rolled, dependency-free geohash math.
 *
 * The encoder reproduces the exact bit layout the backend's
 * {@code TileService.decodeGeohashBox} uses, so a geohash computed here
 * addresses the same cell the compiler stored and the backend serves:
 * - alphabet {@link GEOHASH_ALPHABET} = `0123456789bcdefghjkmnpqrstuvwxyz`;
 * - `even` starts `true`, `even` bits refine LONGITUDE, odd bits refine LATITUDE;
 * - within each 5-bit symbol the mask walks MSB-first (16, 8, 4, 2, 1).
 */

/** Base-32 geohash alphabet (no a, i, l, o), identical to the backend. */
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/** A decoded geohash cell's lat/lng bounds. */
export interface GeohashBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Encodes a latitude/longitude to a geohash string of the given level.
 *
 * Mirrors the backend decode exactly (longitude-first even/odd interleave,
 * MSB-first mask) so the produced hash is the prefix (coarser) or extension
 * (finer) of the leaves the compiler wrote at the stored level.
 *
 * @param lat latitude in degrees, clamped to [-90, 90]
 * @param lng longitude in degrees, clamped to [-180, 180]
 * @param level number of base-32 characters to emit (must be >= 1)
 * @returns the lowercase geohash of length `level`
 */
export function encodeGeohash(lat: number, lng: number, level: number): string {
  const safeLevel = Math.max(1, Math.floor(level));
  const clampedLat = Math.min(90, Math.max(-90, lat));
  const clampedLng = Math.min(180, Math.max(-180, lng));

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let even = true;
  let bit = 0;
  let charIndex = 0;
  let hash = '';

  while (hash.length < safeLevel) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (clampedLng >= mid) {
        charIndex = (charIndex << 1) | 1;
        lngMin = mid;
      } else {
        charIndex = charIndex << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (clampedLat >= mid) {
        charIndex = (charIndex << 1) | 1;
        latMin = mid;
      } else {
        charIndex = charIndex << 1;
        latMax = mid;
      }
    }
    even = !even;

    bit += 1;
    if (bit === 5) {
      hash += GEOHASH_ALPHABET.charAt(charIndex);
      bit = 0;
      charIndex = 0;
    }
  }

  return hash;
}

/**
 * Decodes a geohash to its lat/lng cell bounds. Replays the same interleave the
 * encoder (and the backend) use.
 *
 * @param hash a non-empty geohash string
 * @returns the cell bounds; invalid characters are skipped like the backend does
 */
export function geohashBounds(hash: string): GeohashBounds {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let even = true;

  for (let i = 0; i < hash.length; i += 1) {
    const cd = GEOHASH_ALPHABET.indexOf(hash.charAt(i).toLowerCase());
    if (cd < 0) {
      continue;
    }
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if ((cd & mask) !== 0) {
          lngMin = mid;
        } else {
          lngMax = mid;
        }
      } else {
        const mid = (latMin + latMax) / 2;
        if ((cd & mask) !== 0) {
          latMin = mid;
        } else {
          latMax = mid;
        }
      }
      even = !even;
    }
  }

  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax };
}

/** The lat/lng centre of a geohash cell. */
export function geohashCenter(hash: string): { lat: number; lng: number } {
  const bounds = geohashBounds(hash);
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lng: (bounds.minLng + bounds.maxLng) / 2,
  };
}

/** Longitude bits consumed by a geohash of `level` characters (lng is refined first). */
function longitudeBits(level: number): number {
  return Math.ceil((5 * level) / 2);
}

/** Latitude bits consumed by a geohash of `level` characters. */
function latitudeBits(level: number): number {
  return Math.floor((5 * level) / 2);
}

/** The lng/lat cell size (degrees) for a given geohash level. */
function cellSize(level: number): { lngStep: number; latStep: number } {
  return {
    lngStep: 360 / Math.pow(2, longitudeBits(level)),
    latStep: 180 / Math.pow(2, latitudeBits(level)),
  };
}

/**
 * Ray-casting point-in-polygon test for a lng/lat point against a lng/lat ring.
 *
 * The ring is treated as closed; the point counts as inside when a ray cast to
 * +lng crosses an odd number of edges.
 */
function pointInPolygon(lng: number, lat: number, polygon: ReadonlyArray<LngLat>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Enumerates every geohash cell at `level` that OVERLAPS the given ground
 * polygon (not merely cells whose centre is inside it).
 *
 * The polygon is supplied in `[lng, lat]` order. We compute its lng/lat bbox,
 * snap the south-west corner down to the geohash cell grid, then walk the grid
 * cells across the bbox (one cell past each edge so partially covered cells are
 * seen). A cell is kept when its box overlaps the polygon, tested as: the
 * cell centre is inside the polygon, OR any polygon vertex is inside the cell
 * box. The second condition is essential when zoomed in: at a coarse level the
 * whole viewport can sit inside ONE large cell whose centre is far outside the
 * tiny polygon — without it that cell (the one under the camera) would be
 * dropped and its buildings would vanish. Results are de-duplicated.
 *
 * @param polygonLngLat perimeter-ordered `[lng, lat]` vertices of the visible ground
 * @param level geohash level to enumerate at
 * @returns the unique geohashes overlapping the polygon
 */
export function enumerateGeohashesInPolygon(
  polygonLngLat: ReadonlyArray<LngLat>,
  level: number,
): string[] {
  if (polygonLngLat.length < 3) {
    return [];
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of polygonLngLat) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    return [];
  }

  const { lngStep, latStep } = cellSize(level);
  if (lngStep <= 0 || latStep <= 0) {
    return [];
  }

  // Snap the start to the cell grid so each step aligns with a real cell box.
  const startLng = Math.floor(minLng / lngStep) * lngStep;
  const startLat = Math.floor(minLat / latStep) * latStep;

  const result = new Set<string>();
  // Walk one cell past the NE corner so partially covered edge cells are seen.
  for (let lat = startLat; lat <= maxLat + latStep; lat += latStep) {
    const cellMinLat = lat;
    const cellMaxLat = lat + latStep;
    const centreLat = lat + latStep / 2;
    for (let lng = startLng; lng <= maxLng + lngStep; lng += lngStep) {
      const cellMinLng = lng;
      const cellMaxLng = lng + lngStep;
      const centreLng = lng + lngStep / 2;

      // Kept when the cell box overlaps the polygon: centre inside the polygon,
      // or any polygon vertex inside this cell box (covers the zoomed-in case
      // where the whole view lies within one coarse cell).
      let overlaps = pointInPolygon(centreLng, centreLat, polygonLngLat);
      if (!overlaps) {
        for (const [vLng, vLat] of polygonLngLat) {
          if (
            vLng >= cellMinLng &&
            vLng < cellMaxLng &&
            vLat >= cellMinLat &&
            vLat < cellMaxLat
          ) {
            overlaps = true;
            break;
          }
        }
      }

      if (overlaps) {
        result.add(encodeGeohash(centreLat, centreLng, level));
      }
    }
  }

  return [...result];
}
