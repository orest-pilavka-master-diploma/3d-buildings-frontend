import * as THREE from 'three';

/**
 * Per-wall UV + material-group helpers for the procedural facades.
 *
 * Both building paths (straight {@link THREE.ExtrudeGeometry} and the twisted
 * segmented {@link THREE.BufferGeometry}) get the same uniform window grid by
 * mapping U to the cumulative horizontal distance travelled around the wall
 * perimeter, in metres, and V to world height in metres — each divided by the
 * matching `metresPerRepeat*` so one texture repeat is one window column wide
 * and one ~3 m floor tall regardless of footprint size. A per-building
 * fractional U offset decorrelates the (deterministic) lit-window pattern
 * between buildings.
 *
 * To keep a single entrance door at street level the side walls are also split,
 * by world height, into an "upper" material group (the repeating window grid)
 * and a "ground" material group (the lowest ~3 m, carrying the door). On the
 * straight path each full-height wall quad is CUT at the ground boundary into a
 * ground sub-quad and an upper sub-quad; on the segmented path the per-slice
 * quads are already short, so they are grouped directly by height.
 */

/** Material index of the roof/floor cap group. */
const CAP_MATERIAL_INDEX = 0;
/** Material index of the repeating upper-floor wall group. */
export const UPPER_WALL_MATERIAL_INDEX = 1;
/** Material index of the ground-floor wall group (door band). */
export const GROUND_WALL_MATERIAL_INDEX = 2;

/**
 * Stable hash of a building key into a fractional U offset in [0, 1). Lets each
 * building start its window grid at a different column phase so the shared night
 * texture does not light the same windows on neighbouring buildings.
 */
export function facadeUvOffset(seed: string): number {
  // FNV-1a 32-bit, then mapped to the unit interval.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * Assigns facade UVs to a straight extruded building AND splits its side walls
 * into the upper (window) and ground (door) material groups.
 *
 * The geometry is the non-indexed output of {@link THREE.ExtrudeGeometry} after
 * `rotateX(-PI/2)` + `translate(0, minHeight, 0)`, so positions are already in
 * local metres with +y up. The cap group (materialIndex 0) is left untouched.
 * The side group (materialIndex 1) is six vertices per full-height wall quad in
 * the order [a, b, d, b, c, d] where a/b sit on the bottom edge and c/d
 * directly above them.
 *
 * Each full-height side quad is cut horizontally at `base + groundFloorMetres`
 * (base = the building's lowest wall vertex) into a lower (ground) quad and an
 * upper quad. The ground quad is tagged with {@link GROUND_WALL_MATERIAL_INDEX}
 * and the remainder with {@link UPPER_WALL_MATERIAL_INDEX}. UVs run U along the
 * perimeter and V = worldY / metresPerRepeatV so one repeat is one ~3 m band.
 * The rule uses only world Y, so it is data-independent and handles raised
 * buildings (minHeight > 0) via the per-building base.
 *
 * @param geometry          Extrude output; its position buffer is rebuilt.
 * @param metresPerRepeatU  Wall width (m) per horizontal repeat.
 * @param metresPerRepeatV  Wall height (m) per vertical repeat (one floor).
 * @param uvOffsetU         Per-building fractional U phase in [0, 1).
 * @param groundFloorMetres Height (m) of the ground band carrying the door.
 */
export function assignExtrudeFacadeUVs(
  geometry: THREE.ExtrudeGeometry,
  metresPerRepeatU: number,
  metresPerRepeatV: number,
  uvOffsetU: number,
  groundFloorMetres: number,
): void {
  const position = geometry.getAttribute('position');
  const sideGroup = geometry.groups.find(
    (group) => group.materialIndex === UPPER_WALL_MATERIAL_INDEX,
  );
  const offsetMetres = uvOffsetU * metresPerRepeatU;

  if (!sideGroup) {
    // No side walls (degenerate footprint): just zero the UVs.
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2),
    );
    return;
  }

  const start = sideGroup.start;
  const end = sideGroup.start + sideGroup.count;

  // Base Y across the side group so the ground band is [base, base + 3 m).
  let base = Number.POSITIVE_INFINITY;
  for (let v = start; v < end; v += 1) {
    base = Math.min(base, position.getY(v));
  }
  const cutY = base + groundFloorMetres;

  // Rebuild the side buffer as upper quads followed by ground quads. Everything
  // before `start` (the cap vertices) and after `end` is preserved verbatim.
  const upperQuads: number[][] = [];
  const groundQuads: number[][] = [];
  let cumulative = 0;

  // A quad is described by its four corners in world + UV space; we re-emit it
  // as the 6-vertex triangle layout [a, b, d, b, c, d].
  interface Corner {
    x: number;
    y: number;
    z: number;
    u: number;
    v: number;
  }

  const emitQuad = (a: Corner, b: Corner, c: Corner, d: Corner, bucket: number[][]): void => {
    const order = [a, b, d, b, c, d];
    const flat: number[] = [];
    for (const corner of order) {
      flat.push(corner.x, corner.y, corner.z, corner.u, corner.v);
    }
    bucket.push(flat);
  };

  for (let quad = start; quad + 5 < end; quad += 6) {
    // Corners from the extrude layout a, b, d, b, c, d: index 0=a(bottom j),
    // 1=b(bottom k), 4=c(top k), 5=d(top j).
    const aIndex = quad;
    const bIndex = quad + 1;
    const cIndex = quad + 4;
    const dIndex = quad + 5;
    const edgeLength = Math.hypot(
      position.getX(bIndex) - position.getX(aIndex),
      position.getZ(bIndex) - position.getZ(aIndex),
    );
    const uLeft = (cumulative + offsetMetres) / metresPerRepeatU;
    const uRight = (cumulative + edgeLength + offsetMetres) / metresPerRepeatU;
    cumulative += edgeLength;

    const bottomY = position.getY(aIndex);
    const topY = position.getY(dIndex);
    const makeCorner = (xzSource: number, y: number, u: number): Corner => ({
      x: position.getX(xzSource),
      y,
      z: position.getZ(xzSource),
      u,
      v: y / metresPerRepeatV,
    });

    // a=bottom-left, b=bottom-right, c=top-right, d=top-left.
    const aBottom = makeCorner(aIndex, bottomY, uLeft);
    const bBottom = makeCorner(bIndex, bottomY, uRight);
    const cTop = makeCorner(cIndex, topY, uRight);
    const dTop = makeCorner(dIndex, topY, uLeft);

    if (topY <= cutY + 1e-4) {
      // Entire quad sits in the ground band.
      emitQuad(aBottom, bBottom, cTop, dTop, groundQuads);
    } else if (bottomY >= cutY - 1e-4) {
      // Entire quad sits above the ground band.
      emitQuad(aBottom, bBottom, cTop, dTop, upperQuads);
    } else {
      // Quad straddles the cut: split into a ground sub-quad and an upper one.
      const aCut = makeCorner(aIndex, cutY, uLeft);
      const bCut = makeCorner(bIndex, cutY, uRight);
      emitQuad(aBottom, bBottom, bCut, aCut, groundQuads);
      emitQuad(aCut, bCut, cTop, dTop, upperQuads);
    }
  }

  rebuildExtrudeSide(geometry, start, end, upperQuads, groundQuads);
}

