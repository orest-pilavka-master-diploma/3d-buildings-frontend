/**
 * The local metre frame the 3D layer draws in (+x east, +y up, +z south),
 * defined directly on MapLibre's Web Mercator coordinates.
 *
 * The layer renders local metres by mapping them LINEARLY into Mercator units
 * (`mercator = origin + metres * meterScale`). Converting lng/lat to local
 * metres with the exact inverse of that mapping makes every vertex land on the
 * same spot MapLibre draws that lng/lat at, at any distance from the origin.
 *
 * The previous equirectangular conversion used a different Earth radius
 * (6 378 137 m) than MapLibre (6 371 008.8 m), so the whole scene came out
 * 0.11 % too large around its origin: ~1.8 m off at 1.6 km, ~5.6 m at 5 km.
 * That is why edit handles (drawn by MapLibre) sat beside the building corners.
 *
 * Pure math, no DOM and no MapLibre import, so the tile Web Worker can use it.
 */

/** Origin of the frame in MapLibre Mercator units, plus the metre-to-Mercator scale. */
export interface LocalFrame {
  /** Mercator x of the origin (0..1, as MapLibre's MercatorCoordinate.x). */
  readonly originX: number;
  /** Mercator y of the origin (0..1, as MapLibre's MercatorCoordinate.y). */
  readonly originY: number;
  /** Mercator units per metre at the origin (MercatorCoordinate.meterInMercatorCoordinateUnits()). */
  readonly meterScale: number;
}

/** MapLibre's mercatorXfromLng. */
export function mercatorX(lng: number): number {
  return (180 + lng) / 360;
}

/** MapLibre's mercatorYfromLat. */
export function mercatorY(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

/** MapLibre's latFromMercatorY. */
export function latFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
}

/** MapLibre's Earth radius (metres); its Mercator scale is defined on this sphere. */
const MAPLIBRE_EARTH_RADIUS = 6_371_008.8;

/**
 * The frame with its origin at `center`, identical to what
 * `MercatorCoordinate.fromLngLat(center)` and `meterInMercatorCoordinateUnits()`
 * give, computed without MapLibre so the worker can use it too.
 */
export function localFrame(center: readonly [number, number]): LocalFrame {
  return {
    originX: mercatorX(center[0]),
    originY: mercatorY(center[1]),
    meterScale: 1 / (2 * Math.PI * MAPLIBRE_EARTH_RADIUS) / Math.cos((center[1] * Math.PI) / 180),
  };
}

/** Converts local [east, north] metres back to lng/lat; exact inverse of {@link toLocalMetres}. */
export function fromLocalMetres(frame: LocalFrame, east: number, north: number): [number, number] {
  const x = frame.originX + east * frame.meterScale;
  const y = frame.originY - north * frame.meterScale;
  return [x * 360 - 180, latFromMercatorY(y)];
}

/** Converts lng/lat to local [east, north] metres in the given frame. */
export function toLocalMetres(frame: LocalFrame, lng: number, lat: number): [number, number] {
  return [
    (mercatorX(lng) - frame.originX) / frame.meterScale,
    // Mercator y grows southwards; local north is the opposite direction.
    -(mercatorY(lat) - frame.originY) / frame.meterScale,
  ];
}
