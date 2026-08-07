import * as THREE from "three";
import {
  selectOverviewAtlasLevel,
  type OverviewAtlasSource,
} from "../overview-atlas.js";
import type { FireOverviewSnapshot } from "./fire.js";

export interface OverviewOpacity {
  atlas: number;
  symbols: number;
}

export interface OverviewGameplayMarker {
  id?: string | number;
  x: number;
  y: number;
  kind: "unit" | "objective";
  side?: "north" | "south" | "neutral";
  label?: string;
  color?: THREE.ColorRepresentation;
}

export interface OverviewOptions {
  source: Promise<OverviewAtlasSource | null>;
  map: {
    name: string;
    sourceDate: string;
    width: number;
    height: number;
  };
  handheld: boolean;
  maxTextureSize: number;
  maxAnisotropy?: number;
  opacity?: Partial<OverviewOpacity>;
}

export interface OverviewLayer {
  group: THREE.Group;
  /** Empty in task 2; later overview symbols attach here without rebuilding. */
  symbols: THREE.Group;
  /** Resolves false for an absent, invalid, or failed optional atlas. */
  ready: Promise<boolean>;
  setOpacity(opacity: Partial<OverviewOpacity>): void;
  setTint(tint: THREE.ColorRepresentation): void;
  setDayNightTint(night: number): void;
  setFireMarkers(snapshot: FireOverviewSnapshot): void;
  setGameplayMarkers(markers: readonly OverviewGameplayMarker[]): void;
  dispose(): void;
}

export type ZoomTierOwner = "tactical" | "transition" | "overview";

export interface ZoomTierVisibility {
  owner: ZoomTierOwner;
  tacticalWorld: boolean;
  tacticalDetails: boolean;
  tacticalLandmarks: boolean;
  tacticalEffects: boolean;
  atlas: boolean;
  symbols: boolean;
  symbolOpacity: number;
}

const VISIBLE_EPSILON = 1e-4;

/** One decision owns all tactical/transition/overview visibility gates. */
export function resolveZoomTierVisibility(input: {
  transition: number;
  atlasReady: boolean;
  atlasOpacity: number;
}): ZoomTierVisibility {
  const transition = clamp01(input.transition);
  const owner: ZoomTierOwner =
    transition <= VISIBLE_EPSILON
      ? "tactical"
      : transition >= 1 - VISIBLE_EPSILON
        ? "overview"
        : "transition";
  const atlas =
    input.atlasReady &&
    input.atlasOpacity > VISIBLE_EPSILON;
  return {
    owner,
    // Atlas absence keeps the complete tactical city as the cartographic
    // fallback, without returning landmark/effects ownership to that tier.
    tacticalWorld: !(input.atlasReady && input.atlasOpacity >= 1 - VISIBLE_EPSILON),
    tacticalDetails: owner === "tactical",
    tacticalLandmarks: owner === "tactical",
    tacticalEffects: owner !== "overview",
    atlas,
    symbols: transition > VISIBLE_EPSILON,
    symbolOpacity: transition,
  };
}

export function overviewPlaneTransform(
  extent: { minX: number; minY: number; width: number; height: number },
  elevation: number,
): {
  scale: readonly [number, number, number];
  position: readonly [number, number, number];
} {
  return {
    // PlaneGeometry is rotated into XZ, so map height belongs on local Z.
    scale: [extent.width, 1, extent.height],
    position: [
      extent.minX + extent.width / 2,
      elevation,
      -(extent.minY + extent.height / 2),
    ],
  };
}

const DAY_TINT = new THREE.Color(0xffffff);
const NIGHT_TINT = new THREE.Color(0x7185a8);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function prepareTexture(texture: THREE.Texture, anisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = Math.max(1, Math.min(4, anisotropy));
  texture.needsUpdate = true;
}

