import type {
  GeoJSONSource,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
} from 'maplibre-gl';
import type { LngLat } from '../geojson';
import type { UserObject } from './user-objects-store';
import { rotateRingAboutCentroid } from './collision';
import { fromLocalMetres, localFrame, toLocalMetres } from '../local-frame';

const SOURCE_ID = 'user-draw';
const FILL_LAYER_ID = 'user-draw-fill';
const LINE_LAYER_ID = 'user-draw-line';
const VERTEX_LAYER_ID = 'user-draw-vertex';

/** Milliseconds within which a click following a double-click is swallowed. */
const DBLCLICK_GUARD_MS = 350;


export interface DrawControllerCallbacks {
  /** Called with the open ring (no duplicated closing point) once >= 3 vertices exist. */
  onFinish: (ring: LngLat[]) => void;
  onCancel: () => void;
  /**
   * Called on every preview change (vertex added/removed, cursor moved) once the
   * live preview polygon has >= 3 points. The owner answers `true` when the
   * preview ring overlaps an existing footprint so the preview can be tinted red.
   * Returning `undefined` (no callback) leaves the preview in its normal colour.
   */
  onPreviewChange?: (ring: LngLat[]) => boolean;
}

/**
 * Interactive polygon drawing on a MapLibre map. Clicks append vertices rendered
 * as a flat GeoJSON fill + outline + vertex overlay; double-click or finish()
 * closes the ring, Escape cancels, Backspace removes the last vertex. The overlay
 * source/layers are created lazily on first start().
 */
/** How the footprint is drawn: free polygon (click vertices) or axis rectangle. */
export type DrawMode = 'polygon' | 'rectangle';

export class DrawController {
  private readonly map: MapLibreMap;
  private readonly callbacks: DrawControllerCallbacks;

  private active = false;
  private layersReady = false;
  private mode: DrawMode = 'polygon';
  private vertices: LngLat[] = [];
  private previousDoubleClickZoom = true;
  private lastDblClickAt = 0;
  /** Live cursor position, used as the provisional last vertex of the preview. */
  private cursor: LngLat | null = null;
  /** Whether the current preview ring overlaps an existing footprint. */
  private overlapping = false;

