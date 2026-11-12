import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat } from '../geojson';
import { geohashCenter, enumerateGeohashesInPolygon } from './geohash';
import type { CollisionRing, FacadeMetrics, TileGeometryData } from './tile-build';
import type { BuiltTile, TileWorkerRequest, TileWorkerResponse } from './tile-worker';
import { expandPolygonAboutCentroid, visibleGroundPolygon } from './viewport';

/* ------------------------------------------------------------------------- *
 * Tuning knobs. All constants below are deliberately grouped and documented
 * so a reviewer or maintainer can retune the streaming behaviour in one place.
 * ------------------------------------------------------------------------- */

/** Coarsest geohash level, used when zoomed out. */
export const MIN_LEVEL = 5;
/**
 * Finest geohash level, used when zoomed in. The backend prefix-merges any
 * request coarser than its stored level, so capping here keeps the tile count
 * low while staying complete.
 */
export const MAX_LEVEL = 6;

/**
 * Per-level cap on how many geohash tiles are held/requested at once. KNOB:
 * raise for denser coverage at the cost of more meshes and fetches; lower to
 * cut memory and bandwidth. Keyed by level; finer levels cover less ground per
 * tile so they get a larger budget.
 */
export const MAX_GEOHASHES_PER_LEVEL: Record<number, number> = {
  5: 40,
  6: 200,
};

/**
 * Outward viewport expansion (per level) so a ring of just-offscreen tiles
 * preloads. KNOB, keyed by geohash level.
 */
export const VIEWPORT_MARGIN_PCT_BY_LEVEL: Record<number, number> = {
  5: 0.15,
  6: 0.5,
};
/** Fallback margin for any level not listed above. */
const DEFAULT_VIEWPORT_MARGIN_PCT = 0.25;

/**
 * Debounce window (ms) coalescing move/zoom/rotate/pitch bursts into one
 * refresh. KNOB: higher = fewer fetches but laggier streaming.
 */
export const DEBOUNCE_MS = 200;

/**
 * Fixed geohash level used for every zoom when set. KNOB: set to a level to
 * stream at one static level regardless of zoom; set to `null` to derive the
 * level from zoom via {@link ZOOM_LEVEL_TABLE}.
 */
export const STATIC_LEVEL: number | null = 6;

/**
 * Tiles per `/tiles` request. KNOB: smaller batches show the nearest buildings
 * sooner and spread geometry building over several workers; larger batches
 * mean fewer HTTP requests.
 */
export const TILES_PER_REQUEST = 2;

/** Maximum `/tiles` requests in flight at once. KNOB. */
export const MAX_CONCURRENT_REQUESTS = 4;

/** Minimum time (ms) between collision-ring republishes while tiles stream in. */
const RINGS_PUBLISH_INTERVAL_MS = 300;

/**
 * Zoom -> geohash level threshold table. KNOB: each entry is
 * `{ maxZoom, level }`; the first row whose `maxZoom` the current zoom is below
 * wins, otherwise MAX_LEVEL.
 */
const ZOOM_LEVEL_TABLE: ReadonlyArray<{ maxZoom: number; level: number }> = [
  { maxZoom: 15, level: MIN_LEVEL },
];

/**
 * Maps a MapLibre zoom to a geohash level, clamped to [{@link MIN_LEVEL},
 * {@link MAX_LEVEL}]. Higher zoom yields a finer level.
 */
export function zoomToLevel(zoom: number): number {
  if (STATIC_LEVEL !== null) {
    return clampLevel(STATIC_LEVEL);
  }
  for (const row of ZOOM_LEVEL_TABLE) {
    if (zoom < row.maxZoom) {
      return clampLevel(row.level);
    }
  }
  return MAX_LEVEL;
}

/** Clamps a level into the valid [MIN_LEVEL, MAX_LEVEL] range. */
function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
}

/** The subset of the Three layer the controller drives. */
export interface TileLayerAccessors {
  hasBackendTile(geohash: string): boolean;
  addBackendTileData(geohash: string, data: TileGeometryData): void;
  removeBackendTile(geohash: string): void;
}

/** Constructor options for {@link TileController}. */
export interface TileControllerOptions {
  map: MapLibreMap;
  layer: TileLayerAccessors;
  version: string | undefined;
  /** Origin of the layer's local metre frame; tile geometry is built relative to it. */
  center: LngLat;
  /** Facade UV pitches baked into the tile geometry. */
  facade: FacadeMetrics;
  /**
   * The backend's advertised per-request geohash limit (from `/tiles/info`),
   * when known. Each level's effective cap is clamped to it.
   */
  maxGeohashes?: number;
  /**
   * Notified after tiles are added/removed with the fresh union of backend
   * collision rings and the count of loaded tiles.
   */
  onTilesChanged(backendRings: CollisionRing[], loadedCount: number): void;
}

