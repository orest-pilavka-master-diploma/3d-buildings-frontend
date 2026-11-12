import * as THREE from 'three';

/**
 * The procedural facade textures shared by every building mesh.
 *
 * The maps are authored once on offscreen canvases and tile in real metres via
 * the `metresPerRepeat*` pitches: UV coordinates are built so that one texture
 * repeat spans `metresPerRepeatU` of wall width and `metresPerRepeatV` of wall
 * height (see facade-uv.ts). To keep exactly one entrance door at street level
 * without per-building authoring the walls are split, by world height, into two
 * material groups that sample two different day maps:
 *
 * - `day` — the repeating upper-floor window grid. It is a TRANSPARENT overlay
 *   over the material's flat category colour and holds NO door, so the repeat
 *   is a pure window band (one ~3 m floor tall). Every floor above the ground
 *   samples this map, so windows stay uniform all the way up.
 * - `groundDay` — the ground-floor band (lowest ~3 m). Also a transparent
 *   overlay, it carries two shopfront panes flanking a single centred door, so
 *   exactly one door is drawn at the bottom of each building and nowhere else.
 *
 * `nightEmissive` lights a deterministic (seeded) ~half of the window cells warm
 * for both the upper band and the ground band; it is laid out to match both day
 * maps so the lit windows register with the painted glass.
 */
export interface FacadeTextures {
  /** Day albedo overlay for the repeating upper-floor band: windows only, no door. */
  readonly day: THREE.CanvasTexture;
  /** Day albedo overlay for the ground-floor band: shopfront panes + one centred door. */
  readonly groundDay: THREE.CanvasTexture;
  /** Night emissive map: black except a seeded warm subset of windows (both bands). */
  readonly nightEmissive: THREE.CanvasTexture;
  /** Wall width, in metres, spanned by one horizontal texture repeat. */
  readonly metresPerRepeatU: number;
  /** Wall height, in metres, spanned by one vertical texture repeat (one floor). */
  readonly metresPerRepeatV: number;
  /** Height, in metres, of the ground-floor band that samples {@link groundDay}. */
  readonly groundFloorMetres: number;
  /** Disposes all GPU textures. Call exactly once when the layer is torn down. */
  dispose(): void;
}

/** Texture canvas width in pixels (one horizontal window-column-group pitch across). */
const TEXTURE_WIDTH = 256;
/** Texture canvas height in pixels (one ~3 m floor band). */
const TEXTURE_HEIGHT = 512;
/** Horizontal wall span, in metres, of one texture repeat (window-column-group pitch). */
const METRES_PER_REPEAT_U = 3;
/**
 * Vertical wall span, in metres, of one texture repeat. One repeat is exactly
 * one ~3 m floor band (upper-floor window grid), so the repeating `day` map
 * holds no door and windows stay uniform on every floor.
 */
const METRES_PER_REPEAT_V = 3;
/**
 * Height, in metres, of the ground-floor band rendered with {@link FacadeTextures.groundDay}.
 * One floor tall, so the door + shopfront fill exactly the lowest storey and the
 * window grid tiles above it. The wall-group split in facade-uv.ts uses this.
 */
const GROUND_FLOOR_METRES = 3;
/**
 * Horizontal repeat scale for the ground (door) map relative to the upper window
 * pitch. 0.25 means one door tile spans 4 window modules (≈12 m), so doors are
 * sparse along the street instead of one per window column.
 */
const GROUND_REPEAT_U_SCALE = 0.25;
/**
 * The night emissive map is a GRID of this many window modules (columns ×
 * rows). Each module holds one window lit independently at 50% probability, so
 * a single wall shows a believable random scatter of lit/dark windows rather
 * than every window sharing one state. The night texture's UV repeat is set to
 * (1/cols, 1/rows) so each 3 m wall module samples exactly one grid cell, and
 * the grid only repeats after this many modules — large enough to read as
 * random. Keep it reasonably sized (a power-of-two-ish count) for a small map.
 */
const NIGHT_GRID_COLUMNS = 8;
const NIGHT_GRID_ROWS = 8;
/** Probability each window in the night grid is lit. */
const NIGHT_LIT_PROBABILITY = 0.5;

/**
 * The facade UV pitches as plain numbers, for code that builds geometry without
 * the textures (the tile Web Worker). Same values as {@link FacadeTextures}.
 */
export const FACADE_METRICS = {
  metresPerRepeatU: METRES_PER_REPEAT_U,
  metresPerRepeatV: METRES_PER_REPEAT_V,
  groundFloorMetres: GROUND_FLOOR_METRES,
} as const;

/**
 * Small deterministic PRNG (mulberry32) so the lit-window pattern is identical
 * on every run without pulling in a dependency.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Creates an offscreen canvas and its 2D context, throwing if unavailable. */
function createCanvasContext(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not acquire a 2D context for the facade texture canvas');
  }
  return { canvas, context };
}

