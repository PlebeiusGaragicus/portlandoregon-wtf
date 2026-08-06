import {
  streetEdge,
  type GameMap,
  type StreetEdge,
  type StreetNode,
  type StreetStore,
} from "@battle-juice/shared";

/** One access shape for compact production stores and tiny object-form tests. */
export interface StreetAccess {
  readonly edgeCount: number;
  readonly nodeCount: number;
  edge(index: number): StreetEdge;
  node(index: number): StreetNode;
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
    };
  }
  const edges = map.edges ?? [];
  const nodes = map.nodes ?? [];
  return {
    edgeCount: edges.length,
    nodeCount: nodes.length,
    edge: (index) => edges[index]!,
    node: (index) => nodes[index]!,
  };
}
