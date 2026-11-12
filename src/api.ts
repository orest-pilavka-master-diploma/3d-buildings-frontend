import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

const BUILDINGS_ENDPOINT = '/backend/fetch-data';
const SEARCH_ENDPOINT = '/backend/search';
const TILES_ENDPOINT = '/backend/tiles';
const TILES_INFO_ENDPOINT = '/backend/tiles/info';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFeature(value: unknown): value is Feature<Geometry, GeoJsonProperties> {
  return isRecord(value) && value.type === 'Feature' && 'geometry' in value;
}

async function fetchJson(url: string, context: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Charset': 'utf-8',
    },
  });

  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

export async function loadBuildingsGeoJSON(): Promise<FeatureCollection> {
  const payload = await fetchJson(BUILDINGS_ENDPOINT, 'Building request');

  if (!isRecord(payload) || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
    throw new Error('Building response is not a GeoJSON FeatureCollection');
  }

  const features = payload.features;
  if (!features.every(isFeature)) {
    throw new Error('Building FeatureCollection contains an invalid feature');
  }

  return { type: 'FeatureCollection', features };
}

/** Tiling metadata reported by the backend's `/tiles/info` endpoint. */
export interface TilesInfo {
  /** Geohash level the backend stores leaves at (7). */
  storedLevel: number;
  /** Maximum geohashes a single `/tiles` request may ask for. */
  maxGeohashes: number;
  /** The dataset version served (newest when the request omits one). */
  version: string;
  /** Optional dataset centre, used to jump the camera on load. */
  center?: { lng: number; lat: number };
  /** Optional dataset bbox as [minLng, minLat, maxLng, maxLat]. */
  bbox?: [number, number, number, number];
}

/**
 * Fetches the buildings in the given geohash cells as one merged GeoJSON
 * FeatureCollection via `/backend/tiles`.
 *
 * An empty `geohashes` list short-circuits to an empty collection (no request).
 * Otherwise the comma-joined list (and optional version) is URL-encoded onto the
 * proxied endpoint and the response is validated to be a FeatureCollection whose
 * entries are all Features.
 *
 * @param geohashes the geohash cells to fetch
 * @param version optional dataset version; the backend defaults to newest
 * @returns the merged FeatureCollection
 */
export async function fetchTiles(
  geohashes: string[],
  version?: string,
): Promise<FeatureCollection> {
  if (geohashes.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const payload = await fetchJson(tilesUrl(geohashes, version), 'Tile request');
  return parseTilesPayload(payload);
}

/** The proxied `/tiles` URL for the given geohashes (and optional version). */
export function tilesUrl(geohashes: string[], version?: string): string {
  const params = new URLSearchParams();
  params.set('geohashes', geohashes.join(','));
  if (version) {
    params.set('version', version);
  }
  return `${TILES_ENDPOINT}?${params.toString()}`;
}

/**
 * Validates a `/tiles` response body as a FeatureCollection of Features.
 * Shared by {@link fetchTiles} and the tile Web Worker, which fetches on its own.
 */
export function parseTilesPayload(payload: unknown): FeatureCollection {
  if (!isRecord(payload) || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
    throw new Error('Tile response is not a GeoJSON FeatureCollection');
  }

  const features = payload.features;
  if (!features.every(isFeature)) {
    throw new Error('Tile FeatureCollection contains an invalid feature');
  }

  return { type: 'FeatureCollection', features };
}

/** Parses the optional `center` field of a `/tiles/info` payload, when well-formed. */
function parseCenter(value: unknown): { lng: number; lat: number } | undefined {
  if (
    isRecord(value) &&
    typeof value.lng === 'number' &&
    typeof value.lat === 'number' &&
    Number.isFinite(value.lng) &&
    Number.isFinite(value.lat)
  ) {
    return { lng: value.lng, lat: value.lat };
  }
  return undefined;
}

/** Parses the optional `bbox` field of a `/tiles/info` payload, when well-formed. */
function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [value[0], value[1], value[2], value[3]];
  }
  return undefined;
}

/**
 * Fetches tiling metadata from `/backend/tiles/info`.
 *
 * Validates that `storedLevel` and `maxGeohashes` are numbers and `version` is a
 * string; passes through optional `center`/`bbox` only when well-formed.
 *
 * @returns the parsed {@link TilesInfo}
 */
export async function fetchTilesInfo(): Promise<TilesInfo> {
  const payload = await fetchJson(TILES_INFO_ENDPOINT, 'Tiles info request');

  if (
    !isRecord(payload) ||
    typeof payload.storedLevel !== 'number' ||
    typeof payload.maxGeohashes !== 'number' ||
    typeof payload.version !== 'string'
  ) {
    throw new Error('Tiles info response is missing required fields');
  }

  return {
    storedLevel: payload.storedLevel,
    maxGeohashes: payload.maxGeohashes,
    version: payload.version,
    center: parseCenter(payload.center),
    bbox: parseBbox(payload.bbox),
  };
}

export async function searchAddresses(
  query: string,
): Promise<Array<Feature<Geometry, GeoJsonProperties>>> {
  const payload = await fetchJson(
    `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`,
    `Address search for "${query}"`,
  );

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter(isFeature);
}