  constructor(map: MapLibreMap, callbacks: DrawControllerCallbacks) {
    this.map = map;
    this.callbacks = callbacks;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Enters draw mode: binds map/document listeners and resets the vertex list. */
  start(mode: DrawMode = 'polygon'): void {
    if (this.active) {
      return;
    }
    this.ensureLayers();
    this.active = true;
    this.mode = mode;
    this.vertices = [];
    this.cursor = null;
    this.overlapping = false;
    this.updateSource();

    this.previousDoubleClickZoom = this.map.doubleClickZoom.isEnabled();
    this.map.doubleClickZoom.disable();

    this.map.on('click', this.handleClick);
    this.map.on('dblclick', this.handleDoubleClick);
    this.map.on('mousemove', this.handleMove);
    document.addEventListener('keydown', this.handleKeyDown, true);
  }

  /** Closes the ring and reports it when it has enough vertices. */
  finish(): void {
    if (!this.active) {
      return;
    }
    const ring = this.mode === 'rectangle'
      ? this.rectangleRing(this.vertices[0], this.cursor)
      : this.dedupeConsecutive(this.vertices);
    if (ring.length < 3) {
      return;
    }
    this.teardown();
    this.callbacks.onFinish(ring);
  }

  /**
   * The four corners of an axis-aligned rectangle (in lng/lat) spanned by the
   * fixed first corner and the opposite corner, or an empty ring until both
   * corners exist and the rectangle has a non-zero area.
   */
  private rectangleRing(corner: LngLat | undefined, opposite: LngLat | null): LngLat[] {
    if (!corner || !opposite) {
      return [];
    }
    const [lng1, lat1] = corner;
    const [lng2, lat2] = opposite;
    if (lng1 === lng2 || lat1 === lat2) {
      return [];
    }
    return [
      [lng1, lat1],
      [lng2, lat1],
      [lng2, lat2],
      [lng1, lat2],
    ];
  }

  /**
   * Removes consecutive vertices that sit at the same position (and a closing
   * vertex duplicating the first). A double-click finish can leave two vertices
   * at the click point; this guarantees the reported ring has no zero-length
   * consecutive edge.
   */
  private dedupeConsecutive(vertices: LngLat[]): LngLat[] {
    const result: LngLat[] = [];
    for (const [lng, lat] of vertices) {
      const previous = result[result.length - 1];
      if (previous && previous[0] === lng && previous[1] === lat) {
        continue;
      }
      result.push([lng, lat]);
    }
    if (result.length > 1) {
      const first = result[0];
      const last = result[result.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) {
        result.pop();
      }
    }
    return result;
  }

  /** Leaves draw mode without reporting a ring. */
  cancel(): void {
    if (!this.active) {
      return;
    }
    this.teardown();
    this.callbacks.onCancel();
  }

  /** Removes listeners and clears the overlay; safe to call when inactive. */
  stop(): void {
    if (this.active) {
      this.teardown();
    }
  }

  private teardown(): void {
    this.active = false;
    this.map.off('click', this.handleClick);
    this.map.off('dblclick', this.handleDoubleClick);
    this.map.off('mousemove', this.handleMove);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    if (this.previousDoubleClickZoom) {
      this.map.doubleClickZoom.enable();
    }
    this.vertices = [];
    this.cursor = null;
    this.overlapping = false;
    this.applyPreviewColor(false);
    this.updateSource();
  }

  private readonly handleClick = (event: MapMouseEvent): void => {
    // A dblclick fires a trailing click; swallow it so it does not add a stray vertex.
    if (Date.now() - this.lastDblClickAt < DBLCLICK_GUARD_MS) {
      return;
    }
    const point: LngLat = [event.lngLat.lng, event.lngLat.lat];

    if (this.mode === 'rectangle') {
      // First click fixes one corner; the second click closes the rectangle
      // that has been rubber-banding under the cursor since then.
      if (this.vertices.length === 0) {
        this.vertices = [point];
        this.cursor = point;
        this.updateSource();
      } else {
        this.cursor = point;
        this.finish();
      }
      return;
    }

    this.vertices.push(point);
    this.updateSource();
  };

  private readonly handleDoubleClick = (event: MapMouseEvent): void => {
    // The rectangle tool finishes on its second single click; ignore dblclick.
    if (this.mode === 'rectangle') {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    this.lastDblClickAt = Date.now();
    // The leading click of this double-click already placed a vertex at (or next
    // to) the double-click point; drop it so finishing leaves a single vertex.
    this.vertices.pop();
    this.finish();
  };

  private readonly handleMove = (event: MapMouseEvent): void => {
    if (!this.active) {
      return;
    }
    this.cursor = [event.lngLat.lng, event.lngLat.lat];
    this.updateSource();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      if (this.mode === 'rectangle') {
        // Drop the fixed corner so the next click starts the rectangle over.
        this.vertices = [];
      } else {
        this.vertices.pop();
      }
      this.updateSource();
    }
  };

  private ensureLayers(): void {
    if (this.layersReady) {
      return;
    }

    if (!this.map.getSource(SOURCE_ID)) {
      this.map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: this.emptyData(),
      });
    }