/**
 * A rectangle in canvas pixel space (y-down). Window/door/shopfront cells are
 * expressed as cells so day and night draws share the exact same geometry.
 */
interface WindowCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Window cells for the repeating upper-floor band (canvas pixel space, y-down).
 *
 * Three columns and a single row fill the whole band, with generous margins and
 * a modest window height so clear wall colour dominates each floor. Three
 * columns (up from two) raise pattern variety so the night repeat is less
 * obvious; combined with the per-building U offset neighbours differ.
 */
function upperFloorWindows(): WindowCell[] {
  // A single window per horizontal repeat (one window column). Generous side
  // margins keep clear wall colour on both sides so the grid reads as one
  // window per module, not a cluster.
  const windowWidth = TEXTURE_WIDTH * 0.46;
  const windowHeight = TEXTURE_HEIGHT * 0.42;
  return [
    {
      x: (TEXTURE_WIDTH - windowWidth) / 2,
      y: (TEXTURE_HEIGHT - windowHeight) / 2,
      width: windowWidth,
      height: windowHeight,
    },
  ];
}

/**
 * Centred door rectangle for the ground-floor band (canvas pixel space, y-down).
 * The door is slim and the ground map is sampled at a wider horizontal pitch
 * (see GROUND_REPEAT_U_SCALE) so doors are sparse along the street, not one per
 * window module.
 */
function groundFloorDoor(): WindowCell {
  const doorWidth = TEXTURE_WIDTH * 0.14;
  const doorHeight = TEXTURE_HEIGHT * 0.78;
  return {
    x: (TEXTURE_WIDTH - doorWidth) / 2,
    y: TEXTURE_HEIGHT - doorHeight,
    width: doorWidth,
    height: doorHeight,
  };
}

/**
 * Fills a window pane with a PALE glass tint and a thin, subtle frame.
 *
 * Because `material.map` multiplies `material.color`, the pane pixels must stay
 * light so the multiply keeps the window near the wall's brightness instead of
 * driving it toward black. The gradient is a soft pale blue-grey and the frame
 * is a thin low-contrast stroke.
 */
function paintGlassPane(context: CanvasRenderingContext2D, cell: WindowCell): void {
  // OPAQUE glass. material.map MULTIPLIES material.color, so every pixel must be
  // light (near-white) or it drags the wall toward black. A window is a slightly
  // cooler/darker light-grey than the white wall field, so it reads as a window
  // while the multiply keeps the whole wall bright.
  const gradient = context.createLinearGradient(cell.x, cell.y, cell.x, cell.y + cell.height);
  gradient.addColorStop(0, 'rgb(188, 202, 214)');
  gradient.addColorStop(0.5, 'rgb(170, 186, 200)');
  gradient.addColorStop(1, 'rgb(150, 168, 184)');
  context.fillStyle = gradient;
  context.fillRect(cell.x, cell.y, cell.width, cell.height);

  // A faint diagonal glare band across the glass.
  context.save();
  context.globalAlpha = 0.25;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(cell.x, cell.y + cell.height * 0.2);
  context.lineTo(cell.x + cell.width * 0.5, cell.y);
  context.lineTo(cell.x + cell.width, cell.y + cell.height * 0.12);
  context.lineTo(cell.x + cell.width, cell.y + cell.height * 0.32);
  context.lineTo(cell.x, cell.y + cell.height * 0.42);
  context.closePath();
  context.fill();
  context.restore();

  // Thin, mid-grey frame so panes read as separate windows (still light enough
  // not to darken the wall noticeably).
  context.strokeStyle = 'rgb(120, 132, 144)';
  context.lineWidth = Math.max(1, TEXTURE_WIDTH * 0.008);
  context.strokeRect(cell.x, cell.y, cell.width, cell.height);
}

/**
 * Draws the repeating upper-floor day map: a light window row on a WHITE wall
 * field. White (not transparent) is essential: the texture is a `map` that
 * multiplies the material's category colour, so a white field shows the wall
 * colour at full brightness while the windows read as light-grey panes.
 */
function drawDayTexture(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  for (const cell of upperFloorWindows()) {
    paintGlassPane(context, cell);
  }
}

/**
 * Draws the ground-floor day overlay: two light shopfront panes flanking one
 * centred door, filling the whole 3 m band on clear ground.
 *
 * The door is a readable mid-tone leaf (not near-black) with a slim frame and a
 * light handle dot, so street level reads as an entrance without darkening the
 * wall the way an opaque black fill would.
 */
