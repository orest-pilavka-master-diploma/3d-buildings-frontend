import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { fetchTilesInfo, loadBuildingsGeoJSON, searchAddresses } from './api';
import { DateTimePanel } from './datetime-panel';
import {
  escapeHtml,
  extractFirstCoordinate,
  getFeatureAddress,
  getGeoJSONCenter,
  type LngLat,
} from './geojson';
import {
  BUILDING_COLORS,
  ThreeBuildingsLayer,
  type BackendBuildingInfo,
  type SunDisplay,
} from './three-buildings-layer';
import { UserObjectStore } from './editing/user-objects-store';
import { extractBackendRings, findConflicts, rotateRingAboutCentroid } from './editing/collision';
import { DrawController, EditHandles, type DrawMode } from './editing/draw-controller';
import { AddPanel, type AddPanelValues } from './editing/add-panel';
import { EditPanel } from './editing/edit-panel';
import type { UserObject } from './editing/user-objects-store';
import {
  downloadFeatureCollection,
  exportTimestamp,
  userObjectsToFeatureCollection,
} from './editing/geojson-export';
import { parseUploadedGeoJSON } from './editing/geojson-import';
import { TileController } from './tiling/tile-controller';
import { FACADE_METRICS } from './facade-texture';

const INITIAL_CENTER: LngLat = [24.0297, 49.8397];
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// One host, as the OSM tile policy now recommends: the a/b/c subdomains are
// deprecated, and a single HTTP/2 connection multiplexes every tile request
// instead of opening extra connections per subdomain.
const OSM_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Required element #${id} was not found`);
  }
  return element as T;
}

const nightOverlay = requiredElement<HTMLDivElement>('night-overlay');
// Reparent the night veil INTO the map container so it dims only the map. As a
// top-level sibling it sat behind the panels' backdrop-filter, which samples
// everything painted behind the glass and so bled the dark veil into the panels
// and buttons. Inside #map it is confined to the map, and the frosted panels
// sample only the basemap behind them, as intended.
requiredElement<HTMLDivElement>('map').appendChild(nightOverlay);
const infoElement = requiredElement<HTMLDivElement>('info');
const hintElement = requiredElement<HTMLParagraphElement>('hint');
const searchContainer = requiredElement<HTMLDivElement>('search-container');
const searchInput = requiredElement<HTMLInputElement>('search-input');
const searchResults = requiredElement<HTMLDivElement>('search-results');
const facadeToggle = requiredElement<HTMLInputElement>('facade-toggle');

const style: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: OSM_TILES,
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
    },
  ],
};

const map: MapLibreMap = new maplibregl.Map({
  container: 'map',
  center: INITIAL_CENTER,
  zoom: 17,
  pitch: 65,
  bearing: -55,
  antialias: true,
  style,
});
// ---------- 2D / 3D view toggle (in the navigation control group) ----------

/** Camera for the default tilted 3D view. */
const VIEW_3D = { pitch: 65, bearing: -55 };
/** Pitch below which the map is considered a flat top-down 2D plan. */
const FLAT_PITCH_THRESHOLD = 1;

/**
 * A MapLibre control that adds a 2D/3D toggle button styled like the native
 * zoom/compass buttons. Placed in the same corner and group as the navigation
 * control so the three buttons read as one panel. Clicking flattens the camera
 * to a top-down plan (pitch 0, bearing 0) or restores the tilted 3D view.
 */
class ViewToggleControl implements maplibregl.IControl {
  private readonly targetMap: MapLibreMap;
  private container?: HTMLDivElement;
  private button?: HTMLButtonElement;

  constructor(targetMap: MapLibreMap) {
    this.targetMap = targetMap;
  }

  onAdd(): HTMLElement {
    // A plain wrapper (not a ctrl-group) holding the 2D button group and, right
    // beneath it, the colour legend — so the legend always sits under the 2D button.
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl view-stack';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'maplibregl-ctrl-group';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'view-toggle-btn';
    button.addEventListener('click', () => this.toggle());
    buttonGroup.appendChild(button);

    container.append(buttonGroup, buildLegend());
    this.container = container;
    this.button = button;

    this.sync();
    this.targetMap.on('pitch', this.sync);
    return container;
  }

  onRemove(): void {
    this.targetMap.off('pitch', this.sync);
    this.container?.remove();
    this.container = undefined;
    this.button = undefined;
  }

  private toggle(): void {
    const flat = this.targetMap.getPitch() <= FLAT_PITCH_THRESHOLD;
    // Pin the current centre and zoom so only the pitch/bearing change; without
    // an explicit centre, changing pitch re-projects the screen centre and the
    // map appears to jump to a different location.
    const center = this.targetMap.getCenter();
    const zoom = this.targetMap.getZoom();
    this.targetMap.easeTo(
      flat
        ? { center, zoom, pitch: VIEW_3D.pitch, bearing: VIEW_3D.bearing, duration: 600 }
        : { center, zoom, pitch: 0, bearing: 0, duration: 600 },
    );
  }

