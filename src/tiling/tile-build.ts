import type { Feature, Geometry, GeoJsonProperties, Position } from 'geojson';
import * as THREE from 'three';
import { assignExtrudeFacadeUVs, facadeUvOffset, GROUND_WALL_MATERIAL_INDEX, UPPER_WALL_MATERIAL_INDEX } from '../facade-uv';
import { getFeatureHeight, getFeatureMinHeight, isValidCoordinate, type LngLat } from '../geojson';
import { encodeGeohash, geohashCenter } from './geohash';
import { localFrame, toLocalMetres } from '../local-frame';

/**
 * Pure (DOM-free) tile building: turns the GeoJSON buildings of one geohash tile
 * into ONE merged, non-indexed geometry, split into three contiguous material
 * sections (cap, upper wall, ground wall).
 *
 * Merging is the main rendering optimisation: the former one-mesh-per-building
 * layout cost three draw calls per building per pass (main + shadow), i.e. tens
 * of thousands of draw calls per frame for a city view. A merged tile is three
 * draw calls per pass no matter how many buildings it holds.
 *
 * This module runs both in the tile Web Worker (normal path) and on the main
 * thread (fallback path), so it must not touch the DOM.
 */

/** Facade UV tiling pitches; mirrors the values exposed by the facade textures. */
export interface FacadeMetrics {
  metresPerRepeatU: number;
  metresPerRepeatV: number;
  groundFloorMetres: number;
}

/** Everything the builder needs besides the features themselves. */
export interface TileBuildOptions {
  /** Origin of the local metre frame (+x east, +y up, +z south). */
  center: LngLat;
  /** Facade UV pitches, or null to skip facade UVs. */
  facade: FacadeMetrics | null;
}

/** Info shown when a backend building is clicked. */
export interface BackendBuildingInfo {
  /** Building height in metres. */
  height: number;
  /** Address string, or null when the feature has none. */
  address: string | null;
  /**
   * How the height was derived on the backend: `osm` (real OSM data),
   * `predicted` (model estimate) or `fallback` (default value). Null when the
   * feature carries no source. The popup surfaces only non-OSM sources.
   */
  source: string | null;
}

/** A backend footprint ring used for user-object collision checks. */
export interface CollisionRing {
  id: string;
  ring: LngLat[];
}

/** The merged geometry of one tile plus the per-building lookup tables. */
export interface TileGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Vertex counts of the cap, upper-wall and ground-wall sections, in that order. */
  sectionVertexCounts: [number, number, number];
  /**
   * Per building, 6 numbers: start/count (in vertices) of its triangles in the
   * cap, upper-wall and ground-wall sections. Used for click picking.
   */
  buildingRanges: Uint32Array;
  /** Per building, its local-metre bounding box: minX, minY, minZ, maxX, maxY, maxZ. */
  buildingBoxes: Float32Array;
  infos: BackendBuildingInfo[];
  rings: CollisionRing[];
}

/** Section index for each geometry material index (0 cap, 1 upper wall, 2 ground wall). */
function sectionOf(materialIndex: number | undefined): 0 | 1 | 2 {
  if (materialIndex === UPPER_WALL_MATERIAL_INDEX) {
    return 1;
  }
  if (materialIndex === GROUND_WALL_MATERIAL_INDEX) {
    return 2;
  }
  return 0;
}

/** The polygons of a feature (Polygon -> one, MultiPolygon -> many, else none). */
export function featurePolygons(geometry: Geometry | null): Position[][][] {
  if (geometry?.type === 'Polygon') {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates;
  }
  return [];
}

