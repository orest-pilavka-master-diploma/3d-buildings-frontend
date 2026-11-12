import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Position,
} from 'geojson';

export type LngLat = [number, number];

export function isValidCoordinate(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function walkCoordinates(value: unknown, visit: (coordinate: LngLat) => boolean): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  if (isValidCoordinate(value)) {
    return visit([value[0], value[1]]);
  }

  for (const nested of value) {
    if (walkCoordinates(nested, visit)) {
      return true;
    }
  }

  return false;
}

function walkGeometry(geometry: Geometry | null, visit: (coordinate: LngLat) => boolean): boolean {
  if (!geometry) {
    return false;
  }

  if (geometry.type === 'GeometryCollection') {
    for (const nested of geometry.geometries) {
      if (walkGeometry(nested, visit)) {
        return true;
      }
    }
    return false;
  }

  return walkCoordinates(geometry.coordinates, visit);
}

export function extractFirstCoordinate(geometry: Geometry | null): LngLat | null {
  let first: LngLat | null = null;
  walkGeometry(geometry, (coordinate) => {
    first = coordinate;
    return true;
  });
  return first;
}

export function getGeoJSONCenter(geojson: FeatureCollection): LngLat | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const feature of geojson.features) {
    walkGeometry(feature.geometry, ([lng, lat]) => {
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
      return false;
    });
  }

  if (!Number.isFinite(minLng)) {
    return null;
  }

  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

export function normalizePopupValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return 'N/A';
  }
  return String(value);
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numericProperty(properties: GeoJsonProperties, key: string): number | null {
  const value = properties?.[key];
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

export function getFeatureHeight(properties: GeoJsonProperties): number {
  const height =
    numericProperty(properties, 'height') ??
    numericProperty(properties, 'building:height');
  if (height !== null) {
    return height;
  }

  const levels =
    numericProperty(properties, 'levels') ??
    numericProperty(properties, 'building:levels');
  return levels === null ? 10 : levels * 3;
}

export function getFeatureMinHeight(properties: GeoJsonProperties): number {
  return (
    numericProperty(properties, 'min_height') ??
    numericProperty(properties, 'building:min_height') ??
    0
  );
}


export function getFeatureAddress(
  feature: Feature<Geometry, GeoJsonProperties>,
): string {
  return normalizePopupValue(feature.properties?.address);
}