  /** Reflects state: "2D" offers flattening, "3D" offers tilting back. */
  private readonly sync = (): void => {
    if (!this.button) {
      return;
    }
    const flat = this.targetMap.getPitch() <= FLAT_PITCH_THRESHOLD;
    this.button.textContent = flat ? '3D' : '2D';
    this.button.setAttribute('aria-pressed', `${flat}`);
    this.button.title = flat ? 'Нахилений вигляд (3D)' : 'Вигляд зверху (2D)';
  };
}

/** Builds the building-colour legend element shown beneath the 2D toggle. */
function buildLegend(): HTMLDivElement {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.setAttribute('aria-label', 'Легенда кольорів будівель');
  const rows: Array<[keyof typeof BUILDING_COLORS, string]> = [
    ['backend', 'Будівлі з бекенду'],
    ['drawn', 'Додані вручну'],
    ['uploaded', 'Завантажені з файлу'],
  ];
  for (const [kind, label] of rows) {
    const row = document.createElement('div');
    row.className = 'legend__row';

    const swatch = document.createElement('span');
    swatch.className = 'legend__swatch';
    swatch.style.background = BUILDING_COLORS[kind];
    swatch.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'legend__label';
    text.textContent = label;

    row.append(swatch, text);
    legend.appendChild(row);
  }
  return legend;
}

// Desired top-to-bottom order in the bottom-right corner: zoom/compass, then the
// 2D toggle, then the legend. MapLibre fills the corner from the bottom up, so
// the view stack (2D toggle with the legend beneath it) is added first and the
// zoom/compass control is added second, placing it on top.
map.addControl(new ViewToggleControl(map), 'bottom-right');
map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

let threeLayer: ThreeBuildingsLayer | null = null;
let searchMarker: maplibregl.Marker | null = null;
let latestSearchRequestId = 0;
/** Drives geohash-tiled viewport streaming; null until the map loads (or in fallback). */
let tileController: TileController | null = null;
/** Dataset version pinned from /tiles/info, threaded into every tile fetch. */
let backendVersion: string | undefined;

function statRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'stat';

  const labelElement = document.createElement('span');
  labelElement.className = 'stat__label';
  labelElement.textContent = label;

  const valueElement = document.createElement('span');
  valueElement.className = 'stat__value';
  valueElement.textContent = value;

  row.append(labelElement, valueElement);
  return row;
}

function showSunInformation(display: SunDisplay): void {
  if (!display.aboveHorizon) {
    const note = document.createElement('p');
    note.className = 'info__note';
    note.textContent = 'Сонце нижче горизонту — тіні немає';
    infoElement.replaceChildren(note);
    return;
  }

  infoElement.replaceChildren(
    statRow('Висота сонця', `${display.altitudeDegrees.toFixed(1)}°`),
    statRow('Азимут сонця', `${display.bearingDegrees.toFixed(1)}°`),
  );
}

function applySun(date: Date): void {
  if (!threeLayer) {
    return;
  }

  const display = threeLayer.updateSun(date);
  if (display) {
    showSunInformation(display);
    // Dim the whole scene (basemap + buildings) once the sun is below the horizon.
    nightOverlay.classList.toggle('is-night', !display.aboveHorizon);
  }
}

const initialDateTime = new Date();
initialDateTime.setHours(12, 0, 0, 0);

const dateTimePanel = new DateTimePanel({
  elements: {
    dateTrigger: requiredElement<HTMLButtonElement>('date-trigger'),
    dateLabel: requiredElement<HTMLSpanElement>('date-label'),
    calendar: requiredElement<HTMLDivElement>('calendar'),
    calendarTitle: requiredElement<HTMLSpanElement>('calendar-title'),
    calendarGrid: requiredElement<HTMLDivElement>('calendar-grid'),
    previousMonth: requiredElement<HTMLButtonElement>('calendar-prev'),
    nextMonth: requiredElement<HTMLButtonElement>('calendar-next'),
    todayButton: requiredElement<HTMLButtonElement>('today-button'),
    timeSlider: requiredElement<HTMLInputElement>('time-slider'),
    timeInput: requiredElement<HTMLInputElement>('time-input'),
    timeTrack: requiredElement<HTMLDivElement>('time-track'),
    sunTimes: requiredElement<HTMLParagraphElement>('sun-times'),
    liveToggle: requiredElement<HTMLInputElement>('live-toggle'),
    liveHint: requiredElement<HTMLSpanElement>('live-hint'),
    playToggle: requiredElement<HTMLButtonElement>('play-toggle'),
    playStep: requiredElement<HTMLSelectElement>('play-step'),
  },
  location: INITIAL_CENTER,
  initial: initialDateTime,
  onChange: (date) => applySun(date),
});

