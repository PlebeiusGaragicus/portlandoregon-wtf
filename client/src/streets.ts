import {
  findStreetTile,
  streetEdge,
  tileKeyAt,
  type GameMap,
  type StreetEdge,
  type StreetNode,
  type StreetStore,
} from "@portlandoregon/shared";

/** One access shape for compact production stores and tiny object-form tests. */
export interface StreetAccess {
  readonly edgeCount: number;
  readonly nodeCount: number;
  edge(index: number): StreetEdge;
  node(index: number): StreetNode;
  /** Render-order edge indices whose representative midpoint occupies key. */
  tileEdges(key: number, tileSize: number): ArrayLike<number>;
  renderTileKeys(tileSize: number): ArrayLike<number>;
}

export function streetsFrom(map: Pick<GameMap, "edges" | "nodes">, store?: StreetStore): StreetAccess {
  if (store) {
    return {
      edgeCount: store.edgeCount,
      nodeCount: store.nodeCount,
      edge: (index) => streetEdge(store, index),
      node: (index) => ({
        id: store.nodeId[index]!,
        x: store.nodeX[index]!,
        y: store.nodeY[index]!,
      }),
      tileEdges: (key, tileSize) => {
        if (tileSize !== store.tileSize) return [];
        const tile = findStreetTile(store, key);
        return tile < 0
          ? []
          : store.tileEdge.subarray(store.tileStart[tile]!, store.tileStart[tile + 1]!);
      },
      renderTileKeys: (tileSize) => tileSize === store.tileSize ? store.tileKey : [],
    };
  }
  const edges = map.edges ?? [];
  const nodes = map.nodes ?? [];
  return {
    edgeCount: edges.length,
    nodeCount: nodes.length,
    edge: (index) => edges[index]!,
    node: (index) => nodes[index]!,
    tileEdges: (key, tileSize) => {
      const out: number[] = [];
      for (let index = 0; index < edges.length; index++) {
        const edge = edges[index]!;
        const point = edge.polyline[Math.floor(edge.polyline.length / 2)] ?? [0, 0];
        if (tileKeyAt(point[0], point[1], tileSize) === key) out.push(index);
      }
      return out;
    },
    renderTileKeys: (tileSize) => {
      const out = new Set<number>();
      for (const edge of edges) {
        const point = edge.polyline[Math.floor(edge.polyline.length / 2)] ?? [0, 0];
        out.add(tileKeyAt(point[0], point[1], tileSize));
      }
      return [...out].sort((a, b) => a - b);
    },
  };
}