/** Opens a ring, dropping a duplicated closing point. */
function openRing<T extends ArrayLike<number>>(ring: T[]): T[] {
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
 * Local-metre converter for a fixed scene centre. Uses the same Mercator-based
 * frame as the layer (see local-frame.ts), so footprints land exactly where
 * MapLibre draws them.
 */
function metreConverter(center: LngLat): (lng: number, lat: number) => THREE.Vector2 {
  const frame = localFrame(center);
  return (lng, lat) => {
    const [east, north] = toLocalMetres(frame, lng, lat);
    return new THREE.Vector2(east, north);
  };
}

/** Builds the extruded, facade-UV'd geometry of one polygon, or null when degenerate. */
function polygonGeometry(
  polygon: Position[][],
  properties: GeoJsonProperties,
  seed: string,
  toMetres: (lng: number, lat: number) => THREE.Vector2,
  facade: FacadeMetrics | null,
): THREE.BufferGeometry | null {
  const toPoints = (ring: Position[]): THREE.Vector2[] =>
    openRing(ring.filter(isValidCoordinate)).map(([lng, lat]) => toMetres(lng, lat));

  if (polygon.length === 0) {
    return null;
  }
  const outer = toPoints(polygon[0]);
  if (outer.length < 3) {
    return null;
  }

  const shape = new THREE.Shape(outer);
  for (const ring of polygon.slice(1)) {
    const hole = toPoints(ring);
    if (hole.length >= 3) {
      shape.holes.push(new THREE.Path(hole));
    }
  }

  const minimumHeight = getFeatureMinHeight(properties);
  const extrude = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(getFeatureHeight(properties) - minimumHeight, 0.1),
    bevelEnabled: false,
    steps: 1,
  });
  extrude.rotateX(-Math.PI / 2);
  extrude.translate(0, minimumHeight, 0);

  // Tile the facade window grid across the walls in real metres, phase-shifted
  // per building so lit windows do not line up with the neighbours at night.
  if (facade) {
    assignExtrudeFacadeUVs(
      extrude,
      facade.metresPerRepeatU,
      facade.metresPerRepeatV,
      facadeUvOffset(seed),
      facade.groundFloorMetres,
    );
  }

  return extrude.index ? extrude.toNonIndexed() : extrude;
}

/** One building's slices of the shared sections, before they are copied together. */
interface BuildingParts {
  /** [section] -> list of [start, count] vertex ranges inside `geometry`. */
  ranges: Array<Array<[number, number]>>;
  geometry: THREE.BufferGeometry;
}

/**
 * Builds the merged geometry of one tile.
 *
 * @param features  the buildings of the tile
 * @param keyPrefix tile key; seeds the per-building facade phase and collision ids
 *                  exactly like the former per-mesh path (`backend-<key>-<f>-<p>`)
 * @param options   scene centre and facade pitches
 */
export function buildTileGeometry(
  features: ReadonlyArray<Feature>,
  keyPrefix: string,
  options: TileBuildOptions,
): TileGeometryData {
  const toMetres = metreConverter(options.center);
  const parts: BuildingParts[] = [];
  const infos: BackendBuildingInfo[] = [];
  const rings: CollisionRing[] = [];
  const sectionTotals: [number, number, number] = [0, 0, 0];

  features.forEach((feature, featureIndex) => {
    const properties = feature.properties;
    const addressRaw = properties?.address;
    const sourceRaw = properties?.source;
    const info: BackendBuildingInfo = {
      height: getFeatureHeight(properties),
      address: typeof addressRaw === 'string' && addressRaw ? addressRaw : null,
      source: typeof sourceRaw === 'string' && sourceRaw ? sourceRaw : null,
    };

    featurePolygons(feature.geometry).forEach((polygon, polygonIndex) => {
      const id = `backend-${keyPrefix}-${featureIndex}-${polygonIndex}`;

      // Collision ring: the opened, valid outer ring in lng/lat.
      const outer = polygon[0];
      if (outer) {
        const ring: LngLat[] = [];
        for (const coordinate of outer) {
          if (isValidCoordinate(coordinate)) {
            ring.push([coordinate[0], coordinate[1]]);
          }
        }
        const opened = openRing(ring);
        if (opened.length >= 3) {
          rings.push({ id, ring: opened });
        }
      }

      const geometry = polygonGeometry(polygon, properties, id, toMetres, options.facade);
      if (!geometry) {
        return;
      }

      const vertexCount = geometry.getAttribute('position').count;
      const ranges: Array<Array<[number, number]>> = [[], [], []];
      if (geometry.groups.length === 0) {
        ranges[0].push([0, vertexCount]);
      } else {
        for (const group of geometry.groups) {
          const start = Math.max(0, group.start);
          const count = Math.min(group.count, vertexCount - start);
          if (count > 0) {
            ranges[sectionOf(group.materialIndex)].push([start, count]);
          }
        }
      }
      for (let section = 0; section < 3; section += 1) {
        for (const [, count] of ranges[section]) {
          sectionTotals[section] += count;
        }
      }
      parts.push({ ranges, geometry });
      infos.push(info);
    });
  });

  const totalVertices = sectionTotals[0] + sectionTotals[1] + sectionTotals[2];
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const buildingRanges = new Uint32Array(parts.length * 6);
  const buildingBoxes = new Float32Array(parts.length * 6);

  // Write cursors (in vertices) for each section of the merged buffer.
  const cursor: [number, number, number] = [0, sectionTotals[0], sectionTotals[0] + sectionTotals[1]];

  parts.forEach((part, buildingIndex) => {
    const position = part.geometry.getAttribute('position').array as Float32Array;
    const normal = part.geometry.getAttribute('normal')?.array as Float32Array | undefined;
    const uv = part.geometry.getAttribute('uv')?.array as Float32Array | undefined;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let section = 0; section < 3; section += 1) {
      const sectionStart = cursor[section];
      for (const [start, count] of part.ranges[section]) {
        const target = cursor[section];
        positions.set(position.subarray(start * 3, (start + count) * 3), target * 3);
        if (normal) {
          normals.set(normal.subarray(start * 3, (start + count) * 3), target * 3);
        }
        if (uv) {
          uvs.set(uv.subarray(start * 2, (start + count) * 2), target * 2);
        }
        for (let i = start * 3; i < (start + count) * 3; i += 3) {
          const x = position[i];
          const y = position[i + 1];
          const z = position[i + 2];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
        cursor[section] += count;
      }
      buildingRanges[buildingIndex * 6 + section * 2] = sectionStart;
      buildingRanges[buildingIndex * 6 + section * 2 + 1] = cursor[section] - sectionStart;
    }

    buildingBoxes.set([minX, minY, minZ, maxX, maxY, maxZ], buildingIndex * 6);
    part.geometry.dispose();
  });

  return {
    positions,
    normals,
    uvs,
    sectionVertexCounts: sectionTotals,
    buildingRanges,
    buildingBoxes,
    infos,
    rings,
  };
}