// ---------- User 3D objects: draw + collision-gated add ----------

const userObjectStore = new UserObjectStore();
/** Backend building rings for collision, computed once the GeoJSON loads. */
let backendRings: { id: string; ring: LngLat[] }[] = [];
/** Map centre used to bake rotation into collision candidates; set on load. */
let sceneCenter: LngLat = INITIAL_CENTER;
/** Footprint pending confirmation from the add panel. */
let pendingRing: LngLat[] | null = null;

const addBuildingTrigger = requiredElement<HTMLButtonElement>('add-building-trigger');
const drawModeChooser = requiredElement<HTMLDivElement>('draw-mode-chooser');
const drawModeRectangle = requiredElement<HTMLButtonElement>('draw-mode-rectangle');
const drawModePolygon = requiredElement<HTMLButtonElement>('draw-mode-polygon');
const drawHint = requiredElement<HTMLParagraphElement>('draw-hint');
const saveAllTrigger = requiredElement<HTMLButtonElement>('save-all-trigger');
const uploadTrigger = requiredElement<HTMLButtonElement>('upload-trigger');
const uploadInput = requiredElement<HTMLInputElement>('upload-input');
const uploadMessage = requiredElement<HTMLParagraphElement>('upload-message');

// Add/edit forms live in a fixed panel pinned to the top-right corner.
const addCard = requiredElement<HTMLDivElement>('add-card');
const editCard = requiredElement<HTMLDivElement>('edit-card');

const PENDING_SOURCE_ID = 'user-pending-footprint';
const PENDING_FILL_LAYER_ID = 'user-pending-footprint-fill';
const PENDING_LINE_LAYER_ID = 'user-pending-footprint-line';
let pendingLayersReady = false;

/** Lazily creates the overlay source/layers for the footprint awaiting a height. */
function ensurePendingLayers(): void {
  if (pendingLayersReady) {
    return;
  }
  if (!map.getSource(PENDING_SOURCE_ID)) {
    map.addSource(PENDING_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getLayer(PENDING_FILL_LAYER_ID)) {
    map.addLayer({
      id: PENDING_FILL_LAYER_ID,
      type: 'fill',
      source: PENDING_SOURCE_ID,
      paint: { 'fill-color': '#2f6bff', 'fill-opacity': 0.2 },
    });
  }
  if (!map.getLayer(PENDING_LINE_LAYER_ID)) {
    map.addLayer({
      id: PENDING_LINE_LAYER_ID,
      type: 'line',
      source: PENDING_SOURCE_ID,
      paint: { 'line-color': '#2f6bff', 'line-width': 2 },
    });
  }
  pendingLayersReady = true;
}

/** Tints the pending footprint red when it overlaps an existing object, blue otherwise. */
function applyPendingColor(overlapping: boolean): void {
  const color = overlapping ? '#ff3b30' : '#2f6bff';
  if (map.getLayer(PENDING_FILL_LAYER_ID)) {
    map.setPaintProperty(PENDING_FILL_LAYER_ID, 'fill-color', color);
    map.setPaintProperty(PENDING_FILL_LAYER_ID, 'fill-opacity', overlapping ? 0.28 : 0.2);
  }
  if (map.getLayer(PENDING_LINE_LAYER_ID)) {
    map.setPaintProperty(PENDING_LINE_LAYER_ID, 'line-color', color);
  }
}

/**
 * Draws (or clears) the flat footprint that stays visible on the map while the
 * add card is open, so the user still sees the polygon they are giving a height.
 * The DrawController wipes its own overlay on finish, so this stand-in keeps the
 * shape on screen until the 3D mesh is created or the add is cancelled. It is
 * tinted red when the footprint overlaps an existing object, matching the live
 * preview colour so the overlap state does not reset to blue on finish.
 */
function showPendingFootprint(ring: LngLat[] | null): void {
  if (ring && ring.length >= 3) {
    ensurePendingLayers();
  }
  const source = map.getSource(PENDING_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) {
    return;
  }
  if (!ring || ring.length < 3) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  applyPendingColor(previewOverlaps(ring));
  const closed = ring.map(([lng, lat]) => [lng, lat] as [number, number]);
  closed.push([ring[0][0], ring[0][1]]);
  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [closed] },
      },
    ],
  });
}

const drawController = new DrawController(map, {
  onFinish: (ring) => {
    pendingRing = ring;
    setDrawingUi('idle');
    showPendingFootprint(ring);
    addPanel.open();
    addCard.hidden = false;
  },
  onCancel: () => {
    pendingRing = null;
    setDrawingUi('idle');
  },
  onPreviewChange: (ring) => previewOverlaps(ring),
});

/**
 * Answers the DrawController's live overlap query: returns true when the preview
 * ring overlaps any backend building or existing user object, so the preview is
 * tinted red. Collision ownership stays here where the rings live.
 */