/**
 * A small pool of tile Web Workers. Each worker fetches its batch from the
 * backend and returns finished merged geometry, so JSON parsing and polygon
 * triangulation never run on the main thread.
 */
class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly busy: number[] = [];
  private readonly pending = new Map<number, { resolve(tiles: BuiltTile[]): void; reject(error: Error): void }>();
  private nextId = 1;

  constructor(size: number) {
    for (let i = 0; i < size; i += 1) {
      const worker = new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TileWorkerResponse>) => {
        this.busy[i] -= 1;
        const message = event.data;
        const entry = this.pending.get(message.id);
        if (!entry) {
          return;
        }
        this.pending.delete(message.id);
        if (message.ok) {
          entry.resolve(message.tiles);
        } else {
          entry.reject(new Error(message.error));
        }
      };
      this.workers.push(worker);
      this.busy.push(0);
    }
  }

  /** Sends one batch to the least busy worker. */
  request(request: Omit<TileWorkerRequest, 'id'>): Promise<BuiltTile[]> {
    let index = 0;
    for (let i = 1; i < this.workers.length; i += 1) {
      if (this.busy[i] < this.busy[index]) {
        index = i;
      }
    }
    const id = this.nextId++;
    this.busy[index] += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: TileWorkerRequest = { ...request, id };
      this.workers[index].postMessage(message);
    });
  }

  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Tile worker pool disposed'));
    }
    this.pending.clear();
  }
}

/**
 * Drives geohash-tiled, frustum-accurate, viewport incremental loading.
 *
 * On a debounced burst of move/zoom/rotate/pitch events it picks a geohash
 * level from the zoom, enumerates the cells covering the margin-expanded
 * visible ground, caps them per level (closest-to-centre wins), evicts tiles
 * that left the target set, then streams in the missing cells nearest-first in
 * small batches built by Web Workers. Each batch is shown as soon as it
 * arrives. A new viewport event cancels the batches not yet requested.
 */
export class TileController {
  private readonly map: MapLibreMap;
  private readonly layer: TileLayerAccessors;
  private readonly version: string | undefined;
  private readonly center: LngLat;
  private readonly facade: FacadeMetrics;
  /** Backend per-request geohash limit; undefined when `/tiles/info` lacked it. */
  private readonly maxGeohashes: number | undefined;
  private readonly onTilesChanged: TileControllerOptions['onTilesChanged'];
  private readonly pool: TileWorkerPool;

  /** Geohashes currently on the map (possibly empty cells). */
  private readonly loaded = new Set<string>();
  /** Collision rings per loaded tile, so the union can be rebuilt cheaply. */
  private readonly tileRings = new Map<string, CollisionRing[]>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented to cancel the batches of an in-flight pass. */
  private generation = 0;
  private running = false;
  private listening = false;
  /** Set when a viewport event lands mid-reconcile, so one more pass runs after. */
  private rerunQueued = false;

  constructor(options: TileControllerOptions) {
    this.map = options.map;
    this.layer = options.layer;
    this.version = options.version;
    this.center = options.center;
    this.facade = options.facade;
    this.maxGeohashes =
      typeof options.maxGeohashes === 'number' && Number.isFinite(options.maxGeohashes)
        ? options.maxGeohashes
        : undefined;
    this.onTilesChanged = options.onTilesChanged;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.pool = new TileWorkerPool(Math.min(3, Math.max(1, cores - 2)));
  }

  /** Attaches the debounced viewport listeners. Idempotent. */
  start(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.map.on('moveend', this.onViewportEvent);
    this.map.on('zoomend', this.onViewportEvent);
    this.map.on('rotateend', this.onViewportEvent);
    this.map.on('pitchend', this.onViewportEvent);
  }

  /** Runs one reconcile immediately (used on startup to load the first view). */
  async refresh(): Promise<void> {
    await this.reconcile();
  }