    if (!this.map.getLayer(FILL_LAYER_ID)) {
      this.map.addLayer({
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': '#2f6bff',
          'fill-opacity': 0.18,
        },
      });
    }

    if (!this.map.getLayer(LINE_LAYER_ID)) {
      this.map.addLayer({
        id: LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': '#2f6bff',
          'line-width': 2,
        },
      });
    }

    if (!this.map.getLayer(VERTEX_LAYER_ID)) {
      this.map.addLayer({
        id: VERTEX_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#2f6bff',
          'circle-stroke-width': 2,
        },
      });
    }

    this.layersReady = true;
  }

  /**
   * The live preview ring: placed vertices plus the current cursor position as a
   * provisional last vertex. This is what is rendered as the rubber-band polygon
   * and what the overlap check runs against.
   */
  private previewRing(): LngLat[] {
    if (this.mode === 'rectangle') {
      return this.rectangleRing(this.vertices[0], this.cursor);
    }
    const ring = this.vertices.map(([lng, lat]) => [lng, lat] as LngLat);
    if (this.cursor) {
      ring.push([this.cursor[0], this.cursor[1]]);
    }
    return ring;
  }

  private updateSource(): void {
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) {
      return;
    }
    const preview = this.previewRing();
    this.refreshOverlap(preview);
    source.setData(this.buildData(preview));
  }

  /**
   * Asks the owner whether the preview ring overlaps an existing footprint and
   * repaints the fill/line layers red (overlap) or back to the accent colour.
   */
  private refreshOverlap(preview: LngLat[]): void {
    const overlapping = preview.length >= 3 && this.callbacks.onPreviewChange
      ? this.callbacks.onPreviewChange(preview)
      : false;
    if (overlapping === this.overlapping) {
      return;
    }
    this.overlapping = overlapping;
    this.applyPreviewColor(overlapping);
  }

  /** Tints the fill + outline red when overlapping, accent blue otherwise. */
  private applyPreviewColor(overlapping: boolean): void {
    const fill = overlapping ? '#ff3b30' : '#2f6bff';
    const line = overlapping ? '#ff3b30' : '#2f6bff';
    if (this.map.getLayer(FILL_LAYER_ID)) {
      this.map.setPaintProperty(FILL_LAYER_ID, 'fill-color', fill);
      this.map.setPaintProperty(FILL_LAYER_ID, 'fill-opacity', overlapping ? 0.26 : 0.18);
    }
    if (this.map.getLayer(LINE_LAYER_ID)) {
      this.map.setPaintProperty(LINE_LAYER_ID, 'line-color', line);
    }
  }

  private emptyData(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  private buildData(preview: LngLat[]): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    // Each PLACED vertex as a point for the circle layer (cursor is not a dot).
    for (const [lng, lat] of this.vertices) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    }

    if (preview.length >= 3) {
      const ring = preview.map(([lng, lat]) => [lng, lat]);
      ring.push([preview[0][0], preview[0][1]]);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    } else if (preview.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: preview.map(([lng, lat]) => [lng, lat]),
        },
      });
    }

    return { type: 'FeatureCollection', features };
  }
}

const HANDLES_SOURCE_ID = 'user-edit-handles';
const BODY_LAYER_ID = 'user-edit-body';
const VERTEX_HANDLE_LAYER_ID = 'user-edit-vertex';
const MOVE_HANDLE_LAYER_ID = 'user-edit-move';
const ROTATE_HANDLE_LAYER_ID = 'user-edit-rotate';
const ROTATE_LINE_LAYER_ID = 'user-edit-rotate-line';

/** Metres the rotate handle sits away from the centroid, on screen-independent ground. */
const ROTATE_HANDLE_OFFSET_M = 18;

type HandleKind = 'vertex' | 'move' | 'rotate' | 'body';

export interface EditHandlesCallbacks {
  /**
   * Fired (throttled to animation frames) while a vertex or the whole ring
   * moves. `rotationDeg`, when present, is a rotation override to store with the
   * new ring — used when a vertex drag bakes the object's rotation into the ring
   * and resets rotation to 0 so one vertex can move without disturbing the rest.
   */
  onGeometryChange: (ring: LngLat[], rotationDeg?: number) => void;
  /** Fired (throttled to animation frames) while the rotate handle or body is dragged. */
  onRotate: (rotationDeg: number) => void;
  /** Supplies the scene centre used to bake rotation into the handle ring. */
  getCenter: () => LngLat;
}

interface DragState {
  kind: HandleKind;
  /** Vertex index being dragged; -1 for move/rotate/body. */
  index: number;
  /** Pointer position at drag start (lngLat). */
  startLngLat: LngLat;
  /** Unrotated base-ring snapshot captured at drag start. */
  startRing: LngLat[];
  /** Rotation (deg) captured at drag start. */
  startRotation: number;
  /** Centroid (lngLat) at drag start, for rotate maths. */
  centroid: LngLat;
  /** Pointer angle (radians) at drag start, for rotate/body maths. */
  startAngle: number;
  /**
   * True when a vertex drag has baked the object's rotation into `startRing`
   * (rotation reset to 0). The commit then carries `rotationDeg: 0` so the ring
   * is edited directly, with no live centroid pivot to nudge the other vertices.
   */
  rotationBaked: boolean;
}