function previewOverlaps(ring: LngLat[]): boolean {
  const others = [
    ...backendRings,
    ...userObjectStore.all().map((object) => ({
      id: object.id,
      ring: rotateRingAboutCentroid(object.ring, object.rotationDeg, sceneCenter),
    })),
  ];
  return findConflicts(ring, others).length > 0;
}

const addPanel = new AddPanel({
  elements: {
    container: requiredElement<HTMLDivElement>('add-panel'),
    heightInput: requiredElement<HTMLInputElement>('add-height'),
    confirmButton: requiredElement<HTMLButtonElement>('add-confirm'),
    cancelButton: requiredElement<HTMLButtonElement>('add-cancel'),
    warning: requiredElement<HTMLParagraphElement>('add-warning'),
  },
  onConfirm: (values) => commitUserObject(values),
  onCancel: () => cancelAdd(),
});

const RECTANGLE_HINT = 'Клік — перший кут, рух миші — розмір, другий клік — завершити, Esc — скасувати';
const POLYGON_HINT = 'Клік — додати точку, подвійний клік — завершити, Esc — скасувати, Backspace — видалити точку';

/**
 * Drives the editing UI between its three states: idle (only the trigger),
 * choosing a draw mode (trigger disabled, mode buttons shown), and actively
 * drawing (mode-appropriate hint shown).
 */
function setDrawingUi(state: 'idle' | 'choosing' | DrawMode): void {
  const choosing = state === 'choosing';
  const drawing = state === 'rectangle' || state === 'polygon';
  addBuildingTrigger.disabled = choosing || drawing;
  drawModeChooser.hidden = !choosing;
  drawHint.hidden = !drawing;
  if (state === 'rectangle') {
    drawHint.textContent = RECTANGLE_HINT;
  } else if (state === 'polygon') {
    drawHint.textContent = POLYGON_HINT;
  }
}

addBuildingTrigger.addEventListener('click', () => {
  if (drawController.isActive) {
    return;
  }
  // Offer the mode choice; starting a new draw abandons any active selection.
  clearSelection();
  addPanel.close();
  pendingRing = null;
  setDrawingUi('choosing');
});

/** Begins drawing in the chosen mode once the user picks rectangle or polygon. */
function beginDraw(mode: DrawMode): void {
  if (drawController.isActive) {
    return;
  }
  setDrawingUi(mode);
  drawController.start(mode);
}

drawModeRectangle.addEventListener('click', () => beginDraw('rectangle'));
drawModePolygon.addEventListener('click', () => beginDraw('polygon'));

/** Clears the pending draw + any conflict highlight and closes the add panel. */
function cancelAdd(): void {
  if (threeLayer) {
    threeLayer.setConflictHighlight([]);
  }
  pendingRing = null;
  addCard.hidden = true;
  showPendingFootprint(null);
  addPanel.clearConflictWarning();
  addPanel.close();
}

/**
 * Runs collision against backend buildings + existing user objects, shows a
 * Ukrainian override dialog when the footprint overlaps, and otherwise creates
 * and renders the object.
 */
function commitUserObject(values: AddPanelValues): void {
  if (!pendingRing) {
    return;
  }

  const others = [
    ...backendRings,
    ...userObjectStore.all().map((object) => ({ id: object.id, ring: object.ring })),
  ];
  // A freshly drawn footprint has no rotation, but keep the collision candidate
  // consistent with refreshAllConflicts by baking rotation into the ring.
  const candidate = rotateRingAboutCentroid(pendingRing, 0, sceneCenter);
  const conflicts = findConflicts(candidate, others);

  if (conflicts.length > 0) {
    // The object has no mesh yet; the red pending footprint and the warning
    // dialog convey the overlap, so no mesh tint is needed here.
    addPanel.showConflictWarning(
      conflicts.length,
      () => finalizeUserObject(values),
      () => cancelAdd(),
    );
    return;
  }

  finalizeUserObject(values);
}

/** Creates the store object, adds its mesh, clears highlight and closes the panel. */
function finalizeUserObject(values: AddPanelValues): void {
  if (!pendingRing) {
    return;
  }

  const object = userObjectStore.create(pendingRing, {
    height: values.height,
    source: 'drawn',
  });

  if (threeLayer) {
    threeLayer.addUserObject(object);
    // Recompute the full conflict set so a newly placed overlapping object (and
    // anything it now overlaps) turns red and stays red until resolved.
    refreshAllConflicts(null);
  }
  updateSaveAllState();

  pendingRing = null;
  addCard.hidden = true;
  showPendingFootprint(null);
  addPanel.clearConflictWarning();
  addPanel.close();
}

// ---------- User 3D objects: select + edit ----------

/** The id of the user object currently selected for editing, or null. */
let selectedUserObjectId: string | null = null;

