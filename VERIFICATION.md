# Building facades — verification & design notes

This document describes the procedural building-facade feature (windows, a
ground-floor door, and warm night-lit windows) that is applied to **all**
building categories, together with the Ukrainian left-panel toggle
**«Фасади (вікна)»** that switches it on and off. It also records the two
commands used to verify the change.

## (a) Facade texture scheme

Two shared `THREE.CanvasTexture` objects are created once per layer in
`ThreeBuildingsLayer.onAdd` by `createFacadeTextures(maxAnisotropy)`
(`src/facade-texture.ts`) and disposed once in `onRemove`:

- **Day albedo (`day`)** — a repeating facade drawn on a neutral base so the
  per-category wall colour still shows through. Each vertical repeat holds two
  stacked bands: a **ground-floor treatment** (a centred door plus two shopfront
  panes) in the lower half and an **upper-floor window band** (a row of window
  rectangles with a subtle glass highlight) in the upper half.
- **Night emissive (`nightEmissive`)** — black everywhere except a deterministic
  subset of window rectangles filled warm (~`#ffd27a`). The lit subset is chosen
  by a seeded `mulberry32` PRNG (seed `0x9e3779b1`), so the pattern is stable
  across reloads.

Both textures: `colorSpace = SRGBColorSpace`, `wrapS = wrapT = RepeatWrapping`,
`generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`,
`anisotropy = maxAnisotropy`, `needsUpdate = true`. Canvas size is 256×512 with V
drawn bottom→top.

**Metres-per-repeat.** `metresPerRepeatU = 3` (window-column pitch);
`metresPerRepeatV = 6`. One V repeat spans two ~3 m storeys: the ground-floor
band in V ∈ [0, 0.5) and one upper-floor band in V ∈ [0.5, 1).

**Ground-floor door encoding.** The door/shopfront lives in the lower half of
each repeat. Wall V is computed as `worldY / metresPerRepeatV` with **no**
per-mesh offset (`map.offset.y = emissiveMap.offset.y = 0`). For a building whose
base rests at `worldY = minHeight` (0 for ground-resting objects), V = 0 lands in
the door band, so the door sits at street level. The door therefore recurs every
two floors; this is intentional and documented rather than a per-mesh shift.

## (b) Material system

Per-category **shared material pairs** are built in
`createSharedFacadeMaterials()` (called in `onAdd` *before* buildings are added),
keyed `backend` / `drawn` / `uploaded`:

- `capMaterial = MeshLambertMaterial({ color: BUILDING_COLORS[cat] })` — plain
  category colour, no window map (roofs/caps stay flat).
- `wallMaterial = MeshLambertMaterial({ color: BUILDING_COLORS[cat], map: day })`.

Diffuse-only (no specular). Meshes use a **2-material array ordered
`[cap (group 0), wall (group 1)]`**, matching the verified `ExtrudeGeometry`
group order (caps first, side walls second).

- **Backend meshes** reference the shared `[cap, wall]` array directly.
- **User meshes** (drawn / uploaded) use `[sharedCap, wallClone]` where
  `wallClone = sharedWall.clone()`. The clone still references the **shared
  textures**, so per-mesh day/night and selection/conflict state can be driven
  without disturbing other buildings.

**UV helpers** (`src/facade-uv.ts`) map side walls so windows tile uniformly in
real metres: U follows the cumulative horizontal wall-edge distance (x/z plane),
V = `worldY / metresPerRepeatV`; cap vertices get UV (0, 0). The straight
extrude path uses `assignExtrudeFacadeUVs`; the twisted/segmented path uses
`assignSegmentedFacadeUVs`.

**Disposal.** `facadeTextures.dispose()` and the 6 shared materials are disposed
once in `onRemove`. `disposeUserMesh` disposes only the per-mesh wall clone
(array index 1) and geometry — never the shared cap material or the shared
textures. `clearBuildingMeshes` disposes only geometry.

## (c) Day/night emissive switching and precedence

`applyDayNight(night)` is called from **both** branches of `updateSun`
(`night = !sunAboveHorizon`):

- **Night** → wall `emissive = 0xffffff`, `emissiveMap = nightEmissive`,
  `emissiveIntensity = 1` → warm lit windows.
- **Day** → `emissive = 0x000000`, `emissiveMap = null`.

Selection/conflict highlights OVERRIDE night glow on a per-mesh basis.
`applyUserMeshEmissive` operates on the wall array element (index 1):

- **Conflict** — `0xff3b30` @ intensity 0.6, `emissiveMap = null`.
- **Selection** — `0x2f6bff` @ intensity 0.45, `emissiveMap = null`.

So only the solid red/blue shows while an override is active, and
`applyDayNight` skips meshes with an active override (other meshes keep their
night glow). The precedence is therefore **conflict > selection > night glow**.

Everything respects the `facadesEnabled` flag: when facades are OFF,
`applyDayNight` leaves `emissiveMap = null`.

## (d) Per-building UV-offset decorrelation of lit windows

`facadeUvOffset(seed)` (`src/facade-uv.ts`) hashes a stable per-building seed
(FNV-1a 32-bit) into a fractional U offset in [0, 1). Backend buildings seed with
`backend-${featureIndex}-${polygonIndex}`; user objects seed with `obj.id`. The
offset shifts each building's window grid horizontally, so the deterministic
lit-window subset does not line up between neighbouring buildings — adjacent
towers show different lit-window patterns instead of an identical repeated one.

## The toggle

- `index.html` — `input#facade-toggle` inside the `#panel` aside, reusing the
  `.switch` markup from the «Реальний час» toggle, **checked by default**
  (facades ON). Title «Фасади (вікна)», hint «Вікна та підсвічені вечірні вікна».
- `src/main.ts` — `threeLayer.setFacadesEnabled(facadeToggle.checked)` is called
  right after the layer is added on `map.on('load')`, and a `change` listener
  (null-guarded) re-applies the value on toggle.
- `ThreeBuildingsLayer.setFacadesEnabled(enabled)` is O(materials) with **no
  geometry rebuild**: it sets `wall.map = enabled ? day : null` on the 3 shared
  wall materials plus every user wall clone, then re-runs
  `applyDayNight(current night)` and `refreshUserMeshEmissive`. OFF restores the
  exact previous look: flat category-coloured matte boxes (map null, emissive
  black).

### Performance

Facades add no per-frame cost and no per-mesh textures: exactly two shared
`CanvasTexture`s and six shared materials are created once. The toggle is a
material-map swap, not a geometry rebuild, so switching is effectively free.

## (e) Verification commands

Run both from `front/` (npm/npx are not on PATH — use the local binaries via
`node`). **Both must exit 0**; the pre-existing chunk-size >500 kB advisory is
expected and is not an error.

```
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```
