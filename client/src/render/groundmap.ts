import * as THREE from "three";
import { heightAt, type Heightfield } from "@battle-juice/shared";
import type { StreetAccess } from "../streets.js";

/**
 * The ground map: the city's flat features — water, parks, rail yards,
 * streets — baked from their real vector data into one full-map texture,
 * draped over the terrain.
 *
 * Streets, water color and park color only EXIST as geometry near the camera
 * (the dressing window ends at ~2 km, the vertex-tinted terrain window not
 * much further), so wide views used to show bare ground everywhere else.
 * City-wide copies of those layers as geometry are exactly what the
 * streaming work removed — sidewalks alone were 277 MB. A texture is the
 * right shape for this data at altitude: one draw call, memory fixed by
 * resolution rather than by feature count, and the GPU samples exactly the
 * pixels the screen needs.
 *
 * The bake is vector-crisp: polygons are filled and centerlines stroked onto
 * a canvas at 2x the upload size, then downscaled — so lines land
 * antialiased no matter what the final texel density is. Raising `texSize`
 * is the whole knob if wide zoom should resolve finer detail.
 *
 * The drape uses a Lambert material, so day/night lighting dims it in step
 * with the real terrain — no rebake on the clock, unlike the building
 * impostor (whose boxes genuinely change shape and tint).
 */
export interface GroundMap {
  mesh: THREE.Mesh;
  /** Paint the canvas in frame-sized slices; installs the texture at the
   * end. The mesh renders fully transparent until then. */
  fill(): Generator<void, void, void>;
  dispose(): void;
}

export interface GroundMapColors {
  water: number;
  park: number;
  yard: number;
  street: number;
}

export interface GroundMapOptions {
  /** Map extent in world meters. */
  width: number;
  height: number;
  hf: Heightfield | null;
  /** Final texture width in texels (height follows the map aspect). */
  texSize: number;
  colors: GroundMapColors;
  /** Polygon layers, bodies -> rings (outer first, holes after). */
  water: { rings: [number, number][][] }[];
  parks: { rings: [number, number][][] }[];
  yards: { rings: [number, number][][] }[];
  streets: StreetAccess;
  /** Rendered curb-to-curb width for an edge, world meters. */
  streetWidth: (edgeIndex: number) => number;
  /** Skip an edge entirely (tunnels vanish into the hillside). */
  skipEdge: (edgeIndex: number) => boolean;
}

/** Supersample factor for the bake canvas: stroked centerlines a texel or
 * two wide come out clean instead of stair-stepped. */
const BAKE_SCALE = 2;
/** Drape grid spacing in meters. The 30 m heightfield is 4x this in verts
 * for relief the texture's own shading would not even show at these zooms. */
const GRID_STEP = 90;
/** Match the decal stack's hover over the terrain (see DECAL_Y discussion —
 * this drape never coexists with the coplanar decals, it replaces them past
 * the dressing window, so it only needs to clear the ground mesh). */
const DRAPE_LIFT = 0.45;
/** Polygon vertices scanned per fill slice. */
const POLY_SLICE = 20000;
/** Street edges stroked per fill slice. */
const EDGE_SLICE = 4000;