const editPanel = new EditPanel({
  elements: {
    container: requiredElement<HTMLDivElement>('edit-panel'),
    heightInput: requiredElement<HTMLInputElement>('edit-height'),
    rotateInput: requiredElement<HTMLInputElement>('edit-rotate'),
    saveButton: requiredElement<HTMLButtonElement>('edit-save'),
    deleteButton: requiredElement<HTMLButtonElement>('edit-delete'),
    closeButton: requiredElement<HTMLButtonElement>('edit-close'),
    warning: requiredElement<HTMLParagraphElement>('edit-warning'),
  },
  onChange: (patch) => applyEdit(patch),
  onSave: () => saveSelectedObject(),
  onDelete: () => deleteSelected(),
  onClose: () => clearSelection(),
});

/** Enables the "save all" button only when at least one user object exists. */
function updateSaveAllState(): void {
  saveAllTrigger.disabled = userObjectStore.all().length === 0;
}

/** Downloads every user-added object as one GeoJSON FeatureCollection. */
function saveAllObjects(): void {
  const objects = userObjectStore.all();
  if (objects.length === 0) {
    return;
  }
  const collection = userObjectsToFeatureCollection(objects, sceneCenter);
  downloadFeatureCollection(collection, `custom-buildings-${exportTimestamp()}.geojson`);
}

/** Downloads just the selected object as a single-feature GeoJSON FeatureCollection. */
function saveSelectedObject(): void {
  if (!selectedUserObjectId) {
    return;
  }
  const object = userObjectStore.get(selectedUserObjectId);
  if (!object) {
    return;
  }
  const collection = userObjectsToFeatureCollection([object], sceneCenter);
  downloadFeatureCollection(collection, `custom-building-${object.id}-${exportTimestamp()}.geojson`);
}

saveAllTrigger.addEventListener('click', () => saveAllObjects());

// ---------- User 3D objects: upload from GeoJSON ----------

/** Shows a Ukrainian upload status message, styled as an error when `isError`. */
function showUploadMessage(message: string, isError: boolean): void {
  uploadMessage.textContent = message;
  uploadMessage.classList.toggle('is-error', isError);
  uploadMessage.hidden = false;
}

/** Eases the camera to fit the bounding box of the given rings. */
function flyToRings(rings: LngLat[][]): void {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
    }
  }
  if (!Number.isFinite(minLng)) {
    return;
  }
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 80, duration: 800, maxZoom: 18 },
  );
}

/**
 * Parses an uploaded GeoJSON, rejecting the whole file (with a Ukrainian
 * message) unless every feature is a Polygon/MultiPolygon with a positive
 * `height`. Valid footprints become editable "uploaded" user objects; overlaps
 * with existing buildings are flagged red (not blocked), and the camera fits
 * the imported extent.
 */
function importGeoJSON(text: string): void {
  const result = parseUploadedGeoJSON(text);
  if (!result.ok) {
    showUploadMessage(result.error, true);
    return;
  }
  if (!threeLayer) {
    showUploadMessage('Шар будівель ще не готовий. Спробуйте пізніше.', true);
    return;
  }

  const addedRings: LngLat[][] = [];
  for (const footprint of result.footprints) {
    const object = userObjectStore.create(footprint.ring, {
      height: footprint.height,
      minHeight: footprint.minHeight,
      source: 'uploaded',
    });
    threeLayer.addUserObject(object);
    addedRings.push(footprint.ring);
  }

  refreshAllConflicts(null);
  updateSaveAllState();
  flyToRings(addedRings);
  showUploadMessage(`Завантажено об’єктів: ${result.footprints.length}.`, false);
}

uploadTrigger.addEventListener('click', () => uploadInput.click());

uploadInput.addEventListener('change', () => {
  const file = uploadInput.files?.[0];
  if (!file) {
    return;
  }
  file
    .text()
    .then((text) => importGeoJSON(text))
    .catch(() => showUploadMessage('Не вдалося прочитати файл.', true))
    // Reset so selecting the same file again re-triggers the change event.
    .finally(() => {
      uploadInput.value = '';
    });
});

const editHandles = new EditHandles(map, {
  onGeometryChange: (ring, rotationDeg) =>
    applyEdit(rotationDeg === undefined ? { ring } : { ring, rotationDeg }),
  onRotate: (rotationDeg) => applyEdit({ rotationDeg }),
  getCenter: () => sceneCenter,
});

/**
 * The rotation-baked collision ring for a user object: the footprint that is
 * actually on the map. buildUserGeometry rotates obj.ring by obj.rotationDeg
 * about its centroid before extruding, so collision must mirror that.
 */
function userCollisionRing(object: UserObject): { id: string; ring: LngLat[] } {
  return {
    id: object.id,
    ring: rotateRingAboutCentroid(object.ring, object.rotationDeg, sceneCenter),
  };
}

/**
 * Recomputes which user objects overlap anything (a backend building or another
 * user object) and tints that full set red. Overlapping objects stay red whether
 * or not they are selected, so an unresolved overlap remains visible after
 * deselecting. Returns the number of conflicts involving `focusId` (the object
 * currently being edited), for the edit-panel warning.
 */