/**
 * Rewrites the extrude geometry's position/uv/normal buffers so the side group
 * is replaced by the supplied upper + ground quads, then sets the three groups
 * (cap kept at index 0). Normals are recomputed for the rebuilt side vertices.
 */
function rebuildExtrudeSide(
  geometry: THREE.ExtrudeGeometry,
  start: number,
  end: number,
  upperQuads: number[][],
  groundQuads: number[][],
): void {
  const position = geometry.getAttribute('position');
  const totalVertices = position.count;
  const capVertices = start; // cap group occupies [0, start)
  const tailVertices = totalVertices - end; // any vertices after the side group

  const upperVertexCount = upperQuads.length * 6;
  const groundVertexCount = groundQuads.length * 6;
  const newSideVertices = upperVertexCount + groundVertexCount;
  const newTotal = capVertices + newSideVertices + tailVertices;

  const oldPosition = position as THREE.BufferAttribute;
  const newPos = new Float32Array(newTotal * 3);
  const newUv = new Float32Array(newTotal * 2);

  // Copy the cap vertices verbatim (positions only; UVs for caps are (0,0)).
  newPos.set(oldPosition.array.subarray(0, capVertices * 3), 0);

  // Write the rebuilt side vertices (upper first, then ground) with UVs.
  let posWrite = capVertices * 3;
  let uvWrite = capVertices * 2;
  const writeQuads = (quads: number[][]): void => {
    for (const quad of quads) {
      // Each quad is 6 vertices × (x, y, z, u, v).
      for (let i = 0; i < 6; i += 1) {
        const o = i * 5;
        newPos[posWrite] = quad[o];
        newPos[posWrite + 1] = quad[o + 1];
        newPos[posWrite + 2] = quad[o + 2];
        posWrite += 3;
        newUv[uvWrite] = quad[o + 3];
        newUv[uvWrite + 1] = quad[o + 4];
        uvWrite += 2;
      }
    }
  };
  writeQuads(upperQuads);
  writeQuads(groundQuads);

  // Copy any trailing vertices (none expected for ExtrudeGeometry, kept for safety).
  if (tailVertices > 0) {
    newPos.set(oldPosition.array.subarray(end * 3, totalVertices * 3), (capVertices + newSideVertices) * 3);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();

  // Rebuild groups: cap (0), then upper side, then ground side.
  geometry.clearGroups();
  if (capVertices > 0) {
    geometry.addGroup(0, capVertices, CAP_MATERIAL_INDEX);
  }
  if (upperVertexCount > 0) {
    geometry.addGroup(capVertices, upperVertexCount, UPPER_WALL_MATERIAL_INDEX);
  }
  if (groundVertexCount > 0) {
    geometry.addGroup(capVertices + upperVertexCount, groundVertexCount, GROUND_WALL_MATERIAL_INDEX);
  }
}

/**
 * Assigns facade UVs to the twisted/tapered segmented geometry AND splits its
 * side quads into the upper (window) and ground (door) material groups.
 *
 * Vertex layout authored by the segmented builder: `(segments + 1)` rings of
 * `ringCount` vertices each (the side lattice). U is the cumulative
 * ring-perimeter distance of each column in metres; V is world height in metres.
 * The index buffer's side range (two triangles per slice quad) is reordered so
 * the ground-band slice quads (those whose top does not exceed
 * `base + groundFloorMetres`) form a contiguous run tagged with
 * {@link GROUND_WALL_MATERIAL_INDEX}; the rest stay on
 * {@link UPPER_WALL_MATERIAL_INDEX}. Cap fans keep their own index range and
 * material index. Because the slices are ~1 m tall the band boundary lands on a
 * slice edge, so the door occupies roughly the lowest storey.
 */
export function assignSegmentedFacadeUVs(
  geometry: THREE.BufferGeometry,
  ringCount: number,
  segments: number,
  metresPerRepeatU: number,
  metresPerRepeatV: number,
  uvOffsetU: number,
  groundFloorMetres: number,
): void {
  const position = geometry.getAttribute('position');
  const vertexCount = position.count;
  const uv = new Float32Array(vertexCount * 2);
  const offsetMetres = uvOffsetU * metresPerRepeatU;

  // Cumulative perimeter distance at each ring column, measured on the base ring.
  const columnDistance = new Float32Array(ringCount + 1);
  for (let index = 0; index < ringCount; index += 1) {
    const current = index;
    const next = (index + 1) % ringCount;
    const dx = position.getX(next) - position.getX(current);
    const dz = position.getZ(next) - position.getZ(current);
    columnDistance[index + 1] = columnDistance[index] + Math.hypot(dx, dz);
  }

  for (let level = 0; level <= segments; level += 1) {
    for (let index = 0; index < ringCount; index += 1) {
      const vertex = level * ringCount + index;
      if (vertex >= vertexCount) {
        break;
      }
      const uIndex = vertex * 2;
      uv[uIndex] = (columnDistance[index] + offsetMetres) / metresPerRepeatU;
      uv[uIndex + 1] = position.getY(vertex) / metresPerRepeatV;
    }
  }

  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));

  splitSegmentedSideGroups(geometry, ringCount, segments, groundFloorMetres);
}

