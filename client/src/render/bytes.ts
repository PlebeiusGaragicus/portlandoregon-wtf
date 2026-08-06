import * as THREE from "three";

/** CPU-side bytes that mirror buffers retained/uploaded for one geometry. */
export function geometryBytes(geometry: THREE.BufferGeometry): number {
  const arrays = new Set<ArrayBufferLike>();
  for (const attribute of Object.values(geometry.attributes)) {
    const array = attribute instanceof THREE.InterleavedBufferAttribute
      ? attribute.data.array
      : attribute.array;
    arrays.add(array.buffer);
  }
  if (geometry.index) arrays.add(geometry.index.array.buffer);
  let bytes = 0;
  for (const buffer of arrays) bytes += buffer.byteLength;
  return bytes;
}

/** Tile-owned geometry and per-instance buffers; shared materials excluded. */
export function objectBufferBytes(root: THREE.Object3D): number {
  const geometries = new Set<THREE.BufferGeometry>();
  const arrays = new Set<ArrayBufferLike>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      geometries.add(object.geometry);
    }
    if (object instanceof THREE.InstancedMesh) {
      arrays.add(object.instanceMatrix.array.buffer);
      if (object.instanceColor) arrays.add(object.instanceColor.array.buffer);
    }
  });
  let bytes = 0;
  for (const geometry of geometries) bytes += geometryBytes(geometry);
  for (const buffer of arrays) bytes += buffer.byteLength;
  return bytes;
}