  /** Detaches listeners, cancels pending work and stops the workers. */
  dispose(): void {
    if (this.listening) {
      this.map.off('moveend', this.onViewportEvent);
      this.map.off('zoomend', this.onViewportEvent);
      this.map.off('rotateend', this.onViewportEvent);
      this.map.off('pitchend', this.onViewportEvent);
      this.listening = false;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    this.generation += 1;
    this.pool.dispose();
  }

  /** Debounced handler shared by every viewport event. */
  private readonly onViewportEvent = (): void => {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reconcile();
    }, DEBOUNCE_MS);
  };

  /**
   * The capped target geohash set for the current view, nearest to the map
   * centre first (so the closest buildings stream in first).
   */
  private chooseTargets(level: number): string[] {
    const margin = VIEWPORT_MARGIN_PCT_BY_LEVEL[level] ?? DEFAULT_VIEWPORT_MARGIN_PCT;
    const polygon = expandPolygonAboutCentroid(visibleGroundPolygon(this.map), margin);
    const candidates = enumerateGeohashesInPolygon(polygon, level);
    const levelCap = MAX_GEOHASHES_PER_LEVEL[level] ?? candidates.length;
    const cap = this.maxGeohashes !== undefined ? Math.min(levelCap, this.maxGeohashes) : levelCap;

    const centre = this.map.getCenter();
    // Scale the longitude delta by cos(lat) so the distance is metric on the ground.
    const lngScale = Math.cos((centre.lat * Math.PI) / 180);
    return candidates
      .map((hash) => {
        const c = geohashCenter(hash);
        const dLng = (c.lng - centre.lng) * lngScale;
        const dLat = c.lat - centre.lat;
        return { hash, distance: dLng * dLng + dLat * dLat };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, cap)
      .map((entry) => entry.hash);
  }

  /** Publishes the collision-ring union now. */
  private publishRings(): void {
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    const union: CollisionRing[] = [];
    for (const rings of this.tileRings.values()) {
      for (const ring of rings) {
        union.push(ring);
      }
    }
    this.onTilesChanged(union, this.loaded.size);
  }

  /** Publishes the ring union at most every {@link RINGS_PUBLISH_INTERVAL_MS}. */
  private publishRingsSoon(): void {
    if (this.publishTimer === null) {
      this.publishTimer = setTimeout(() => this.publishRings(), RINGS_PUBLISH_INTERVAL_MS);
    }
  }

  /** Puts finished tiles on the map (skipping ones that are already there). */
  private applyTiles(tiles: BuiltTile[]): void {
    for (const { geohash, data } of tiles) {
      if (this.loaded.has(geohash) && this.layer.hasBackendTile(geohash)) {
        continue;
      }
      this.layer.addBackendTileData(geohash, data);
      // Mark loaded even when empty so empty cells are never refetched.
      this.loaded.add(geohash);
      this.tileRings.set(geohash, data.rings);
    }
  }

  /** The core evict/add reconcile for the current viewport. */
  private async reconcile(): Promise<void> {
    if (this.running) {
      // Cancel the batches of the running pass that have not been sent yet,
      // and run again once the in-flight ones finish.
      this.generation += 1;
      this.rerunQueued = true;
      return;
    }
    this.running = true;
    const generation = ++this.generation;

    try {
      const level = zoomToLevel(this.map.getZoom());
      const target = this.chooseTargets(level);
      const targetSet = new Set(target);

      // Evict first: frees memory and draw calls before anything new arrives.
      let evicted = false;
      for (const geohash of [...this.loaded]) {
        if (!targetSet.has(geohash)) {
          this.layer.removeBackendTile(geohash);
          this.loaded.delete(geohash);
          this.tileRings.delete(geohash);
          evicted = true;
        }
      }
      if (evicted) {
        this.publishRings();
      }

      // Never re-request a tile already present (recorded AND meshed).
      const toFetch = target.filter(
        (geohash) => !(this.loaded.has(geohash) && this.layer.hasBackendTile(geohash)),
      );
      const batches: string[][] = [];
      for (let i = 0; i < toFetch.length; i += TILES_PER_REQUEST) {
        batches.push(toFetch.slice(i, i + TILES_PER_REQUEST));
      }

      // Stream the batches nearest-first with bounded concurrency. Each batch
      // goes on the map as soon as its worker finishes.
      let next = 0;
      const runLane = async (): Promise<void> => {
        while (next < batches.length && generation === this.generation) {
          const batch = batches[next];
          next += 1;
          try {
            const tiles = await this.pool.request({
              geohashes: batch,
              version: this.version,
              level,
              options: { center: this.center, facade: this.facade },
            });
            // Finished work is kept even if the pass was cancelled meanwhile;
            // the next pass evicts whatever is no longer in view.
            this.applyTiles(tiles);
            this.publishRingsSoon();
          } catch (error) {
            // A failed batch stays unloaded and is retried by the next pass.
            console.error('Tile batch failed:', batch, error);
          }
        }
      };
      const lanes = Math.min(MAX_CONCURRENT_REQUESTS, batches.length);
      await Promise.all(Array.from({ length: lanes }, () => runLane()));

      this.publishRings();
    } finally {
      this.running = false;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        void this.reconcile();
      }
    }
  }
}