/**
 * Splits the segmented side index range into upper/ground groups by height and
 * tags the cap fans with the cap material index.
 *
 * The segmented builder emits the side quads first (segments × ringCount quads,
 * 6 indices each) and then the two cap fans. We reorder only the side index
 * entries so ground-band quads trail the upper ones, then set three groups:
 * cap (all remaining fan indices on index 0), upper side, ground side.
 */
function splitSegmentedSideGroups(
  geometry: THREE.BufferGeometry,
  ringCount: number,
  segments: number,
  groundFloorMetres: number,
): void {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index || ringCount < 3 || segments < 1) {
    return;
  }

  const sideIndexCount = segments * ringCount * 6;
  if (sideIndexCount > index.count) {
    return;
  }

  // Base Y of the solid (slice level 0).
  let base = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ringCount; i += 1) {
    base = Math.min(base, position.getY(i));
  }
  const cutY = base + groundFloorMetres;

  const upper: number[] = [];
  const ground: number[] = [];
  for (let tri = 0; tri + 5 < sideIndexCount; tri += 6) {
    let top = Number.NEGATIVE_INFINITY;
    const indices: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      const vi = index.getX(tri + k);
      indices.push(vi);
      top = Math.max(top, position.getY(vi));
    }
    if (top <= cutY + 1e-4) {
      ground.push(...indices);
    } else {
      upper.push(...indices);
    }
  }

  // Write the reordered side indices back (upper then ground); cap fans after
  // sideIndexCount are untouched.
  const reordered = [...upper, ...ground];
  for (let offset = 0; offset < reordered.length; offset += 1) {
    index.setX(offset, reordered[offset]);
  }
  index.needsUpdate = true;

  geometry.clearGroups();
  if (upper.length > 0) {
    geometry.addGroup(0, upper.length, UPPER_WALL_MATERIAL_INDEX);
  }
  if (ground.length > 0) {
    geometry.addGroup(upper.length, ground.length, GROUND_WALL_MATERIAL_INDEX);
  }
  const capCount = index.count - sideIndexCount;
  if (capCount > 0) {
    geometry.addGroup(sideIndexCount, capCount, CAP_MATERIAL_INDEX);
  }
}