function drawGroundDayTexture(context: CanvasRenderingContext2D): void {
  // White wall field (opaque) so the ground floor shows the category colour at
  // full brightness, same as the upper band — see drawDayTexture.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  // Ground floor: a single door only (no shopfront windows).
  const door = groundFloorDoor();
  context.fillStyle = 'rgb(150, 122, 96)';
  context.fillRect(door.x, door.y, door.width, door.height);
  context.strokeStyle = 'rgb(96, 76, 56)';
  context.lineWidth = Math.max(1, TEXTURE_WIDTH * 0.008);
  context.strokeRect(door.x, door.y, door.width, door.height);
  // Vertical seam between the two door leaves.
  context.beginPath();
  context.moveTo(door.x + door.width / 2, door.y);
  context.lineTo(door.x + door.width / 2, door.y + door.height);
  context.stroke();
  // Light handle dots either side of the seam.
  context.fillStyle = 'rgba(224, 212, 190, 0.9)';
  const handleRadius = Math.max(1.5, TEXTURE_WIDTH * 0.012);
  for (const sign of [-1, 1]) {
    context.beginPath();
    context.arc(
      door.x + door.width / 2 + sign * door.width * 0.18,
      door.y + door.height * 0.52,
      handleRadius,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

/**
 * Draws the night emissive map as a GRID of window modules.
 *
 * The map is sampled as the material's emissiveMap through the SAME per-wall UVs
 * as the day map, so it must tile at one 3 m module per cell. It is drawn as a
 * NIGHT_GRID_COLUMNS × NIGHT_GRID_ROWS block of modules, each holding the single
 * upper-floor window at the same relative position as the day map, and each lit
 * independently at NIGHT_LIT_PROBABILITY. The texture's UV repeat is set to
 * (1/cols, 1/rows) by the caller so each wall module samples exactly one cell;
 * because consecutive wall modules sample consecutive cells, a single wall shows
 * a random scatter of lit/dark windows that only repeats after the grid size.
 *
 * Black regions contribute no glow (emissiveMap), so the diffuse day albedo keeps
 * unlit windows and the wall faintly visible — a building is never a black blob.
 */
function drawNightTexture(context: CanvasRenderingContext2D): void {
  const gridWidth = TEXTURE_WIDTH * NIGHT_GRID_COLUMNS;
  const gridHeight = TEXTURE_HEIGHT * NIGHT_GRID_ROWS;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, gridWidth, gridHeight);

  const random = mulberry32(0x9e3779b1);
  const litColor = '#ffd27a';
  // The window footprint within one module (one window per module).
  const [window] = upperFloorWindows();

  for (let row = 0; row < NIGHT_GRID_ROWS; row += 1) {
    for (let column = 0; column < NIGHT_GRID_COLUMNS; column += 1) {
      if (random() >= NIGHT_LIT_PROBABILITY) {
        continue;
      }
      const originX = column * TEXTURE_WIDTH;
      const originY = row * TEXTURE_HEIGHT;
      context.save();
      context.fillStyle = litColor;
      context.shadowColor = litColor;
      context.shadowBlur = Math.max(2, TEXTURE_WIDTH * 0.03);
      context.fillRect(originX + window.x, originY + window.y, window.width, window.height);
      context.restore();
    }
  }
}

/** Applies the shared sampling/filter settings every facade texture needs. */
function configureTexture(texture: THREE.CanvasTexture, maxAnisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
}

/**
 * Builds the shared facade CanvasTextures (`day`, `groundDay`, `nightEmissive`).
 * Call once per layer (in onAdd), passing the renderer's max anisotropy so the
 * steeply-viewed walls stay crisp.
 */
export function createFacadeTextures(maxAnisotropy: number): FacadeTextures {
  const dayCanvas = createCanvasContext(TEXTURE_WIDTH, TEXTURE_HEIGHT);
  drawDayTexture(dayCanvas.context);
  const day = new THREE.CanvasTexture(dayCanvas.canvas);
  configureTexture(day, maxAnisotropy);

  const groundCanvas = createCanvasContext(TEXTURE_WIDTH, TEXTURE_HEIGHT);
  drawGroundDayTexture(groundCanvas.context);
  const groundDay = new THREE.CanvasTexture(groundCanvas.canvas);
  configureTexture(groundDay, maxAnisotropy);
  // Stretch the ground tile across several window modules so doors are sparse.
  groundDay.repeat.x = GROUND_REPEAT_U_SCALE;

  const nightCanvas = createCanvasContext(
    TEXTURE_WIDTH * NIGHT_GRID_COLUMNS,
    TEXTURE_HEIGHT * NIGHT_GRID_ROWS,
  );
  drawNightTexture(nightCanvas.context);
  const nightEmissive = new THREE.CanvasTexture(nightCanvas.canvas);
  configureTexture(nightEmissive, maxAnisotropy);
  // One wall module (UV span 1.0) samples exactly one grid cell, so the lit/dark
  // pattern varies window-to-window and only repeats after the grid size.
  nightEmissive.repeat.set(1 / NIGHT_GRID_COLUMNS, 1 / NIGHT_GRID_ROWS);

  return {
    day,
    groundDay,
    nightEmissive,
    metresPerRepeatU: METRES_PER_REPEAT_U,
    metresPerRepeatV: METRES_PER_REPEAT_V,
    groundFloorMetres: GROUND_FLOOR_METRES,
    dispose(): void {
      day.dispose();
      groundDay.dispose();
      nightEmissive.dispose();
    },
  };
}
