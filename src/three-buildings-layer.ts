import type { FeatureCollection, Position } from 'geojson';
import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';
import { MercatorCoordinate } from 'maplibre-gl';
import SunCalc from 'suncalc';
import * as THREE from 'three';
import { isValidCoordinate, type LngLat } from './geojson';
import { toLocalMetres, type LocalFrame } from './local-frame';
import { createFacadeTextures, type FacadeTextures } from './facade-texture';
import {
  assignExtrudeFacadeUVs,
  assignSegmentedFacadeUVs,
  facadeUvOffset,
  GROUND_WALL_MATERIAL_INDEX,
  UPPER_WALL_MATERIAL_INDEX,
} from './facade-uv';
import type { UserObject } from './editing/user-objects-store';
import {
  buildTileGeometry,
  type BackendBuildingInfo,
  type TileGeometryData,
} from './tiling/tile-build';

export type { BackendBuildingInfo } from './tiling/tile-build';

/**
 * One backend geohash tile on the map: a single merged mesh (null for an empty
 * cell) plus the per-building tables used for click picking.
 */
interface BackendTile {
  mesh: THREE.Mesh | null;
  /** Bounding box of the whole tile in local metres (empty for an empty tile). */
  box: THREE.Box3;
  buildingRanges: Uint32Array;
  buildingBoxes: Float32Array;
  infos: BackendBuildingInfo[];
}

/** Requested shadow map resolution; clamped to what the GL context supports. */
const PREFERRED_SHADOW_MAP_SIZE = 4096;
/** Lower bound on tan(sun altitude) so shadows stay finite near sunrise/sunset. */
const MIN_SUN_TANGENT = 0.06;
/** Upper bound (metres) on how far a shadow is allowed to reach. */
const MAX_SHADOW_REACH = 1500;
/** Extra ground (metres) around the buildings so shadows always land on a surface. */
const GROUND_MARGIN = 4000;
/** Shadow geometry smaller than this (metres) is not worth refitting the camera for. */
const REFIT_EPSILON = 0.01;

/**
 * Category colours for the three building kinds. Warm, muted greys chosen to
 * read as a modern flat-design map and to show the cast shadows clearly. These
 * are the single source of truth for building colour; the legend mirrors them.
 */
export const BUILDING_COLORS = {
  /** Buildings loaded from the backend. */
  backend: '#9a938a',
  /** Buildings drawn on the map by the user. */
  drawn: '#b8a894',
  /** Buildings imported from an uploaded GeoJSON file. */
  uploaded: '#8f9a94',
} as const;

/** The three building categories; each has its own shared cap/wall material pair. */
type FacadeCategory = keyof typeof BUILDING_COLORS;

/** Warm window glow colour applied to the emissive tint at night. */
const NIGHT_EMISSIVE_HEX = 0xffffff;
/** Selection highlight (blue) emissive colour and intensity. */
const SELECTION_EMISSIVE_HEX = 0x2f6bff;
const SELECTION_EMISSIVE_INTENSITY = 0.45;
/** Conflict highlight (red) emissive colour and intensity. */
const CONFLICT_EMISSIVE_HEX = 0xff3b30;
const CONFLICT_EMISSIVE_INTENSITY = 0.6;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, -1);

/**
 * Synthetic tile key under which the one-shot fallback path (constructor
 * features / {@link ThreeBuildingsLayer.addGeoJSONBuildings}) stores every
 * mesh. The tile controller never addresses this key, so its eviction logic
 * cannot touch fallback geometry.
 */
const FALLBACK_TILE_KEY = '__fallback__';

type GroundRegion = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type SunDisplay =
  | { aboveHorizon: false }
  | {
      aboveHorizon: true;
      altitudeDegrees: number;
      bearingDegrees: number;
      /** Shadow length per metre of height, i.e. cot(sun altitude). */
      shadowRatio: number;
    };

/**
 * Renders the building GeoJSON as extruded Three.js meshes inside a MapLibre custom layer
 * and casts sun shadows onto a transparent ground plane.
 *
 * Local coordinates are metres relative to `center`: +x east, +y up, +z south.
 */
export class ThreeBuildingsLayer implements CustomLayerInterface {
  readonly id = 'three-buildings';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private readonly mercatorCenter: MercatorCoordinate;
  private readonly meterScale: number;
  /** lng/lat <-> local metres, matching the metres->Mercator mapping in render(). */
  private readonly frame: LocalFrame;
  private map?: MapLibreMap;
  private camera?: THREE.Camera;
  private scene?: THREE.Scene;
  private renderer?: THREE.WebGLRenderer;
  private world?: THREE.Group;
  private ground?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private sunTarget?: THREE.Object3D;
  private sunLight?: THREE.DirectionalLight;
  /**
   * Backend buildings keyed by geohash tile. Each tile is ONE merged mesh
   * holding every building in that cell (3 draw calls per pass instead of 3 per
   * building). The one-shot fallback path stores its buildings under
   * {@link FALLBACK_TILE_KEY}.
   */
  private readonly backendTiles = new Map<string, BackendTile>();
  /**
   * Set when tiles or user objects changed; the building box, ground plane and
   * shadow camera are refit once in the next frame instead of once per change.
   */
  private geometryDirty = false;
  private readonly userMeshes = new Map<string, THREE.Mesh>();
  private selectedUserObjectId: string | null = null;
  private readonly conflictUserObjectIds = new Set<string>();

  /** Shared day/night facade textures; created once in onAdd, disposed in onRemove. */
  private facadeTextures?: FacadeTextures;
  /** Shared cap (roof/floor) materials, one per category. */
  private sharedCapMaterials?: Record<FacadeCategory, THREE.MeshLambertMaterial>;
  /** Shared upper-floor wall materials carrying the day window map, one per category. */
  private sharedWallMaterials?: Record<FacadeCategory, THREE.MeshLambertMaterial>;
  /** Shared ground-floor wall materials carrying the door/shopfront map, one per category. */
  private sharedGroundWallMaterials?: Record<FacadeCategory, THREE.MeshLambertMaterial>;
  /** Whether facades are drawn; when false the walls are flat category colour. */
  private facadesEnabled = true;
  /** Last computed day/night state, so toggles can re-apply the correct glow. */
  private isNight = false;