/**
 * Renders and drives the draggable editing handles for the selected user object:
 * one circle per footprint vertex, a centroid "move" handle, and a "rotate" handle
 * offset from the centroid (joined to it by a guide line). Dragging a vertex
 * reshapes the ring; dragging the move handle translates every vertex; dragging
 * the rotate handle changes rotationDeg. Geometry/rotation updates are throttled
 * to animation frames and reported via callbacks; the map's drag-pan is suspended
 * for the duration of a handle drag.
 *
 * The handles are drawn at the object's ROTATED footprint (obj.ring baked by
 * obj.rotationDeg about the centroid, mirroring the extruded mesh), so the vertex
 * dots sit on the building that is actually on screen. When a vertex is dragged,
 * the new rotated-space position is inverse-rotated back to the canonical
 * unrotated base ring before it is written to the store. A translucent "body"
 * fill over the footprint lets the user rotate the building by dragging anywhere
 * on it; the dedicated green rotate handle remains available too.
 */
export class EditHandles {
  private readonly map: MapLibreMap;
  private readonly callbacks: EditHandlesCallbacks;

  private layersReady = false;
  private visible = false;
  private object: UserObject | null = null;

  private drag: DragState | null = null;
  private frame = 0;
  private pendingRing: LngLat[] | null = null;
  /** Rotation override to commit with a baked vertex-drag ring (0), else null. */
  private pendingRotationOverride: number | null = null;
  private pendingRotation: number | null = null;