function refreshAllConflicts(focusId: string | null): number {
  if (!threeLayer) {
    return 0;
  }

  const userRings = userObjectStore.all().map(userCollisionRing);
  const conflicting = new Set<string>();
  let focusConflicts = 0;

  userRings.forEach((candidate, index) => {
    const others = [
      ...backendRings,
      ...userRings.filter((_, other) => other !== index),
    ];
    const hits = findConflicts(candidate.ring, others);
    if (hits.length > 0) {
      conflicting.add(candidate.id);
      if (candidate.id === focusId) {
        focusConflicts = hits.length;
      }
    }
  });

  threeLayer.setConflictHighlight([...conflicting]);
  return focusConflicts;
}

/** Applies a single-field edit to the selected object and re-extrudes it live. */
/**
 * Per-object undo history of pre-edit snapshots. Keyed by object id so Ctrl+Z
 * only ever rewinds the object currently being edited, never another.
 */
const undoHistory = new Map<string, UserObject[]>();
/** Caps the history so a long drag session cannot grow memory without bound. */
const MAX_UNDO_STEPS = 50;
/** Consecutive edits within this window collapse into one undo step. */
const UNDO_COALESCE_MS = 400;
let lastUndoPushId: string | null = null;
let lastUndoPushAt = 0;

/** A deep-enough snapshot of a user object (the only nested field is `ring`). */
function snapshotUserObject(object: UserObject): UserObject {
  return { ...object, ring: object.ring.map(([lng, lat]) => [lng, lat] as LngLat) };
}

/**
 * Records the object's current state before an edit is applied, so Ctrl+Z can
 * restore it. Rapid edits on the same object (slider drags, handle drags) within
 * UNDO_COALESCE_MS collapse into a single undo step so one Ctrl+Z undoes the
 * whole gesture rather than one animation frame.
 */
function pushUndoSnapshot(object: UserObject): void {
  const now = Date.now();
  const coalesce = lastUndoPushId === object.id && now - lastUndoPushAt < UNDO_COALESCE_MS;
  lastUndoPushId = object.id;
  lastUndoPushAt = now;
  if (coalesce) {
    return;
  }
  const stack = undoHistory.get(object.id) ?? [];
  stack.push(snapshotUserObject(object));
  if (stack.length > MAX_UNDO_STEPS) {
    stack.shift();
  }
  undoHistory.set(object.id, stack);
}

function applyEdit(patch: Partial<UserObject>): void {
  if (!selectedUserObjectId) {
    return;
  }
  const current = userObjectStore.get(selectedUserObjectId);
  if (current) {
    pushUndoSnapshot(current);
  }
  const updated = userObjectStore.update(selectedUserObjectId, patch);
  if (!updated) {
    return;
  }
  if (threeLayer) {
    threeLayer.updateUserObject(updated);
  }
  editPanel.setCurrent(updated);
  editHandles.update(updated);
  editPanel.showConflictWarning(refreshAllConflicts(updated.id));
}

/** Restores the selected object to its previous state from the undo history. */
function undoLastEdit(): void {
  if (!selectedUserObjectId) {
    return;
  }
  const stack = undoHistory.get(selectedUserObjectId);
  if (!stack || stack.length === 0) {
    return;
  }
  const previous = stack.pop();
  if (!previous) {
    return;
  }
  // Prevent the restore itself from coalescing with the next fresh edit.
  lastUndoPushId = null;
  const restored = userObjectStore.update(selectedUserObjectId, previous);
  if (!restored) {
    return;
  }
  if (threeLayer) {
    threeLayer.updateUserObject(restored);
  }
  editPanel.setCurrent(restored);
  editHandles.update(restored);
  editPanel.showConflictWarning(refreshAllConflicts(restored.id));
}

document.addEventListener('keydown', (event) => {
  // Ctrl+Z (or Cmd+Z) undoes the last edit to the selected object. Ignore it
  // while typing in an input/select so native text undo still works there.
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
  if (!isUndo || !selectedUserObjectId) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) {
    return;
  }
  event.preventDefault();
  undoLastEdit();
});

/** Selects a user object: highlight, open the edit panel and show its handles. */
function selectUserObject(id: string): void {
  const object = userObjectStore.get(id);
  if (!object || !threeLayer) {
    return;
  }
  selectedUserObjectId = id;
  threeLayer.setSelectedUserObject(id);
  editPanel.open(object);
  editHandles.showHandles(object);
  editPanel.showConflictWarning(refreshAllConflicts(object.id));
  editCard.hidden = false;
}