/** The ArrayBuffers of a tile, for zero-copy transfer out of the worker. */
export function tileTransferables(data: TileGeometryData): ArrayBuffer[] {
  return [
    data.positions.buffer as ArrayBuffer,
    data.normals.buffer as ArrayBuffer,
    data.uvs.buffer as ArrayBuffer,
    data.buildingRanges.buffer as ArrayBuffer,
    data.buildingBoxes.buffer as ArrayBuffer,
  ];
}

/* ------------------------------------------------------------------------- *
 * Grouping a merged /tiles response back into the tiles it was fetched for.
 * ------------------------------------------------------------------------- */

/**
 * The lng/lat centroid of a feature's outer ring (Polygon -> coordinates[0];
 * MultiPolygon -> first polygon's [0]), or null when it has no usable geometry.
 */
function featureCentroid(geometry: Geometry | null): LngLat | null {
  const outer = featurePolygons(geometry)[0]?.[0];
  if (!outer || outer.length === 0) {
    return null;
  }
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const coordinate of outer) {
    if (isValidCoordinate(coordinate)) {
      sumLng += coordinate[0];
      sumLat += coordinate[1];
      count += 1;
    }
  }
  return count === 0 ? null : [sumLng / count, sumLat / count];
}

/**
 * Buckets the features of one /tiles response back into the requested tiles.
 *
 * All requested geohashes share one length (`level`). A feature goes to the
 * tile its centroid falls in; when that cell was not requested (the footprint
 * straddles a cell edge) it goes to the nearest requested cell, so no returned
 * feature is dropped.
 */
export function bucketFeatures(
  features: ReadonlyArray<Feature>,
  requested: ReadonlyArray<string>,
  level: number,
): Map<string, Feature[]> {
  const requestedSet = new Set(requested);
  const centres = requested.map((geohash) => ({ geohash, centre: geohashCenter(geohash) }));
  const groups = new Map<string, Feature[]>();
  for (const geohash of requested) {
    groups.set(geohash, []);
  }

  for (const feature of features) {
    const centroid = featureCentroid(feature.geometry);
    if (!centroid) {
      continue;
    }
    let key: string | null = encodeGeohash(centroid[1], centroid[0], level);
    if (!requestedSet.has(key)) {
      key = null;
      let bestDistance = Infinity;
      const lngScale = Math.cos((centroid[1] * Math.PI) / 180);
      for (const { geohash, centre } of centres) {
        const dLng = (centre.lng - centroid[0]) * lngScale;
        const dLat = centre.lat - centroid[1];
        const distance = dLng * dLng + dLat * dLat;
        if (distance < bestDistance) {
          bestDistance = distance;
          key = geohash;
        }
      }
    }
    if (key !== null) {
      groups.get(key)?.push(feature);
    }
  }

  return groups;
}