  constructor(map: MapLibreMap, callbacks: EditHandlesCallbacks) {
    this.map = map;
    this.callbacks = callbacks;
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** Shows the handles for `obj` and keeps a copy to drive drag maths. */
  showHandles(obj: UserObject): void {
    this.ensureLayers();
    this.object = obj;
    this.visible = true;
    this.updateSource();
  }

  /** Refreshes handle positions after an external geometry/rotation change. */
  update(obj: UserObject): void {
    if (!this.visible) {
      return;
    }
    this.object = obj;
    this.updateSource();
  }

  hideHandles(): void {
    this.cancelDrag();
    this.visible = false;
    this.object = null;
    this.updateSource();
  }

  private ensureLayers(): void {
    if (this.layersReady) {
      return;
    }

    if (!this.map.getSource(HANDLES_SOURCE_ID)) {
      this.map.addSource(HANDLES_SOURCE_ID, {
        type: 'geojson',
        data: this.emptyData(),
      });
    }

    if (!this.map.getLayer(BODY_LAYER_ID)) {
      this.map.addLayer({
        id: BODY_LAYER_ID,
        type: 'fill',
        source: HANDLES_SOURCE_ID,
        filter: ['==', ['get', 'handle'], 'body'],
        paint: {
          // Nearly invisible: it only serves as a drag surface for rotation.
          'fill-color': '#2f6bff',
          'fill-opacity': 0.06,
        },
      });
    }

    if (!this.map.getLayer(ROTATE_LINE_LAYER_ID)) {
      this.map.addLayer({
        id: ROTATE_LINE_LAYER_ID,
        type: 'line',
        source: HANDLES_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#15b371',
          'line-width': 1.5,
          'line-dasharray': [2, 2],
        },
      });
    }

    if (!this.map.getLayer(VERTEX_HANDLE_LAYER_ID)) {
      this.map.addLayer({
        id: VERTEX_HANDLE_LAYER_ID,
        type: 'circle',
        source: HANDLES_SOURCE_ID,
        filter: ['==', ['get', 'handle'], 'vertex'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#2f6bff',
          'circle-stroke-width': 2.5,
        },
      });
    }

    if (!this.map.getLayer(MOVE_HANDLE_LAYER_ID)) {
      this.map.addLayer({
        id: MOVE_HANDLE_LAYER_ID,
        type: 'circle',
        source: HANDLES_SOURCE_ID,
        filter: ['==', ['get', 'handle'], 'move'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#2f6bff',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });
    }

    if (!this.map.getLayer(ROTATE_HANDLE_LAYER_ID)) {
      this.map.addLayer({
        id: ROTATE_HANDLE_LAYER_ID,
        type: 'circle',
        source: HANDLES_SOURCE_ID,
        filter: ['==', ['get', 'handle'], 'rotate'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#15b371',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });
    }

    const handleLayers = [
      VERTEX_HANDLE_LAYER_ID,
      MOVE_HANDLE_LAYER_ID,
      ROTATE_HANDLE_LAYER_ID,
      BODY_LAYER_ID,
    ];
    this.map.on('mousedown', handleLayers, this.handleMouseDown);
    this.map.on('touchstart', handleLayers, this.handleTouchStart);
    for (const layer of handleLayers) {
      this.map.on('mouseenter', layer, this.handleMouseEnter);
      this.map.on('mouseleave', layer, this.handleMouseLeave);
    }

    this.layersReady = true;
  }

  private readonly handleMouseEnter = (): void => {
    this.map.getCanvas().style.cursor = 'pointer';
  };

  private readonly handleMouseLeave = (): void => {
    if (!this.drag) {
      this.map.getCanvas().style.cursor = '';
    }
  };

  private readonly handleMouseDown = (event: MapLayerMouseEvent): void => {
    const handle = this.readHandle(event.features);
    if (!handle) {
      return;
    }
    event.preventDefault();
    this.beginDrag(handle.kind, handle.index, [event.lngLat.lng, event.lngLat.lat]);
    this.map.on('mousemove', this.handleMouseMove);
    this.map.once('mouseup', this.handleMouseUp);
  };

  private readonly handleTouchStart = (event: MapLayerTouchEvent): void => {
    const handle = this.readHandle(event.features);
    if (!handle || event.points.length !== 1) {
      return;
    }
    event.preventDefault();
    this.beginDrag(handle.kind, handle.index, [event.lngLat.lng, event.lngLat.lat]);
    this.map.on('touchmove', this.handleTouchMove);
    this.map.once('touchend', this.handleTouchEnd);
    this.map.once('touchcancel', this.handleTouchEnd);
  };

  private readonly handleMouseMove = (event: MapMouseEvent): void => {
    this.applyPointer([event.lngLat.lng, event.lngLat.lat]);
  };

  private readonly handleTouchMove = (event: MapTouchEvent): void => {
    if (event.points.length !== 1) {
      return;
    }
    this.applyPointer([event.lngLat.lng, event.lngLat.lat]);
  };

  private readonly handleMouseUp = (): void => {
    this.map.off('mousemove', this.handleMouseMove);
    this.endDrag();
  };

  private readonly handleTouchEnd = (): void => {
    this.map.off('touchmove', this.handleTouchMove);
    this.endDrag();
  };

  /**
   * Resolves which handle a pointer landed on. When several handle layers report
   * a feature under the pointer (e.g. a vertex dot sitting on the body fill), the
   * more specific gesture wins: vertex > move > rotate > body. This keeps the
   * body drag a pure "rotate anywhere on the building" fallback.
   */
  private readHandle(
    features: MapLayerMouseEvent['features'],
  ): { kind: HandleKind; index: number } | null {
    if (!features || features.length === 0) {
      return null;
    }
    const priority: HandleKind[] = ['vertex', 'move', 'rotate', 'body'];
    for (const kind of priority) {
      const match = features.find((feature) => feature.properties?.handle === kind);
      if (match) {
        const index = typeof match.properties?.index === 'number' ? match.properties.index : -1;
        return { kind, index };
      }
    }
    return null;
  }

  private beginDrag(kind: HandleKind, index: number, pointer: LngLat): void {
    if (!this.object) {
      return;
    }
    this.map.dragPan.disable();
    const rotating = kind === 'rotate' || kind === 'body';
    this.map.getCanvas().style.cursor = rotating ? 'grabbing' : 'move';

    // Centroid is rotation-invariant, so the base-ring centroid matches the mesh.
    const centroid = this.centroidLngLat(this.object.ring);

    // For a vertex drag on a rotated object, bake the rotation into the ring and
    // reset rotation to 0 up front. Otherwise the handles (and mesh) re-rotate
    // about the live centroid every frame, so moving one vertex shifts the
    // centroid and visibly nudges every other vertex. Baking makes the edit
    // operate directly on the on-screen ring: only the dragged vertex moves.
    let startRing: LngLat[];
    let startRotation: number;
    let rotationBaked = false;
    if (kind === 'vertex' && this.object.rotationDeg !== 0) {
      startRing = rotateRingAboutCentroid(
        this.object.ring,
        this.object.rotationDeg,
        this.callbacks.getCenter(),
      ).map(([lng, lat]) => [lng, lat] as LngLat);
      startRotation = 0;
      rotationBaked = true;
    } else {
      startRing = this.object.ring.map(([lng, lat]) => [lng, lat] as LngLat);
      startRotation = this.object.rotationDeg;
    }

    this.drag = {
      kind,
      index,
      startLngLat: pointer,
      startRing,
      startRotation,
      centroid,
      startAngle: Math.atan2(pointer[1] - centroid[1], pointer[0] - centroid[0]),
      rotationBaked,
    };
  }

  private applyPointer(pointer: LngLat): void {
    const drag = this.drag;
    if (!drag || !this.object) {
      return;
    }

    if (drag.kind === 'rotate' || drag.kind === 'body') {
      const angle = Math.atan2(pointer[1] - drag.centroid[1], pointer[0] - drag.centroid[0]);
      // Ground angle grows counter-clockwise-from-east with atan2; positive
      // rotationDeg is also counter-clockwise, so the delta adds directly.
      const deltaDeg = ((angle - drag.startAngle) * 180) / Math.PI;
      const next = this.normalizeDegrees(drag.startRotation + deltaDeg);
      this.object = { ...this.object, rotationDeg: next };
      this.pendingRotation = next;
      this.pendingRing = null;
      this.scheduleFrame();
      return;
    }

    const dLng = pointer[0] - drag.startLngLat[0];
    const dLat = pointer[1] - drag.startLngLat[1];

    let ring: LngLat[];
    if (drag.kind === 'move') {
      // Translation commutes with the centroid rotation, so applying the raw
      // delta to the base ring keeps the stored ring canonical.
      ring = drag.startRing.map(([lng, lat]) => [lng + dLng, lat + dLat] as LngLat);
    } else {
      // startRing is the unrotated base, or — when rotationBaked — the already
      // on-screen rotated ring with startRotation reset to 0. Either way only
      // the dragged vertex changes; the others are copied verbatim, so no
      // centroid pivot can nudge them. unrotatePoint is the identity at
      // startRotation 0, so the dragged vertex lands exactly under the pointer.
      ring = drag.startRing.map(([lng, lat]) => [lng, lat] as LngLat);
      if (drag.index >= 0 && drag.index < ring.length) {
        ring[drag.index] = this.unrotatePoint(pointer, drag);
      }
    }

    // When rotation was baked into the ring, the live object must also carry the
    // reset rotation so the handles redraw from the baked ring, not re-rotated.
    this.object = drag.rotationBaked
      ? { ...this.object, ring, rotationDeg: 0 }
      : { ...this.object, ring };
    this.pendingRing = ring;
    this.pendingRotationOverride = drag.rotationBaked ? 0 : null;
    this.pendingRotation = null;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    this.updateSource();
    if (this.frame !== 0) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flushPending();
    });
  }

  /** Emits any queued geometry/rotation change to the owner. */
  private flushPending(): void {
    if (this.pendingRing) {
      const ring = this.pendingRing;
      const override = this.pendingRotationOverride;
      this.pendingRing = null;
      this.pendingRotationOverride = null;
      this.callbacks.onGeometryChange(ring, override ?? undefined);
    }
    if (this.pendingRotation !== null) {
      const rotation = this.pendingRotation;
      this.pendingRotation = null;
      this.callbacks.onRotate(rotation);
    }
  }

  private endDrag(): void {
    if (!this.drag) {
      return;
    }
    // Flush any pending frame synchronously so the final position is committed.
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.flushPending();
    this.drag = null;
    this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = '';
  }

  private cancelDrag(): void {
    if (!this.drag) {
      return;
    }
    this.map.off('mousemove', this.handleMouseMove);
    this.map.off('touchmove', this.handleTouchMove);
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.pendingRing = null;
    this.pendingRotationOverride = null;
    this.pendingRotation = null;
    this.drag = null;
    this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = '';
  }

  private updateSource(): void {
    const source = this.map.getSource(HANDLES_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) {
      return;
    }
    source.setData(this.visible && this.object ? this.buildData(this.object) : this.emptyData());
  }

  private buildData(obj: UserObject): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    // Draw the handles at the ROTATED footprint so they sit on the mesh on screen.
    const rotatedRing = rotateRingAboutCentroid(obj.ring, obj.rotationDeg, this.callbacks.getCenter());

    // Body fill polygon (drag surface for rotation) under the point handles.
    if (rotatedRing.length >= 3) {
      const closed = rotatedRing.map(([lng, lat]) => [lng, lat] as [number, number]);
      closed.push([rotatedRing[0][0], rotatedRing[0][1]]);
      features.push({
        type: 'Feature',
        properties: { handle: 'body', index: -1 },
        geometry: { type: 'Polygon', coordinates: [closed] },
      });
    }

    rotatedRing.forEach(([lng, lat], index) => {
      features.push({
        type: 'Feature',
        properties: { handle: 'vertex', index },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    });

    const centroid = this.centroidLngLat(obj.ring);
    const rotateHandle = this.rotateHandleLngLat(centroid, obj.rotationDeg);

    features.push({
      type: 'Feature',
      properties: { handle: 'rotate', index: -1 },
      geometry: { type: 'LineString', coordinates: [centroid, rotateHandle] },
    });
    features.push({
      type: 'Feature',
      properties: { handle: 'move', index: -1 },
      geometry: { type: 'Point', coordinates: centroid },
    });
    features.push({
      type: 'Feature',
      properties: { handle: 'rotate', index: -1 },
      geometry: { type: 'Point', coordinates: rotateHandle },
    });

    return { type: 'FeatureCollection', features };
  }

  /**
   * Maps a rotated-space pointer back onto the unrotated base ring by rotating it
   * about the footprint centroid by -startRotation, in the same local metre frame
   * the layer and collision helpers use (via the scene centre from getCenter()).
   */
  private unrotatePoint(pointer: LngLat, drag: DragState): LngLat {
    if (drag.startRotation === 0) {
      return [pointer[0], pointer[1]];
    }
    // Same lng/lat <-> metre frame the 3D layer extrudes in (see local-frame.ts).
    const frame = localFrame(this.callbacks.getCenter());
    const [centroidEast, centroidNorth] = toLocalMetres(frame, drag.centroid[0], drag.centroid[1]);
    const [pointerEast, pointerNorth] = toLocalMetres(frame, pointer[0], pointer[1]);

    const radians = (-drag.startRotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = pointerEast - centroidEast;
    const dy = pointerNorth - centroidNorth;
    const east = centroidEast + dx * cos - dy * sin;
    const north = centroidNorth + dx * sin + dy * cos;

    return fromLocalMetres(frame, east, north);
  }

  private centroidLngLat(ring: LngLat[]): LngLat {
    if (ring.length === 0) {
      return [0, 0];
    }
    let lng = 0;
    let lat = 0;
    for (const [pointLng, pointLat] of ring) {
      lng += pointLng;
      lat += pointLat;
    }
    return [lng / ring.length, lat / ring.length];
  }

  /**
   * Places the rotate handle `ROTATE_HANDLE_OFFSET_M` metres from the centroid,
   * in the direction implied by the current rotationDeg (0 points north, positive
   * turns counter-clockwise to match the mesh rotation convention).
   */
  private rotateHandleLngLat(centroid: LngLat, rotationDeg: number): LngLat {
    const radians = (rotationDeg * Math.PI) / 180;
    // North at rotation 0, rotating counter-clockwise in the east/north plane.
    const east = -Math.sin(radians) * ROTATE_HANDLE_OFFSET_M;
    const north = Math.cos(radians) * ROTATE_HANDLE_OFFSET_M;
    const metresPerDegLat = 111_320;
    const metresPerDegLng = metresPerDegLat * Math.cos((centroid[1] * Math.PI) / 180);
    const dLng = metresPerDegLng === 0 ? 0 : east / metresPerDegLng;
    const dLat = north / metresPerDegLat;
    return [centroid[0] + dLng, centroid[1] + dLat];
  }

  private normalizeDegrees(degrees: number): number {
    let value = degrees % 360;
    if (value > 180) {
      value -= 360;
    } else if (value < -180) {
      value += 360;
    }
    return Math.round(value);
  }

  private emptyData(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }
}