  private shadowMapSize = PREFERRED_SHADOW_MAP_SIZE;
  private readonly buildingBox = new THREE.Box3();
  /** Unit vector from the ground towards the sun, in local coordinates. */
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);
  private sunAltitude = 0;
  private sunAboveHorizon = false;
  /** Fingerprint of the shadow camera currently uploaded to the GPU. */
  private appliedShadowKey = '';

  constructor(
    private readonly geojson: FeatureCollection,
    private readonly center: LngLat,
  ) {
    this.mercatorCenter = MercatorCoordinate.fromLngLat(center, 0);
    this.meterScale = this.mercatorCenter.meterInMercatorCoordinateUnits();
    this.frame = {
      originX: this.mercatorCenter.x,
      originY: this.mercatorCenter.y,
      meterScale: this.meterScale,
    };
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext): void {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
      alpha: true,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The shadow map is re-rendered only when the sun or the fitted camera changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowMapSize = Math.min(
      PREFERRED_SHADOW_MAP_SIZE,
      this.renderer.capabilities.maxTextureSize,
    );

    this.world = new THREE.Group();
    this.scene.add(this.world);

    // Facade textures and the shared per-category materials must exist before
    // any mesh is built, so create them ahead of addGeoJSONBuildings().
    this.createSharedFacadeMaterials();

    this.addGeoJSONBuildings();
    this.updateBuildingBox();

    const buildingCenter = this.buildingBox.isEmpty()
      ? new THREE.Vector3()
      : this.buildingBox.getCenter(new THREE.Vector3());
    const groundSize = this.buildingBox.isEmpty()
      ? GROUND_MARGIN
      : Math.max(
        this.buildingBox.max.x - this.buildingBox.min.x,
        this.buildingBox.max.z - this.buildingBox.min.z,
      ) + GROUND_MARGIN;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.ShadowMaterial({ opacity: 0.4 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(buildingCenter.x, 0.02, buildingCenter.z);
    this.ground.receiveShadow = true;
    this.ground.frustumCulled = false;
    // The plane only blends a shadow over the basemap; it must not occlude anything.
    this.ground.material.depthWrite = false;
    this.world.add(this.ground);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 0.8));

    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
    this.sunLight.castShadow = true;
    this.sunLight.target = this.sunTarget;
    this.sunLight.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    // Depth bias is derived from the fitted texel size in updateShadowCamera().
    this.sunLight.shadow.bias = -0.00005;
    this.scene.add(this.sunLight);
  }

  /**
   * Creates the shared facade CanvasTextures and the 3 cap + 3 upper-wall +
   * 3 ground-wall shared materials (one trio per category). The cap material is
   * a plain matte colour (roofs show no windows); the upper-wall material
   * carries the repeating window map; the ground-wall material carries the
   * door/shopfront map for the lowest storey. All buildings of a category share
   * these instances, so there is exactly one texture-upload per map and
   * per-building variation is achieved through UVs.
   */
  private createSharedFacadeMaterials(): void {
    if (!this.renderer) {
      return;
    }
    const textures = createFacadeTextures(this.renderer.capabilities.getMaxAnisotropy());
    this.facadeTextures = textures;

    const categories: FacadeCategory[] = ['backend', 'drawn', 'uploaded'];
    const capMaterials = {} as Record<FacadeCategory, THREE.MeshLambertMaterial>;
    const wallMaterials = {} as Record<FacadeCategory, THREE.MeshLambertMaterial>;
    const groundWallMaterials = {} as Record<FacadeCategory, THREE.MeshLambertMaterial>;
    for (const category of categories) {
      capMaterials[category] = new THREE.MeshLambertMaterial({
        color: BUILDING_COLORS[category],
      });
      wallMaterials[category] = new THREE.MeshLambertMaterial({
        color: BUILDING_COLORS[category],
        map: this.facadesEnabled ? textures.day : null,
      });
      groundWallMaterials[category] = new THREE.MeshLambertMaterial({
        color: BUILDING_COLORS[category],
        map: this.facadesEnabled ? textures.groundDay : null,
      });
    }
    this.sharedCapMaterials = capMaterials;
    this.sharedWallMaterials = wallMaterials;
    this.sharedGroundWallMaterials = groundWallMaterials;
  }

  render(...args: Parameters<CustomLayerInterface['render']>): void {
    const matrix = args[1];
    if (!this.camera || !this.renderer || !this.scene || !this.map) {
      return;
    }

    const mapMatrix = new THREE.Matrix4().fromArray(matrix);
    const translation = new THREE.Matrix4().makeTranslation(
      this.mercatorCenter.x,
      this.mercatorCenter.y,
      this.mercatorCenter.z,
    );
    const scale = new THREE.Matrix4().makeScale(
      this.meterScale,
      -this.meterScale,
      this.meterScale,
    );
    const rotation = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const localToMercator = new THREE.Matrix4()
      .multiply(translation)
      .multiply(scale)
      .multiply(rotation);

    this.camera.projectionMatrix = new THREE.Matrix4()
      .multiply(mapMatrix)
      .multiply(localToMercator);

    // Apply any pending tile/user-object changes once per frame.
    if (this.geometryDirty) {
      this.applyGeometryChange();
    }

    // Keep the shadow map focused on what the user is currently looking at.
    this.updateShadowCamera();

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    // No triggerRepaint() here: MapLibre already calls render() whenever the map
    // moves, and every state change in this layer requests its own repaint.
    // Repainting unconditionally kept the GPU redrawing the whole city (and
    // starving basemap tile work) even when nothing on screen changed.
  }

  onRemove(): void {
    this.clearBuildingMeshes();
    this.clearUserMeshes();

    if (this.ground && this.world) {
      this.world.remove(this.ground);
      this.ground.geometry.dispose();
      this.ground.material.dispose();
    }

    // Shared facade materials and textures are owned by the layer; dispose the
    // 9 materials and the 3 textures exactly once here.
    for (const material of Object.values(this.sharedCapMaterials ?? {})) {
      material.dispose();
    }
    for (const material of Object.values(this.sharedWallMaterials ?? {})) {
      material.dispose();
    }
    for (const material of Object.values(this.sharedGroundWallMaterials ?? {})) {
      material.dispose();
    }
    this.facadeTextures?.dispose();
    this.sharedCapMaterials = undefined;
    this.sharedWallMaterials = undefined;
    this.sharedGroundWallMaterials = undefined;
    this.facadeTextures = undefined;

    this.sunLight?.shadow.map?.dispose();
    this.map = undefined;
    this.camera = undefined;
    this.scene = undefined;
    this.renderer = undefined;
    this.world = undefined;
    this.ground = undefined;
    this.sunTarget = undefined;
    this.sunLight = undefined;
  }

  updateSun(date: Date): SunDisplay | null {
    if (!this.sunLight || !this.sunTarget || !this.ground || !this.renderer || !this.map) {
      return null;
    }

    // The shadow reach below depends on the building box; bring it up to date.
    if (this.geometryDirty) {
      this.applyGeometryChange();
    }

    const sun = SunCalc.getPosition(date, this.center[1], this.center[0]);
    const altitude = sun.altitude;
    const altitudeDegrees = altitude * 180 / Math.PI;
    const bearingDegrees = (sun.azimuth * 180 / Math.PI + 180 + 360) % 360;

    this.sunAltitude = altitude;
    this.sunAboveHorizon = altitude > 0;

    if (!this.sunAboveHorizon) {
      this.sunLight.visible = false;
      this.sunLight.castShadow = false;
      this.sunLight.intensity = 0;
      this.ground.visible = false;
      this.appliedShadowKey = '';
      this.renderer.shadowMap.needsUpdate = true;
      this.applyDayNight(true);
      this.map.triggerRepaint();
      return { aboveHorizon: false };
    }

    this.sunLight.visible = true;
    this.sunLight.castShadow = true;
    this.sunLight.intensity = 0.9;
    this.ground.visible = true;
    this.applyDayNight(false);

    // Local frame: +x east, +y up, +z south. The bearing is measured clockwise from north.
    const bearingRadians = bearingDegrees * Math.PI / 180;
    this.sunDirection
      .set(
        Math.sin(bearingRadians) * Math.cos(altitude),
        Math.sin(altitude),
        -Math.cos(bearingRadians) * Math.cos(altitude),
      )
      .normalize();

    // Force a refit: the light moved, so the previous fingerprint is stale.
    this.appliedShadowKey = '';
    this.updateShadowCamera();
    this.map.triggerRepaint();

    return {
      aboveHorizon: true,
      altitudeDegrees,
      bearingDegrees,
      shadowRatio: 1 / Math.tan(altitude),
    };
  }

  /** Horizontal distance (metres) the tallest building's shadow can travel. */
  private shadowReach(): number {
    const height = Math.max(this.buildingBox.isEmpty() ? 0 : this.buildingBox.max.y, 1);
    const tangent = Math.max(Math.tan(this.sunAltitude), MIN_SUN_TANGENT);
    return Math.min(height / tangent, MAX_SHADOW_REACH);
  }

  /** The visible map footprint in local metres, or null when it cannot be determined. */
  private viewRegion(): GroundRegion | null {
    if (!this.map) {
      return null;
    }

    const bounds = this.map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    if (![west, east, south, north].every((value) => Number.isFinite(value))) {
      return null;
    }

    const southWest = this.lngLatToLocalMeters(west, south);
    const northEast = this.lngLatToLocalMeters(east, north);
    return {
      minX: Math.min(southWest.x, northEast.x),
      maxX: Math.max(southWest.x, northEast.x),
      // y is northing in local metres, z is southing.
      minZ: Math.min(-southWest.y, -northEast.y),
      maxZ: Math.max(-southWest.y, -northEast.y),
    };
  }

  /**
   * Ground area the shadow map must cover: the visible part of the scene, widened
   * towards the sun so buildings just outside the view still cast into it.
   */
  private shadowRegion(): GroundRegion {
    const reach = this.shadowReach();
    const padded: GroundRegion = {
      minX: this.buildingBox.min.x - reach,
      maxX: this.buildingBox.max.x + reach,
      minZ: this.buildingBox.min.z - reach,
      maxZ: this.buildingBox.max.z + reach,
    };

    const view = this.viewRegion();
    let visible = padded;
    if (view) {
      const clipped: GroundRegion = {
        minX: Math.max(padded.minX, view.minX),
        maxX: Math.min(padded.maxX, view.maxX),
        minZ: Math.max(padded.minZ, view.minZ),
        maxZ: Math.min(padded.maxZ, view.maxZ),
      };
      if (clipped.maxX - clipped.minX > 1 && clipped.maxZ - clipped.minZ > 1) {
        visible = clipped;
      }
    }

    // Casters sit up-sun of the shadows they throw into the visible area.
    const horizontal = Math.hypot(this.sunDirection.x, this.sunDirection.z);
    if (horizontal < 1e-6) {
      return visible;
    }

    const offsetX = this.sunDirection.x / horizontal * reach;
    const offsetZ = this.sunDirection.z / horizontal * reach;
    const casters: GroundRegion = {
      minX: Math.max(this.buildingBox.min.x, visible.minX + Math.min(offsetX, 0)),
      maxX: Math.min(this.buildingBox.max.x, visible.maxX + Math.max(offsetX, 0)),
      minZ: Math.max(this.buildingBox.min.z, visible.minZ + Math.min(offsetZ, 0)),
      maxZ: Math.min(this.buildingBox.max.z, visible.maxZ + Math.max(offsetZ, 0)),
    };
    if (casters.maxX <= casters.minX || casters.maxZ <= casters.minZ) {
      return visible;
    }

    return {
      minX: Math.min(visible.minX, casters.minX),
      maxX: Math.max(visible.maxX, casters.maxX),
      minZ: Math.min(visible.minZ, casters.minZ),
      maxZ: Math.max(visible.maxZ, casters.maxZ),
    };
  }

  /**
   * Fits the directional light's orthographic shadow camera to the current view.
   *
   * A fixed shadow frustum wastes almost all of its resolution when the user zooms in,
   * which turns shadow edges into a blurry smear. Refitting keeps the texel size
   * proportional to what is on screen, and snapping the frustum to texel boundaries
   * stops the shadow from shimmering while panning.
   */
  private updateShadowCamera(): void {
    const light = this.sunLight;
    const target = this.sunTarget;
    if (!light || !target || !this.renderer || !this.sunAboveHorizon || this.buildingBox.isEmpty()) {
      return;
    }

    const region = this.shadowRegion();
    const height = Math.max(this.buildingBox.max.y, 1);
    const center = new THREE.Vector3(
      (region.minX + region.maxX) / 2,
      height / 2,
      (region.minZ + region.maxZ) / 2,
    );
    const radius = Math.hypot(
      region.maxX - region.minX,
      region.maxZ - region.minZ,
      height,
    ) / 2;
    const position = center.clone().addScaledVector(this.sunDirection, radius + height + 10);

    // Three.js orients the shadow camera with camera.up, so fit in the same basis.
    const up = Math.abs(this.sunDirection.y) > 0.999 ? FALLBACK_UP : WORLD_UP;
    const lightToWorld = new THREE.Matrix4().lookAt(position, center, up).setPosition(position);
    const worldToLight = lightToWorld.clone().invert();

    let left = Infinity;
    let right = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    let nearestZ = -Infinity;
    let farthestZ = Infinity;
    const corner = new THREE.Vector3();
    for (const x of [region.minX, region.maxX]) {
      for (const y of [0, height]) {
        for (const z of [region.minZ, region.maxZ]) {
          corner.set(x, y, z).applyMatrix4(worldToLight);
          left = Math.min(left, corner.x);
          right = Math.max(right, corner.x);
          bottom = Math.min(bottom, corner.y);
          top = Math.max(top, corner.y);
          nearestZ = Math.max(nearestZ, corner.z);
          farthestZ = Math.min(farthestZ, corner.z);
        }
      }
    }

    // Snap the frustum to whole shadow-map texels to avoid edge shimmer while panning.
    const texel = Math.max(right - left, top - bottom) / this.shadowMapSize;
    left = Math.floor(left / texel) * texel;
    right = Math.ceil(right / texel) * texel;
    bottom = Math.floor(bottom / texel) * texel;
    top = Math.ceil(top / texel) * texel;

    const near = Math.max(0.5, -nearestZ - 1);
    const far = -farthestZ + 1;

    const key = [left, right, top, bottom, near, far]
      .map((value) => Math.round(value / REFIT_EPSILON))
      .join(',');
    if (key === this.appliedShadowKey) {
      return;
    }
    this.appliedShadowKey = key;

    light.position.copy(position);
    target.position.copy(center);
    target.updateMatrixWorld();
    light.updateMatrixWorld();

    const shadowCamera = light.shadow.camera;
    shadowCamera.up.copy(up);
    shadowCamera.left = left;
    shadowCamera.right = right;
    shadowCamera.top = top;
    shadowCamera.bottom = bottom;
    shadowCamera.near = near;
    shadowCamera.far = far;
    shadowCamera.updateProjectionMatrix();

    // Offsetting along the surface normal by about a texel removes shadow acne on
    // roofs and walls without detaching shadows from the walls that cast them.
    light.shadow.normalBias = Math.min(Math.max(texel * 1.5, 0.01), 0.5);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private updateBuildingBox(): void {
    this.buildingBox.makeEmpty();
    // Tile boxes are computed once when the tile is added, so this is
    // O(tiles) rather than O(all building vertices).
    for (const tile of this.backendTiles.values()) {
      if (!tile.box.isEmpty()) {
        this.buildingBox.union(tile.box);
      }
    }
    for (const mesh of this.userMeshes.values()) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (box) {
        this.buildingBox.union(box);
      }
    }
  }

  /**
   * Local metres of a lng/lat, as the exact inverse of the linear
   * metres->Mercator mapping used in render(), so geometry lands exactly where
   * MapLibre draws the same lng/lat (edit handles, markers, basemap).
   */
  private lngLatToLocalMeters(lng: number, lat: number): THREE.Vector2 {
    const [east, north] = toLocalMetres(this.frame, lng, lat);
    return new THREE.Vector2(east, north);
  }

  private ringToShapePoints(ring: Position[]): THREE.Vector2[] {
    let coordinates = ring.filter(isValidCoordinate);
    if (coordinates.length > 1) {
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) {
        coordinates = coordinates.slice(0, -1);
      }
    }

    return coordinates.map(([lng, lat]) => this.lngLatToLocalMeters(lng, lat));
  }

  /**
   * Creates the merged mesh of one tile from pre-built buffers (built in the
   * tile Web Worker, or by {@link buildTileGeometry} on the fallback path).
   *
   * The geometry holds three contiguous sections matching the shared
   * [cap(0), upperWall(1), groundWall(2)] material array, so the whole tile is
   * three draw calls per pass. Frustum culling is on: a tile that is off-screen
   * costs nothing in the main pass (the shadow pass culls against the light).
   */
  private createTileEntry(data: TileGeometryData): BackendTile {
    const [capCount, upperCount, groundCount] = data.sectionVertexCounts;
    const total = capCount + upperCount + groundCount;
    const box = new THREE.Box3();
    if (total === 0) {
      return { mesh: null, box, buildingRanges: data.buildingRanges, buildingBoxes: data.buildingBoxes, infos: data.infos };
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    if (capCount > 0) {
      geometry.addGroup(0, capCount, 0);
    }
    if (upperCount > 0) {
      geometry.addGroup(capCount, upperCount, UPPER_WALL_MATERIAL_INDEX);
    }
    if (groundCount > 0) {
      geometry.addGroup(capCount + upperCount, groundCount, GROUND_WALL_MATERIAL_INDEX);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (geometry.boundingBox) {
      box.copy(geometry.boundingBox);
    }

    // Diffuse-only Lambert materials shared by every backend building; the
    // per-building facade phase is baked into the UVs.
    const mesh = new THREE.Mesh(geometry, this.wallCapMaterialArray('backend'));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return { mesh, box, buildingRanges: data.buildingRanges, buildingBoxes: data.buildingBoxes, infos: data.infos };
  }

  /** Disposes a tile's geometry (materials and textures are shared and kept). */
  private disposeTileEntry(tile: BackendTile): void {
    if (tile.mesh) {
      this.world?.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
  }

  /**
   * Builds the extruded geometry for a user object.
   *
   * Rotation convention: obj.rotationDeg is applied to the 2D footprint points
   * (in the local metre frame) around their own centroid BEFORE extrusion, so
   * the extruded mesh needs no per-mesh transform and its geometry bounding box
   * is already in world-local coordinates. Positive rotationDeg turns the
   * footprint counter-clockwise in the x/y shape plane (which is the +x east /
   * +y north plane before the rotateX(-PI/2) maps y-north to -z-south).
   *
   * When twistDeg !== 0 || taper !== 1 the straight path is bypassed and a
   * segmented stacked-slice solid is built instead (see buildTwistedGeometry).
   */
  private buildUserGeometry(obj: UserObject): THREE.BufferGeometry {
    const uvOffset = facadeUvOffset(obj.id);
    const textures = this.facadeTextures;

    if (obj.twistDeg !== 0 || obj.taper !== 1) {
      const { geometry, ringCount, segments } = this.buildTwistedGeometry(obj);
      if (textures) {
        assignSegmentedFacadeUVs(
          geometry,
          ringCount,
          segments,
          textures.metresPerRepeatU,
          textures.metresPerRepeatV,
          uvOffset,
          textures.groundFloorMetres,
        );
      }
      return geometry;
    }

    let points = this.ringToShapePoints(obj.ring);
    points = this.rotatePointsAboutCentroid(points, obj.rotationDeg);

    const shape = new THREE.Shape(points);
    const depth = Math.max(obj.height - obj.minHeight, 0.1);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, obj.minHeight, 0);
    if (textures) {
      assignExtrudeFacadeUVs(
        geometry,
        textures.metresPerRepeatU,
        textures.metresPerRepeatV,
        uvOffset,
        textures.groundFloorMetres,
      );
    }
    return geometry;
  }

  /**
   * Builds a twisted and/or tapered solid from stacked horizontal slices.
   *
   * The footprint is first rotated by obj.rotationDeg about its centroid (same
   * convention as the straight path). Each slice i (t = i/segments) is then
   * rotated by an ADDITIONAL obj.twistDeg * t about the centroid and scaled
   * about the centroid by lerp(1, obj.taper, t), and placed at
   * y = minHeight + (height - minHeight) * t.
   *
   * Unlike the straight path, slices are authored directly in the local
   * +y-up metre frame (x=east, y=up, z=south): a 2D footprint point (px, py)
   * with py = north maps to world (px, y, -py). No rotateX(-PI/2) is applied
   * here because the vertices are already in that final frame. Positive twist
   * is counter-clockwise in the east/north plane, matching rotationDeg.
   */
  private buildTwistedGeometry(obj: UserObject): {
    geometry: THREE.BufferGeometry;
    ringCount: number;
    segments: number;
  } {
    const base = this.rotatePointsAboutCentroid(
      this.ringToShapePoints(obj.ring),
      obj.rotationDeg,
    );

    const geometry = new THREE.BufferGeometry();
    if (base.length < 3) {
      return { geometry, ringCount: base.length, segments: 0 };
    }

    const centroid = new THREE.Vector2();
    for (const point of base) {
      centroid.add(point);
    }
    centroid.divideScalar(base.length);

    const span = Math.max(obj.height - obj.minHeight, 0.1);
    const ringCount = base.length;
    const segments = Math.min(64, Math.max(2, Math.round(span)));
    const twistRadians = obj.twistDeg * Math.PI / 180;

    // One ring of `ringCount` vertices per slice level (segments + 1 levels).
    const positions: number[] = [];
    const slicePoint = (level: number, index: number): THREE.Vector3 => {
      const t = level / segments;
      const angle = twistRadians * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const scale = 1 + (obj.taper - 1) * t;
      const dx = (base[index].x - centroid.x) * scale;
      const dy = (base[index].y - centroid.y) * scale;
      const east = centroid.x + dx * cos - dy * sin;
      const north = centroid.y + dx * sin + dy * cos;
      return new THREE.Vector3(east, obj.minHeight + span * t, -north);
    };

    for (let level = 0; level <= segments; level += 1) {
      for (let index = 0; index < ringCount; index += 1) {
        const vertex = slicePoint(level, index);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
    }

    const indices: number[] = [];
    const vertexAt = (level: number, index: number): number =>
      level * ringCount + (index % ringCount);

    // Side quads between consecutive slices (two triangles each).
    for (let level = 0; level < segments; level += 1) {
      for (let index = 0; index < ringCount; index += 1) {
        const a = vertexAt(level, index);
        const b = vertexAt(level, index + 1);
        const c = vertexAt(level + 1, index + 1);
        const d = vertexAt(level + 1, index);
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    // Bottom cap (t = 0) and top cap (t = segments) as triangle fans. The
    // footprint is simple (CCW); the bottom fan is reversed so it faces down.
    const bottomBase = 0;
    const topBase = segments * ringCount;
    for (let index = 1; index < ringCount - 1; index += 1) {
      indices.push(bottomBase, bottomBase + index + 1, bottomBase + index);
      indices.push(topBase, topBase + index, topBase + index + 1);
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return { geometry, ringCount, segments };
  }

  /** Rotates 2D footprint points counter-clockwise by `degrees` about their centroid. */
  private rotatePointsAboutCentroid(points: THREE.Vector2[], degrees: number): THREE.Vector2[] {
    if (degrees === 0 || points.length === 0) {
      return points;
    }

    const centroid = new THREE.Vector2();
    for (const point of points) {
      centroid.add(point);
    }
    centroid.divideScalar(points.length);

    const radians = degrees * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return points.map((point) => {
      const dx = point.x - centroid.x;
      const dy = point.y - centroid.y;
      return new THREE.Vector2(
        centroid.x + dx * cos - dy * sin,
        centroid.y + dx * sin + dy * cos,
      );
    });
  }

  /**
   * The shared [cap(group 0), upperWall(group 1), groundWall(group 2)] material
   * array for a category, used directly by backend meshes that need no per-mesh
   * state. Falls back to bare category-coloured materials if the shared
   * materials are not ready yet. The array is ordered to match the material
   * indices assigned by the UV/group helpers in facade-uv.ts.
   */
  private wallCapMaterialArray(category: FacadeCategory): THREE.MeshLambertMaterial[] {
    const cap = this.sharedCapMaterials?.[category];
    const wall = this.sharedWallMaterials?.[category];
    const groundWall = this.sharedGroundWallMaterials?.[category];
    if (cap && wall && groundWall) {
      const array: THREE.MeshLambertMaterial[] = [];
      array[0] = cap;
      array[UPPER_WALL_MATERIAL_INDEX] = wall;
      array[GROUND_WALL_MATERIAL_INDEX] = groundWall;
      return array;
    }
    const fallback: THREE.MeshLambertMaterial[] = [];
    fallback[0] = new THREE.MeshLambertMaterial({ color: BUILDING_COLORS[category] });
    fallback[UPPER_WALL_MATERIAL_INDEX] = new THREE.MeshLambertMaterial({
      color: BUILDING_COLORS[category],
    });
    fallback[GROUND_WALL_MATERIAL_INDEX] = new THREE.MeshLambertMaterial({
      color: BUILDING_COLORS[category],
    });
    return fallback;
  }

  /**
   * Builds a user mesh with a 3-material array
   * [sharedCap, upperWallClone, groundWallClone]. Both wall clones STILL
   * reference the shared day/ground/night textures, so per-mesh
   * selection/conflict/day-night state can be driven without disturbing other
   * buildings.
   *
   * Ground-floor door encoding: the side walls are split by world height into an
   * upper window group (material index {@link UPPER_WALL_MATERIAL_INDEX}, the
   * repeating window map) and a ground group (material index
   * {@link GROUND_WALL_MATERIAL_INDEX}, the door/shopfront map) covering the
   * lowest ~3 m. The repeating window map carries no door, so exactly one door
   * is drawn at street level and never recurs on upper floors.
   */
  private buildUserMesh(obj: UserObject): THREE.Mesh {
    const category: FacadeCategory = obj.source === 'uploaded' ? 'uploaded' : 'drawn';
    const cap = this.sharedCapMaterials?.[category];
    const sharedWall = this.sharedWallMaterials?.[category];
    const sharedGroundWall = this.sharedGroundWallMaterials?.[category];

    let material: THREE.MeshLambertMaterial[];
    if (cap && sharedWall && sharedGroundWall) {
      material = [];
      // The cap is cloned too (not the shared one) so the selection/conflict
      // tint can colour the roof of this one building without affecting others.
      material[0] = cap.clone();
      material[UPPER_WALL_MATERIAL_INDEX] = sharedWall.clone();
      material[GROUND_WALL_MATERIAL_INDEX] = sharedGroundWall.clone();
    } else {
      material = this.wallCapMaterialArray(category);
    }

    const mesh = new THREE.Mesh(this.buildUserGeometry(obj), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  private disposeUserMesh(mesh: THREE.Mesh): void {
    this.world?.remove(mesh);
    mesh.geometry.dispose();
    // Dispose the per-mesh material clones (cap at 0, walls at 1 and 2). The
    // shared textures referenced by the clones are never disposed here. A
    // non-array material means the shared trio was unavailable at build time
    // (fallback), so it is safe to dispose outright.
    if (Array.isArray(mesh.material)) {
      mesh.material[0]?.dispose();
      mesh.material[UPPER_WALL_MATERIAL_INDEX]?.dispose();
      mesh.material[GROUND_WALL_MATERIAL_INDEX]?.dispose();
    } else {
      mesh.material.dispose();
    }
  }

  /**
   * Applies the selection/conflict emissive OVERRIDE to a user mesh, or clears
   * it and hands the mesh back to the global day/night glow when neither applies.
   * An active override wins over the night window glow for that one mesh: the
   * emissive map is cleared so only the solid blue/red tint shows.
   */
  private applyUserMeshEmissive(id: string, mesh: THREE.Mesh): void {
    const material = mesh.material;
    if (!Array.isArray(material)) {
      return;
    }
    const cap = material[0] instanceof THREE.MeshLambertMaterial ? material[0] : null;
    const upper =
      material[UPPER_WALL_MATERIAL_INDEX] instanceof THREE.MeshLambertMaterial
        ? material[UPPER_WALL_MATERIAL_INDEX]
        : null;
    const ground =
      material[GROUND_WALL_MATERIAL_INDEX] instanceof THREE.MeshLambertMaterial
        ? material[GROUND_WALL_MATERIAL_INDEX]
        : null;

    const override = this.conflictUserObjectIds.has(id)
      ? { hex: CONFLICT_EMISSIVE_HEX, intensity: CONFLICT_EMISSIVE_INTENSITY }
      : this.selectedUserObjectId === id
        ? { hex: SELECTION_EMISSIVE_HEX, intensity: SELECTION_EMISSIVE_INTENSITY }
        : null;

    if (override) {
      // Tint the whole building — roof (cap) and both wall bands — so an
      // overlapping or selected object is unmistakable from every angle.
      for (const part of [cap, upper, ground]) {
        if (part) {
          part.emissiveMap = null;
          part.emissive.setHex(override.hex);
          part.emissiveIntensity = override.intensity;
          part.needsUpdate = true;
        }
      }
      return;
    }

    // No override: the roof stays plain; walls follow the day/night glow
    // (only the upper band carries window glow — the ground band never does).
    if (cap) {
      cap.emissive.setHex(0x000000);
      cap.emissiveMap = null;
      cap.needsUpdate = true;
    }
    if (upper) {
      this.applyWallDayNight(upper, this.isNight, false);
    }
    if (ground) {
      this.applyWallDayNight(ground, this.isNight, true);
    }
  }

  /** True when the given user mesh currently carries a selection/conflict override. */
  private hasEmissiveOverride(id: string): boolean {
    return this.conflictUserObjectIds.has(id) || this.selectedUserObjectId === id;
  }

  private refreshUserMeshEmissive(): void {
    for (const [id, mesh] of this.userMeshes) {
      this.applyUserMeshEmissive(id, mesh);
    }
  }

  /**
   * Sets a single wall material's day/night glow. Night lights the warm window
   * emissive map; day clears it. When facades are disabled the emissive map is
   * always null so the mesh stays a flat matte box.
   */
  private applyWallDayNight(
    wall: THREE.MeshLambertMaterial,
    night: boolean,
    isGround = false,
  ): void {
    // The ground floor has only a door (no windows), so it never glows at night.
    if (night && !isGround && this.facadesEnabled && this.facadeTextures) {
      wall.emissive.setHex(NIGHT_EMISSIVE_HEX);
      wall.emissiveMap = this.facadeTextures.nightEmissive;
      wall.emissiveIntensity = 1;
    } else {
      wall.emissive.setHex(0x000000);
      wall.emissiveMap = null;
      wall.emissiveIntensity = 1;
    }
    wall.needsUpdate = true;
  }

  /**
   * Drives day vs night window glow across every shared wall material and every
   * user mesh's own wall clone. User meshes currently under a selection/conflict
   * override keep that override (they are not forced by day/night).
   */
  private applyDayNight(night: boolean): void {
    this.isNight = night;
    for (const wall of Object.values(this.sharedWallMaterials ?? {})) {
      this.applyWallDayNight(wall, night, false);
    }
    // Ground materials never glow (door only, no windows).
    for (const wall of Object.values(this.sharedGroundWallMaterials ?? {})) {
      this.applyWallDayNight(wall, night, true);
    }
    for (const [id, mesh] of this.userMeshes) {
      if (this.hasEmissiveOverride(id)) {
        continue;
      }
      const material = mesh.material;
      if (!Array.isArray(material)) {
        continue;
      }
      const upper = material[UPPER_WALL_MATERIAL_INDEX];
      const ground = material[GROUND_WALL_MATERIAL_INDEX];
      if (upper instanceof THREE.MeshLambertMaterial) {
        this.applyWallDayNight(upper, night, false);
      }
      if (ground instanceof THREE.MeshLambertMaterial) {
        this.applyWallDayNight(ground, night, true);
      }
    }
    this.map?.triggerRepaint();
  }

  /** Adds or replaces a user object's mesh and refits shadows/ground. */
  addUserObject(obj: UserObject): void {
    if (!this.world) {
      return;
    }
    const existing = this.userMeshes.get(obj.id);
    if (existing) {
      this.disposeUserMesh(existing);
    }
    const mesh = this.buildUserMesh(obj);
    this.userMeshes.set(obj.id, mesh);
    this.world.add(mesh);
    this.applyUserMeshEmissive(obj.id, mesh);
    this.refreshAfterGeometryChange();
  }

  /** Rebuilds only this object's mesh in place; never touches other meshes. */
  updateUserObject(obj: UserObject): void {
    if (!this.world || !this.userMeshes.has(obj.id)) {
      return;
    }
    const existing = this.userMeshes.get(obj.id);
    if (existing) {
      this.disposeUserMesh(existing);
    }
    const mesh = this.buildUserMesh(obj);
    this.userMeshes.set(obj.id, mesh);
    this.world.add(mesh);
    this.applyUserMeshEmissive(obj.id, mesh);
    this.refreshAfterGeometryChange();
  }

  removeUserObject(id: string): void {
    const mesh = this.userMeshes.get(id);
    if (!mesh) {
      return;
    }
    this.disposeUserMesh(mesh);
    this.userMeshes.delete(id);
    this.conflictUserObjectIds.delete(id);
    if (this.selectedUserObjectId === id) {
      this.selectedUserObjectId = null;
    }
    this.refreshAfterGeometryChange();
  }

  /** Highlights the selected user mesh and clears the tint on all others. */
  setSelectedUserObject(id: string | null): void {
    this.selectedUserObjectId = id;
    this.refreshUserMeshEmissive();
    this.map?.triggerRepaint();
  }

  /**
   * Sets which user meshes carry the red conflict tint. The supplied list is the
   * complete set of conflicting ids: any id not in it loses the tint and falls
   * back to its selection/original colour. Pass an empty list to clear all.
   */
  setConflictHighlight(ids: readonly string[]): void {
    this.conflictUserObjectIds.clear();
    for (const id of ids) {
      this.conflictUserObjectIds.add(id);
    }
    this.refreshUserMeshEmissive();
    this.map?.triggerRepaint();
  }

  /**
   * Turns procedural facades on or off for every building without rebuilding any
   * geometry. When ON the shared day map (and, at night, the emissive window
   * map) is applied; when OFF every wall reverts to the flat matte category
   * colour the app had before facades (map null, emissive black). O(materials).
   */
  setFacadesEnabled(enabled: boolean): void {
    if (this.facadesEnabled === enabled) {
      return;
    }
    this.facadesEnabled = enabled;
    const dayMap = enabled ? this.facadeTextures?.day ?? null : null;
    const groundMap = enabled ? this.facadeTextures?.groundDay ?? null : null;

    for (const wall of Object.values(this.sharedWallMaterials ?? {})) {
      wall.map = dayMap;
      wall.needsUpdate = true;
    }
    for (const wall of Object.values(this.sharedGroundWallMaterials ?? {})) {
      wall.map = groundMap;
      wall.needsUpdate = true;
    }
    for (const mesh of this.userMeshes.values()) {
      const material = mesh.material;
      if (!Array.isArray(material)) {
        continue;
      }
      const upper = material[UPPER_WALL_MATERIAL_INDEX];
      const ground = material[GROUND_WALL_MATERIAL_INDEX];
      if (upper instanceof THREE.MeshLambertMaterial) {
        upper.map = dayMap;
        upper.needsUpdate = true;
      }
      if (ground instanceof THREE.MeshLambertMaterial) {
        ground.map = groundMap;
        ground.needsUpdate = true;
      }
    }

    // Re-apply night glow (respects the new facadesEnabled flag) and then the
    // per-mesh selection/conflict overrides so highlights stay correct.
    this.applyDayNight(this.isNight);
    this.refreshUserMeshEmissive();
    this.map?.triggerRepaint();
  }

  /**
   * Picks the front-most user mesh under a screen point (canvas pixels), or null.
   * Builds the same local->mercator basis used in render() so the raycaster
   * matches what is on screen.
   */
  pickUserObject(point: { x: number; y: number }): string | null {
    if (!this.camera || !this.map || this.userMeshes.size === 0) {
      return null;
    }

    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const ndc = new THREE.Vector2(
      (point.x / width) * 2 - 1,
      -(point.y / height) * 2 + 1,
    );

    // camera.projectionMatrix already maps local metres -> clip space (see render()).
    const inverse = this.camera.projectionMatrix.clone().invert();
    const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inverse);
    const far = new THREE.Vector3(ndc.x, ndc.y, 1).applyMatrix4(inverse);
    const origin = near;
    const direction = far.sub(near).normalize();

    const raycaster = new THREE.Raycaster(origin, direction);
    const intersections = raycaster.intersectObjects([...this.userMeshes.values()], false);
    if (intersections.length === 0) {
      return null;
    }

    const hit = intersections[0].object;
    for (const [id, mesh] of this.userMeshes) {
      if (mesh === hit) {
        return id;
      }
    }
    return null;
  }

  /**
   * Picks the front-most backend building under a screen point (canvas pixels)
   * and returns its height/address info, or null when none is hit. Uses the same
   * local->clip basis as pickUserObject.
   *
   * Tiles are merged meshes, so picking walks the per-building tables instead
   * of raycasting thousands of meshes: a ray/box test per tile, then per
   * building, and a triangle test only for buildings whose box the ray hits.
   */
  pickBackendBuilding(point: { x: number; y: number }): BackendBuildingInfo | null {
    if (!this.camera || !this.map || this.backendTiles.size === 0) {
      return null;
    }

    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const ndc = new THREE.Vector2(
      (point.x / width) * 2 - 1,
      -(point.y / height) * 2 + 1,
    );
    const inverse = this.camera.projectionMatrix.clone().invert();
    const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inverse);
    const far = new THREE.Vector3(ndc.x, ndc.y, 1).applyMatrix4(inverse);
    const ray = new THREE.Ray(near, far.clone().sub(near).normalize());

    const box = new THREE.Box3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const hit = new THREE.Vector3();
    let bestDistance = Infinity;
    let bestInfo: BackendBuildingInfo | null = null;

    for (const tile of this.backendTiles.values()) {
      if (!tile.mesh || !ray.intersectsBox(tile.box)) {
        continue;
      }
      const positions = tile.mesh.geometry.getAttribute('position').array as Float32Array;
      const buildingCount = tile.infos.length;
      for (let building = 0; building < buildingCount; building += 1) {
        const o = building * 6;
        box.min.set(tile.buildingBoxes[o], tile.buildingBoxes[o + 1], tile.buildingBoxes[o + 2]);
        box.max.set(tile.buildingBoxes[o + 3], tile.buildingBoxes[o + 4], tile.buildingBoxes[o + 5]);
        if (!ray.intersectsBox(box)) {
          continue;
        }
        for (let section = 0; section < 3; section += 1) {
          const start = tile.buildingRanges[o + section * 2];
          const count = tile.buildingRanges[o + section * 2 + 1];
          for (let v = start; v + 2 < start + count; v += 3) {
            a.fromArray(positions, v * 3);
            b.fromArray(positions, v * 3 + 3);
            c.fromArray(positions, v * 3 + 6);
            // Back faces are skipped, matching the FrontSide building materials.
            if (ray.intersectTriangle(a, b, c, true, hit)) {
              const distance = hit.distanceToSquared(ray.origin);
              if (distance < bestDistance) {
                bestDistance = distance;
                bestInfo = tile.infos[building];
              }
            }
          }
        }
      }
    }
    return bestInfo;
  }

  /**
   * Schedules a refit of the building box, ground plane and shadow camera. The
   * refit itself runs once in the next frame ({@link applyGeometryChange}), so
   * adding or removing many tiles in a row costs one refit, not one per tile.
   */
  private refreshAfterGeometryChange(): void {
    this.geometryDirty = true;
    this.map?.triggerRepaint();
  }

  /** Refits the building box, ground plane and shadow camera after geometry changes. */
  private applyGeometryChange(): void {
    this.geometryDirty = false;
    const previousSize = this.buildingBox.isEmpty()
      ? 0
      : Math.max(
        this.buildingBox.max.x - this.buildingBox.min.x,
        this.buildingBox.max.z - this.buildingBox.min.z,
      );

    this.updateBuildingBox();

    if (this.ground && !this.buildingBox.isEmpty()) {
      const center = this.buildingBox.getCenter(new THREE.Vector3());
      const requiredSize = Math.max(
        this.buildingBox.max.x - this.buildingBox.min.x,
        this.buildingBox.max.z - this.buildingBox.min.z,
      ) + GROUND_MARGIN;
      const currentSize = this.ground.geometry.parameters.width;
      if (requiredSize > currentSize + REFIT_EPSILON) {
        this.ground.geometry.dispose();
        this.ground.geometry = new THREE.PlaneGeometry(requiredSize, requiredSize);
      } else if (previousSize === 0 && currentSize < requiredSize) {
        this.ground.geometry.dispose();
        this.ground.geometry = new THREE.PlaneGeometry(requiredSize, requiredSize);
      }
      this.ground.position.set(center.x, 0.02, center.z);
    }

    this.appliedShadowKey = '';
    if (this.renderer) {
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  /**
   * Builds the backend buildings from the collection the constructor was given,
   * as the one-shot fallback path. They are stored under the synthetic
   * {@link FALLBACK_TILE_KEY} so the tile controller's eviction never touches
   * them. An empty collection (the streaming start) adds nothing.
   */
  private addGeoJSONBuildings(): void {
    this.removeBackendTile(FALLBACK_TILE_KEY);
    if (!this.world || this.geojson.features.length === 0) {
      return;
    }
    this.addBackendTile(FALLBACK_TILE_KEY, this.geojson);
  }

  /**
   * Adds (or replaces) the backend buildings for one tile from GeoJSON, building
   * the merged geometry on the main thread. The streaming path uses
   * {@link addBackendTileData} with geometry built in the tile Web Worker.
   */
  addBackendTile(geohash: string, geojson: FeatureCollection): void {
    this.addBackendTileData(
      geohash,
      buildTileGeometry(geojson.features, geohash, {
        center: this.center,
        facade: this.facadeTextures
          ? {
            metresPerRepeatU: this.facadeTextures.metresPerRepeatU,
            metresPerRepeatV: this.facadeTextures.metresPerRepeatV,
            groundFloorMetres: this.facadeTextures.groundFloorMetres,
          }
          : null,
      }),
    );
  }

  /**
   * Adds (or replaces) one tile from pre-built merged geometry. Re-adding a
   * geohash disposes the previous geometry first (replace semantics). The
   * box/ground/shadow refit is deferred to the next frame.
   */
  addBackendTileData(geohash: string, data: TileGeometryData): void {
    if (!this.world) {
      return;
    }
    const existing = this.backendTiles.get(geohash);
    if (existing) {
      this.disposeTileEntry(existing);
      this.backendTiles.delete(geohash);
    }

    const tile = this.createTileEntry(data);
    if (tile.mesh) {
      this.world.add(tile.mesh);
    }
    this.backendTiles.set(geohash, tile);
    this.refreshAfterGeometryChange();
  }

  /** True when a backend tile for `geohash` is currently on the map. */
  hasBackendTile(geohash: string): boolean {
    return this.backendTiles.has(geohash);
  }

  /**
   * Removes one geohash tile, disposing ONLY its geometry. The shared facade
   * textures and per-category materials are owned by the layer and disposed
   * once in {@link onRemove}.
   *
   * @param geohash the tile key to remove (no-op when absent)
   */
  removeBackendTile(geohash: string): void {
    const tile = this.backendTiles.get(geohash);
    if (!tile) {
      return;
    }
    this.disposeTileEntry(tile);
    this.backendTiles.delete(geohash);
    this.refreshAfterGeometryChange();
  }

  /** Removes every backend tile (geometry-only disposal), then refits. */
  clearBackendTiles(): void {
    this.clearBuildingMeshes();
    this.refreshAfterGeometryChange();
  }

  /** Disposes all backend geometry without refitting; used on layer teardown. */
  private clearBuildingMeshes(): void {
    for (const tile of this.backendTiles.values()) {
      this.disposeTileEntry(tile);
    }
    this.backendTiles.clear();
  }

  private clearUserMeshes(): void {
    for (const mesh of this.userMeshes.values()) {
      this.disposeUserMesh(mesh);
    }
    this.userMeshes.clear();
    this.conflictUserObjectIds.clear();
    this.selectedUserObjectId = null;
  }
}