function pointGeometry(
  markers: readonly { x: number; y: number }[],
  colorOf: (index: number) => THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const positions = new Float32Array(markers.length * 3);
  const colors = new Float32Array(markers.length * 3);
  const color = new THREE.Color();
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    positions.set([marker.x, 4, -marker.y], i * 3);
    color.set(colorOf(i)).toArray(colors, i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function pointMaterial(size: number): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function replacePoints(
  current: THREE.Points,
  markers: readonly { x: number; y: number }[],
  colorOf: (index: number) => THREE.ColorRepresentation,
): void {
  current.geometry.dispose();
  current.geometry = pointGeometry(markers, colorOf);
}

function disposeObjectResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) {
      geometries.add(object.geometry);
    }
    if (!("material" in object)) return;
    const own = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of own) {
      if (!(material instanceof THREE.Material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/**
 * Construct the scene nodes synchronously, then populate the city map when its
 * PNG arrives. Loading and decode happen outside tactical boot; failure leaves
 * the existing ground map/building boxes untouched.
 */
export function buildOverview(opts: OverviewOptions): OverviewLayer {
  const group = new THREE.Group();
  group.name = "overview";
  const symbols = new THREE.Group();
  symbols.name = "overview-symbols";
  symbols.renderOrder = 110;

  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const atlasMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    // This is a cartographic cross-fade, not world geometry. Terrain relief
    // and building depth must not punch holes through it mid-transition.
    depthTest: false,
    depthWrite: false,
    opacity: clamp01(opts.opacity?.atlas ?? 0),
  });
  atlasMaterial.visible = false;

  const fireMaterial = pointMaterial(8);
  const firePoints = new THREE.Points(new THREE.BufferGeometry(), fireMaterial);
  firePoints.name = "overview-fires";
  firePoints.renderOrder = 112;
  const collapsedMaterial = pointMaterial(4.5);
  const collapsedPoints = new THREE.Points(new THREE.BufferGeometry(), collapsedMaterial);
  collapsedPoints.name = "overview-collapsed";
  collapsedPoints.renderOrder = 111;
  const gameplayMaterial = pointMaterial(7);
  const gameplayPoints = new THREE.Points(new THREE.BufferGeometry(), gameplayMaterial);
  gameplayPoints.name = "overview-gameplay";
  gameplayPoints.renderOrder = 113;
  symbols.add(collapsedPoints, firePoints, gameplayPoints);

  const atlas = new THREE.Mesh(geometry, atlasMaterial);
  atlas.name = "overview-city";
  atlas.renderOrder = 100;
  group.add(atlas, symbols);

  let disposed = false;
  let tint = new THREE.Color(0xffffff);

  const setOpacity = (opacity: Partial<OverviewOpacity>): void => {
    if (opacity.atlas !== undefined) atlasMaterial.opacity = clamp01(opacity.atlas);
    if (opacity.symbols !== undefined) {
      const alpha = clamp01(opacity.symbols);
      fireMaterial.opacity = alpha;
      collapsedMaterial.opacity = alpha * 0.8;
      gameplayMaterial.opacity = alpha;
    }
  };
  const setTint = (color: THREE.ColorRepresentation): void => {
    tint = new THREE.Color(color);
    atlasMaterial.color.copy(tint);
  };

  const ready = opts.source
    .then(async (source) => {
      if (!source || disposed) return false;
      const manifest = source.manifest;
      if (
        manifest.map.name !== opts.map.name ||
        manifest.map.sourceDate !== opts.map.sourceDate ||
        manifest.extent.width !== opts.map.width ||
        manifest.extent.height !== opts.map.height
      ) {
        return false;
      }
      const level = selectOverviewAtlasLevel(source.manifest, {
        handheld: opts.handheld,
        maxTextureSize: opts.maxTextureSize,
      });
      const loader = new THREE.TextureLoader();
      const result = await Promise.allSettled([
        loader.loadAsync(new URL(level.image.file, source.baseUrl).href),
      ]);
      if (result[0].status !== "fulfilled" || disposed) {
        if (result[0].status === "fulfilled") result[0].value.dispose();
        return false;
      }

      const texture = result[0].value;
      const anisotropy = opts.maxAnisotropy ?? 1;
      prepareTexture(texture, anisotropy);
      atlasMaterial.map = texture;
      atlasMaterial.visible = true;
      atlasMaterial.needsUpdate = true;

      const extent = source.manifest.extent;
      const transform = overviewPlaneTransform(extent, 0.8);
      atlas.scale.set(...transform.scale);
      // PlaneGeometry's +v edge becomes map north after the rotation.
      atlas.position.set(...transform.position);
      atlas.updateMatrix();
      return true;
    })
    .catch(() => false);

  return {
    group,
    symbols,
    ready,
    setOpacity,
    setTint,
    setDayNightTint(night: number): void {
      tint.copy(DAY_TINT).lerp(NIGHT_TINT, clamp01(night));
      atlasMaterial.color.copy(tint);
    },
    setFireMarkers(snapshot: FireOverviewSnapshot): void {
      replacePoints(
        firePoints,
        snapshot.active,
        (index) => new THREE.Color(0xff5a24).lerp(new THREE.Color(0xffe0a0), clamp01(snapshot.active[index]!.intensity)),
      );
      replacePoints(collapsedPoints, snapshot.collapsed, () => 0x554d48);
    },
    setGameplayMarkers(markers: readonly OverviewGameplayMarker[]): void {
      replacePoints(gameplayPoints, markers, (index) => {
        const marker = markers[index]!;
        if (marker.color !== undefined) return marker.color;
        if (marker.kind === "objective") return 0xffd84d;
        if (marker.side === "north") return 0x4f83ff;
        if (marker.side === "south") return 0xff5b55;
        return 0xf1f1f1;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      disposeObjectResources(group);
      group.clear();
    },
  };
}