/** Clears any current selection: drops highlight, hides the panel and handles. */
function clearSelection(): void {
  if (threeLayer) {
    threeLayer.setSelectedUserObject(null);
    // Drop only the blue selection highlight; objects that still overlap keep
    // their red conflict tint so an unresolved overlap stays visible.
    refreshAllConflicts(null);
  }
  selectedUserObjectId = null;
  editHandles.hideHandles();
  editPanel.close();
  editCard.hidden = true;
}

/** Removes the selected object from the store and the scene, then clears selection. */
function deleteSelected(): void {
  if (!selectedUserObjectId) {
    return;
  }
  const id = selectedUserObjectId;
  userObjectStore.remove(id);
  undoHistory.delete(id);
  if (threeLayer) {
    threeLayer.removeUserObject(id);
  }
  updateSaveAllState();
  clearSelection();
}

// Pick a user object on map click, unless drawing or dragging a handle.
/** Popup shown when a backend building is clicked; null when hidden. */
let backendPopup: maplibregl.Popup | null = null;

/** Closes the backend building popup, if shown. */
function clearBackendInfo(): void {
  backendPopup?.remove();
  backendPopup = null;
}

/**
 * Builds the Ukrainian "source" row for the popup, but ONLY for non-OSM heights.
 * `osm` is real data and shown without a note; `predicted` (model estimate) and
 * `fallback` (default value) are flagged as approximate so the viewer knows the
 * height is not measured. Any other/empty source produces no row.
 */
function backendSourceRow(source: string | null): string {
  if (source === 'predicted') {
    return (
      `<div class="building-popup__source building-popup__source--predicted">` +
      `Висота приблизна (прогнозована)</div>`
    );
  }
  if (source === 'fallback') {
    return (
      `<div class="building-popup__source building-popup__source--fallback">` +
      `Висота приблизна (запасне значення)</div>`
    );
  }
  return '';
}

/** Shows a Ukrainian popup with the building's height, address and source at `lngLat`. */
function showBackendInfo(lngLat: LngLat, info: BackendBuildingInfo): void {
  clearBackendInfo();
  const address = info.address ? escapeHtml(info.address) : 'Немає даних';
  const html =
    `<div class="building-popup">` +
    `<div class="building-popup__row"><span>Висота:</span> <strong>${info.height.toFixed(1)} м</strong></div>` +
    `<div class="building-popup__row"><span>Адреса:</span> <strong>${address}</strong></div>` +
    backendSourceRow(info.source) +
    `</div>`;

  // No marker — just the popup, per the requested behaviour.
  backendPopup = new maplibregl.Popup({ closeOnClick: false, offset: 12 })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

map.on('click', (event) => {
  if (drawController.isActive || editHandles.isDragging) {
    return;
  }
  if (!threeLayer) {
    return;
  }
  const point = { x: event.point.x, y: event.point.y };

  // A user object takes priority: select it and never show the backend popup.
  const hitId = threeLayer.pickUserObject(point);
  if (hitId) {
    clearBackendInfo();
    if (hitId !== selectedUserObjectId) {
      selectUserObject(hitId);
    }
    return;
  }

  // Clicking empty space clears any selection and closes an open popup.
  if (selectedUserObjectId) {
    clearSelection();
  }

  const backendInfo = threeLayer.pickBackendBuilding(point);
  if (backendInfo) {
    showBackendInfo([event.lngLat.lng, event.lngLat.lat], backendInfo);
  } else {
    clearBackendInfo();
    // A click on empty space also removes the lingering search-result marker.
    clearSearchMarker();
  }
});

/** Removes the address-search marker and clears the search input/results. */
function clearSearchMarker(): void {
  searchMarker?.remove();
  searchMarker = null;
  searchInput.value = '';
  latestSearchRequestId += 1;
  clearSearchResults();
}

function clearSearchResults(): void {
  searchResults.replaceChildren();
  searchInput.setAttribute('aria-expanded', 'false');
}

function selectSearchResult(result: Awaited<ReturnType<typeof searchAddresses>>[number]): void {
  latestSearchRequestId += 1;
  clearSearchResults();

  const address = getFeatureAddress(result);
  searchInput.value = address === 'N/A' ? '' : address;

  const coordinate = extractFirstCoordinate(result.geometry);
  if (!coordinate) {
    console.warn('Selected search result has no valid coordinate.');
    return;
  }

  searchMarker ??= new maplibregl.Marker();
  searchMarker
    .setLngLat(coordinate)
    .setPopup(
      new maplibregl.Popup().setHTML(`<strong>Адреса:</strong> ${escapeHtml(address)}`),
    )
    .addTo(map)
    .togglePopup();

  map.flyTo({
    center: coordinate,
    zoom: Math.max(map.getZoom(), 18),
    speed: 1.2,
    essential: true,
  });
}

function renderSearchResults(results: Awaited<ReturnType<typeof searchAddresses>>): void {
  searchResults.replaceChildren();

  for (const result of results) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.setAttribute('role', 'option');
    button.textContent = getFeatureAddress(result);
    button.addEventListener('click', () => selectSearchResult(result));
    searchResults.appendChild(button);
  }

  searchInput.setAttribute('aria-expanded', `${results.length > 0}`);
}

