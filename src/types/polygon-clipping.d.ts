// The bundled polygon-clipping types (node_modules/polygon-clipping/dist/
// polygon-clipping.d.ts) declare ONLY named exports, but the package's ESM build
// (resolved by Vite/Rollup) exposes a single DEFAULT export. A named import
// therefore typechecks yet breaks `vite build` with "not exported". This module
// augmentation adds the missing default export so collision.ts can import the
// default (which works in both tsc and the ESM bundle) with full typing.
declare module 'polygon-clipping' {
  type Geom = Polygon | MultiPolygon;
  const polygonClipping: {
    intersection: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
    union: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
    xor: (geom: Geom, ...geoms: Geom[]) => MultiPolygon;
    difference: (subjectGeom: Geom, ...clipGeoms: Geom[]) => MultiPolygon;
  };
  export default polygonClipping;
}