function hexStyle(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** Returns null where no real 2D canvas exists (headless tools, tests —
 * including the ones that shim `document` just enough for glow sprites). */
export function buildGroundMap(opts: GroundMapOptions): GroundMap | null {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return null;
  const texW = opts.texSize;
  const texH = Math.max(1, Math.round((texW * opts.height) / opts.width));

  // Geometry: heightfield-conforming plane, or a flat quad without terrain.
  const segX = opts.hf ? Math.max(1, Math.round(opts.width / GRID_STEP)) : 1;
  const segY = opts.hf ? Math.max(1, Math.round(opts.height / GRID_STEP)) : 1;
  const geo = new THREE.PlaneGeometry(opts.width, opts.height, segX, segY);
  geo.rotateX(-Math.PI / 2);
  geo.translate(opts.width / 2, 0, -opts.height / 2);
  if (opts.hf) {
    const position = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, heightAt(opts.hf, position.getX(i), -position.getZ(i)) + DRAPE_LIFT);
    }
    position.needsUpdate = true;
    geo.computeVertexNormals();
  } else {
    geo.translate(0, DRAPE_LIFT, 0);
  }

  const canvas = document.createElement("canvas");
  canvas.width = texW;
  canvas.height = texH;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const material = new THREE.MeshLambertMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = true;

  function* paint(): Generator<void, void, void> {
    // Paint at 2x, downscale at the end. The bake canvas is transient RAM
    // (~4x the final texture) and is released as soon as it is copied down.
    const bake = document.createElement("canvas");
    bake.width = texW * BAKE_SCALE;
    bake.height = texH * BAKE_SCALE;
    const ctx = bake.getContext("2d");
    if (!ctx) return;
    // World -> canvas: north at the top. CanvasTexture flips rows on upload,
    // so GL row 0 becomes the canvas bottom — the map's south edge — which
    // is the orientation the drape's UVs expect.
    const sx = bake.width / opts.width;
    const sy = bake.height / opts.height;
    const px = (x: number): number => x * sx;
    const py = (y: number): number => bake.height - y * sy;

    function* fillBodies(
      bodies: { rings: [number, number][][] }[],
      color: number,
    ): Generator<void, void, void> {
      ctx!.fillStyle = hexStyle(color);
      let scanned = 0;
      for (const body of bodies) {
        const path = new Path2D();
        for (const ring of body.rings) {
          if (ring.length < 3) continue;
          path.moveTo(px(ring[0]![0]), py(ring[0]![1]));
          for (let i = 1; i < ring.length; i++) path.lineTo(px(ring[i]![0]), py(ring[i]![1]));
          path.closePath();
          scanned += ring.length;
        }
        // All rings in one even-odd fill, so island holes come free.
        ctx!.fill(path, "evenodd");
        if (scanned >= POLY_SLICE) {
          scanned = 0;
          yield;
        }
      }
    }

    // Same paint order as the decal stack: water, park, yard, then streets
    // on top — bridge legs cross the river as street-colored strokes, which
    // is what keeps the crossings readable at altitude.
    yield* fillBodies(opts.water, opts.colors.water);
    yield* fillBodies(opts.parks, opts.colors.park);
    yield* fillBodies(opts.yards, opts.colors.yard);

    ctx.strokeStyle = hexStyle(opts.colors.street);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const edges = opts.streets;
    for (let from = 0; from < edges.edgeCount; from += EDGE_SLICE) {
      const to = Math.min(edges.edgeCount, from + EDGE_SLICE);
      for (let i = from; i < to; i++) {
        if (opts.skipEdge(i)) continue;
        const line = edges.edge(i).polyline;
        if (line.length < 2) continue;
        ctx.lineWidth = Math.max(1, opts.streetWidth(i) * sx);
        ctx.beginPath();
        ctx.moveTo(px(line[0]![0]), py(line[0]![1]));
        for (let p = 1; p < line.length; p++) ctx.lineTo(px(line[p]![0]), py(line[p]![1]));
        ctx.stroke();
      }
      yield;
    }

    const out = canvas.getContext("2d");
    if (out) {
      out.imageSmoothingEnabled = true;
      out.imageSmoothingQuality = "high";
      out.drawImage(bake, 0, 0, texW, texH);
    }
    // Free the supersample canvas now rather than at the GC's leisure.
    bake.width = 0;
    bake.height = 0;
    texture.needsUpdate = true;
  }

  return {
    mesh,
    fill: paint,
    dispose(): void {
      texture.dispose();
      material.dispose();
      geo.dispose();
      mesh.removeFromParent();
    },
  };
}
