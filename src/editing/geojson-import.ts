import { isValidCoordinate, type LngLat } from '../geojson';

/** One extruded footprint parsed from an uploaded GeoJSON file. */
export interface ImportedFootprint {
  ring: LngLat[];
  height: number;
  minHeight: number;
}

/** Outcome of parsing an uploaded GeoJSON: either footprints or a Ukrainian error. */
export type ImportResult =
  | { ok: true; footprints: ImportedFootprint[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a required positive numeric property, or null when absent/invalid. */
function readHeight(properties: unknown, key: string): number | null {
  if (!isRecord(properties)) {
    return null;
  }
  const raw = properties[key];
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Reads an optional non-negative numeric property, defaulting to 0. */
function readMinHeight(properties: unknown): number {
  if (!isRecord(properties)) {
    return 0;
  }
  const raw = properties.minHeight ?? properties.min_height;
  if (raw === undefined || raw === null || raw === '') {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * A human label for a feature in validation messages: its GeoJSON id (top-level
 * `id` or `properties.id`) when present, otherwise its 1-based position.
 */
function featureLabel(feature: unknown, index: number): string {
  if (isRecord(feature)) {
    const topId = feature.id;
    if (typeof topId === 'string' || typeof topId === 'number') {
      return `Об’єкт "${topId}"`;
    }
    if (isRecord(feature.properties)) {
      const propId = feature.properties.id;
      if (typeof propId === 'string' || typeof propId === 'number') {
        return `Об’єкт "${propId}"`;
      }
    }
  }
  return `Об’єкт №${index + 1}`;
}

/** Drops a duplicated closing vertex so the stored ring is an open loop. */
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

/** Extracts the outer ring of one polygon coordinate array as valid LngLat points. */
function outerRing(polygon: unknown): LngLat[] | null {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return null;
  }
  const outer = polygon[0];
  if (!Array.isArray(outer)) {
    return null;
  }
  const ring: LngLat[] = [];
  for (const coordinate of outer) {
    if (isValidCoordinate(coordinate)) {
      ring.push([coordinate[0], coordinate[1]]);
    }
  }
  const opened = openRing(ring);
  return opened.length >= 3 ? opened : null;
}

/**
 * Parses an uploaded GeoJSON document into extrudable footprints. Validation is
 * strict and atomic: the whole file is rejected (with a Ukrainian message) if it
 * is not valid GeoJSON, if any feature's geometry is not Polygon/MultiPolygon,
 * or if any feature lacks a positive numeric `height` property. A MultiPolygon
 * expands into one footprint per contained polygon.
 */
export function parseUploadedGeoJSON(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Файл не є коректним JSON.' };
  }

  if (!isRecord(parsed) || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    return { ok: false, error: 'Файл має бути GeoJSON FeatureCollection.' };
  }

  const features = parsed.features;
  if (features.length === 0) {
    return { ok: false, error: 'У файлі немає жодного об’єкта.' };
  }

  const footprints: ImportedFootprint[] = [];

  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const label = featureLabel(feature, index);

    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.geometry)) {
      return { ok: false, error: `${label}: некоректна структура об’єкта.` };
    }

    const geometry = feature.geometry;
    const type = geometry.type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') {
      return {
        ok: false,
        error: `${label}: геометрія має бути Polygon або MultiPolygon (отримано ${String(type)}).`,
      };
    }

    const height = readHeight(feature.properties, 'height');
    if (height === null) {
      return {
        ok: false,
        error: `${label}: відсутня або некоректна властивість "height" (потрібне додатне число).`,
      };
    }
    const minHeight = readMinHeight(feature.properties);

    const polygons = type === 'Polygon'
      ? [geometry.coordinates]
      : (geometry.coordinates as unknown[]);

    let addedForFeature = 0;
    for (const polygon of polygons) {
      const ring = outerRing(polygon);
      if (ring) {
        footprints.push({ ring, height, minHeight });
        addedForFeature += 1;
      }
    }

    if (addedForFeature === 0) {
      return { ok: false, error: `${label}: геометрія не містить коректного полігону.` };
    }
  }

  return { ok: true, footprints };
}
