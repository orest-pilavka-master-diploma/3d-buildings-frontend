import type { LngLat } from '../geojson';

/**
 * A user-authored 3D object: an extruded footprint ring with explicit height,
 * source category and shaping parameters. Mirrors the explicit fields that
 * getFeatureHeight/getFeatureMinHeight derive for backend buildings, so the
 * layer can treat both the same way.
 */
/** Where a user object came from; drives its category colour in the 3D layer. */
export type UserObjectSource = 'drawn' | 'uploaded';

export interface UserObject {
  id: string;
  ring: LngLat[];
  height: number;
  minHeight: number;
  /** 'drawn' (added on the map) or 'uploaded' (imported from GeoJSON). */
  source: UserObjectSource;
  rotationDeg: number;
  twistDeg: number;
  taper: number;
}

const DEFAULT_HEIGHT = 20;
const DEFAULT_MIN_HEIGHT = 0;
const DEFAULT_SOURCE: UserObjectSource = 'drawn';
const DEFAULT_ROTATION_DEG = 0;
const DEFAULT_TWIST_DEG = 0;
const DEFAULT_TAPER = 1;

/** In-memory registry of user objects. No persistence of any kind. */
export class UserObjectStore {
  private counter = 0;
  private readonly objects = new Map<string, UserObject>();

  create(ring: LngLat[], init?: Partial<Omit<UserObject, 'id' | 'ring'>>): UserObject {
    const object: UserObject = {
      id: `user-${++this.counter}`,
      ring,
      height: init?.height ?? DEFAULT_HEIGHT,
      minHeight: init?.minHeight ?? DEFAULT_MIN_HEIGHT,
      source: init?.source ?? DEFAULT_SOURCE,
      rotationDeg: init?.rotationDeg ?? DEFAULT_ROTATION_DEG,
      twistDeg: init?.twistDeg ?? DEFAULT_TWIST_DEG,
      taper: init?.taper ?? DEFAULT_TAPER,
    };
    this.objects.set(object.id, object);
    return object;
  }

  get(id: string): UserObject | undefined {
    return this.objects.get(id);
  }

  update(id: string, patch: Partial<UserObject>): UserObject | null {
    const existing = this.objects.get(id);
    if (!existing) {
      return null;
    }
    const updated: UserObject = { ...existing, ...patch, id: existing.id };
    this.objects.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.objects.delete(id);
  }

  all(): UserObject[] {
    return [...this.objects.values()];
  }

  isUserObject(id: string): boolean {
    return this.objects.has(id);
  }
}
