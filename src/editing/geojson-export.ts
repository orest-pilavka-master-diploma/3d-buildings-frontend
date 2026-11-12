import type { Feature, FeatureCollection } from 'geojson';
import { rotateRingAboutCentroid } from './collision';
import type { UserObject } from './user-objects-store';
import type { LngLat } from '../geojson';

/**
 * Converts a user object into a GeoJSON Polygon feature. The geometry uses the
 * rotation-baked footprint (obj.ring rotated by obj.rotationDeg about its
 * centroid) so the exported ring matches what is drawn on the map, and the
 * shaping parameters are preserved in `properties`.
 */
function userObjectToFeature(object: UserObject, center: LngLat): Feature {
  const rotated = rotateRingAboutCentroid(object.ring, object.rotationDeg, center);
  const coordinates = rotated.map(([lng, lat]) => [lng, lat] as [number, number]);
  // GeoJSON polygons must be explicitly closed (first point repeated last).
  if (coordinates.length > 0) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coordinates.push([first[0], first[1]]);
    }
  }

  return {
    type: 'Feature',
    // `id` is a top-level GeoJSON Feature member, not a property.
    id: object.id,
    properties: {
      height: object.height,
      minHeight: object.minHeight,
      source: object.source,
      rotationDeg: object.rotationDeg,
      twistDeg: object.twistDeg,
      taper: object.taper,
    },
    geometry: { type: 'Polygon', coordinates: [coordinates] },
  };
}

/** Wraps the given user objects in a GeoJSON FeatureCollection. */
export function userObjectsToFeatureCollection(
  objects: readonly UserObject[],
  center: LngLat,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: objects.map((object) => userObjectToFeature(object, center)),
  };
}

/** Triggers a browser download of `collection` as a pretty-printed .geojson file. */
export function downloadFeatureCollection(
  collection: FeatureCollection,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(collection, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Release the object URL on the next tick, once the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A filesystem-friendly timestamp like `20260506-204248` for export filenames. */
export function exportTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
