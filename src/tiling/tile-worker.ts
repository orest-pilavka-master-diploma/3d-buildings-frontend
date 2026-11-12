/// <reference lib="webworker" />
/**
 * Tile Web Worker: fetches a batch of geohash tiles from the backend, parses the
 * JSON, groups the features back into tiles and builds each tile's merged
 * geometry. Only finished typed arrays travel back to the main thread (as
 * transferables, without copying), so the expensive work — JSON parsing,
 * polygon triangulation, facade UVs — never blocks map interaction or basemap
 * tile decoding.
 */
import { parseTilesPayload, tilesUrl } from '../api';
import { bucketFeatures, buildTileGeometry, tileTransferables, type TileBuildOptions, type TileGeometryData } from './tile-build';

/** A batch request from the {@link TileController}. */
export interface TileWorkerRequest {
  id: number;
  geohashes: string[];
  version: string | undefined;
  level: number;
  options: TileBuildOptions;
}

/** One built tile in a response. */
export interface BuiltTile {
  geohash: string;
  data: TileGeometryData;
}

export type TileWorkerResponse =
  | { id: number; ok: true; tiles: BuiltTile[] }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<TileWorkerRequest>) => {
  const { id, geohashes, version, level, options } = event.data;
  try {
    const response = await fetch(tilesUrl(geohashes, version), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Tile request failed with status ${response.status}`);
    }
    const collection = parseTilesPayload(await response.json());
    const groups = bucketFeatures(collection.features, geohashes, level);

    const tiles: BuiltTile[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const geohash of geohashes) {
      const data = buildTileGeometry(groups.get(geohash) ?? [], geohash, options);
      tiles.push({ geohash, data });
      transfer.push(...tileTransferables(data));
    }

    const message: TileWorkerResponse = { id, ok: true, tiles };
    scope.postMessage(message, transfer);
  } catch (error) {
    const message: TileWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(message);
  }
};