searchInput.addEventListener('input', async () => {
  const query = searchInput.value.trim();
  if (!query) {
    latestSearchRequestId += 1;
    clearSearchResults();
    return;
  }

  const requestId = ++latestSearchRequestId;
  try {
    const results = await searchAddresses(query);
    if (requestId === latestSearchRequestId) {
      renderSearchResults(results);
    }
  } catch (error) {
    if (requestId === latestSearchRequestId) {
      clearSearchResults();
      console.error('Failed to search addresses:', error);
    }
  }
});

document.addEventListener('click', (event) => {
  if (!searchContainer.contains(event.target as Node)) {
    latestSearchRequestId += 1;
    clearSearchResults();
  }
});

/**
 * Starts geohash-tiled viewport streaming: reads /tiles/info, pins the scene
 * centre and version, constructs an EMPTY Three layer at that centre, then wires
 * a {@link TileController} that loads only the tiles the camera can actually see
 * and keeps `backendRings` in sync for user-object collision.
 */
async function startTiledStreaming(): Promise<void> {
  const info = await fetchTilesInfo();
  backendVersion = info.version;
  if (info.center) {
    sceneCenter = [info.center.lng, info.center.lat];
    map.jumpTo({ center: sceneCenter });
  } else {
    sceneCenter = INITIAL_CENTER;
  }
  dateTimePanel.setLocation(sceneCenter);

  // The Three layer starts empty; tiles stream in via the controller. The metre
  // frame is pinned to sceneCenter so later tiles never shift placed geometry.
  threeLayer = new ThreeBuildingsLayer({ type: 'FeatureCollection', features: [] }, sceneCenter);
  map.addLayer(threeLayer);
  threeLayer.setFacadesEnabled(facadeToggle.checked);

  const layer = threeLayer;
  tileController = new TileController({
    map,
    layer: {
      hasBackendTile: (geohash) => layer.hasBackendTile(geohash),
      addBackendTileData: (geohash, data) => layer.addBackendTileData(geohash, data),
      removeBackendTile: (geohash) => layer.removeBackendTile(geohash),
    },
    version: backendVersion,
    // Tile geometry is built in Web Workers in the layer's metre frame.
    center: sceneCenter,
    facade: FACADE_METRICS,
    // Clamp per-level caps to the backend's advertised per-request limit so a
    // single /tiles request never exceeds what the server will accept.
    maxGeohashes: info.maxGeohashes,
    onTilesChanged: (rings, loadedCount) => {
      backendRings = rings;
      // Keep user-object collision in sync with the live backend tile set.
      refreshAllConflicts(selectedUserObjectId);
      hintElement.textContent = `Завантажено плиток: ${loadedCount}.`;
    },
  });

  // Light the scene right away, start listening (so panning during the first
  // load is picked up), then stream the first view; tiles appear as they arrive.
  applySun(dateTimePanel.value);
  tileController.start();
  await tileController.refresh();
}

/**
 * Legacy one-shot fallback used when /tiles/info is unreachable, so nothing
 * regresses: fetch every building once and build the layer with the full
 * collection, exactly as before tiling existed.
 */
async function startLegacyOneShot(): Promise<void> {
  const geojson = await loadBuildingsGeoJSON();
  const center = getGeoJSONCenter(geojson);
  if (!center) {
    hintElement.textContent = 'Бекенд не повернув будівель із коректною геометрією.';
    console.warn('Building GeoJSON contains no valid coordinates; the 3D layer was not added.');
    return;
  }

  map.setCenter(center);
  sceneCenter = center;
  dateTimePanel.setLocation(center);
  backendRings = extractBackendRings(geojson);
  threeLayer = new ThreeBuildingsLayer(geojson, center);
  map.addLayer(threeLayer);
  threeLayer.setFacadesEnabled(facadeToggle.checked);
  hintElement.textContent = `Завантажено ${geojson.features.length} будівель із бекенду.`;
  applySun(dateTimePanel.value);
}

map.on('load', async () => {
  hintElement.textContent = 'Будівлі завантажуються з бекенду...';

  try {
    await startTiledStreaming();
  } catch (error) {
    console.error('Tiled streaming failed; falling back to one-shot load:', error);
    try {
      await startLegacyOneShot();
    } catch (fallbackError) {
      hintElement.textContent = 'Не вдалося завантажити будівлі з бекенду.';
      console.error('Failed to load building GeoJSON from /backend/fetch-data:', fallbackError);
    }
  }
});

// Toggle procedural facades on/off for every building (no geometry rebuild).
// Guarded because the layer is created only once the map load handler runs.
facadeToggle.addEventListener('change', () => {
  threeLayer?.setFacadesEnabled(facadeToggle.checked);
});
