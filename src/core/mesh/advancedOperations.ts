import {
  canonicalEdgeKey,
  EditableMesh,
  MeshFace,
  Vec3,
} from './EditableMesh';
import {
  EditSelectionMode,
  MeshOperatorContext,
  MeshOperatorResult,
  meshOperatorRegistry,
} from './operations';

export type ExtrudeAxis = 'normal' | 'x' | 'y' | 'z';

export interface ExtrudeParams {
  distance: number;
  axis: ExtrudeAxis;
  individual: boolean;
}

export interface InsetParams {
  thickness: number; // 0.02 .. 0.9
  depth: number;
  individual: boolean;
}

export interface SubdivideParams {
  cuts: number; // 1 .. 6
  smoothness: number; // 0 .. 1
  fractal: number; // 0 .. 0.5
}

export interface BevelParams {
  width: number; // 0.02 .. 0.8
  segments: number; // 1 .. 5
  profile: number; // 0.1 .. 1.0
  clampOverlap: boolean;
}

export interface EdgeLoopRing {
  edgeIds: string[]; // Ordered edges along the ring (length = faceIds.length + (isClosed ? 0 : 1))
  faceIds: string[]; // Ordered quad faces crossed by the ring
  /** For each faceIds[k], the directed pair of vertex IDs on edgeIds[k] and opposite edgeIds[k+1] */
  quadSteps: {
    faceId: string;
    a0: string;
    b0: string;
    a1: string;
    b1: string;
  }[];
  isClosed: boolean;
}

export interface LoopCutParams {
  edgeId: string | null;
  cuts: number; // 1 .. 8
  slide: number; // -0.9 .. 0.9 (for single cut or offset)
}

export type MergeMode = 'center' | 'first' | 'last' | 'cursor';

export interface MergeParams {
  mode: MergeMode;
  cursorPosition?: Vec3;
}

export type DeleteActionType =
  | 'delete_vertices'
  | 'dissolve_vertices'
  | 'delete_edges'
  | 'delete_edges_and_vertices'
  | 'dissolve_edges'
  | 'delete_only_faces'
  | 'delete_faces_and_edges'
  | 'dissolve_faces';

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVec(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lenVec(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normVec(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const l = lenVec(a);
  if (l < 1e-8) return fallback;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function axisVector(axis: ExtrudeAxis): Vec3 {
  if (axis === 'x') return [1, 0, 0];
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return [0, 1, 0];
}

function deterministicJitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 500 - 1; // [-1, 1]
}

/* ============================================================================
 * A. EXTRUDE — EXTRUSIÓN (Caras, Aristas, Vértices)
 * ========================================================================== */
export function extrudeMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  params: ExtrudeParams,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();
  const { distance, axis, individual } = params;

  if (selectedIds.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  if (mode === 'vertex') {
    for (const vid of selectedIds) {
      const v = mesh.getVertex(vid);
      if (!v) continue;
      const dir =
        axis === 'normal' ? mesh.computeVertexNormal(vid) : axisVector(axis);
      const pos = addVec(v.position, scaleVec(dir, distance));
      const newV = mesh.addVertex(pos[0], pos[1], pos[2]);
      mesh.addEdge(vid, newV.id);
      nextSelected.add(newV.id);
    }
    return { mesh, nextSelectedIds: nextSelected };
  }

  if (mode === 'edge') {
    const validEdges = Array.from(selectedIds)
      .map((id) => mesh.getEdge(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    if (validEdges.length === 0) return { mesh, nextSelectedIds: nextSelected };

    const vertSet = new Set<string>();
    for (const e of validEdges) {
      vertSet.add(e.v0);
      vertSet.add(e.v1);
    }

    const vertMap = new Map<string, string>();
    for (const vid of vertSet) {
      const v = mesh.getVertex(vid);
      if (!v) continue;
      const dir =
        axis === 'normal' ? mesh.computeVertexNormal(vid) : axisVector(axis);
      const pos = addVec(v.position, scaleVec(dir, distance));
      const newV = mesh.addVertex(pos[0], pos[1], pos[2]);
      vertMap.set(vid, newV.id);
    }

    for (const e of validEdges) {
      const n0 = vertMap.get(e.v0);
      const n1 = vertMap.get(e.v1);
      if (!n0 || !n1) continue;

      // Orient wall quad continuously with an existing adjacent face if any
      let reverseWinding = false;
      const adjFaceIds = mesh.getFacesForEdge(e.id);
      if (adjFaceIds.length > 0) {
        const f = mesh.getFace(adjFaceIds[0]);
        if (f) {
          const idx = f.vertexIds.indexOf(e.v0);
          if (idx !== -1 && f.vertexIds[(idx + 1) % f.vertexIds.length] === e.v1) {
            reverseWinding = true;
          }
        }
      }

      if (reverseWinding) {
        mesh.addFace([e.v1, e.v0, n0, n1]);
      } else {
        mesh.addFace([e.v0, e.v1, n1, n0]);
      }

      const extrudedEdgeId = mesh.findEdgeId(n0, n1);
      if (extrudedEdgeId) nextSelected.add(extrudedEdgeId);
    }

    return { mesh, nextSelectedIds: nextSelected };
  }

  // FACE MODE
  const selectedFaces = Array.from(selectedIds)
    .map((id) => mesh.getFace(id))
    .filter((f): f is MeshFace => Boolean(f));
  if (selectedFaces.length === 0) return { mesh, nextSelectedIds: nextSelected };

  if (individual) {
    const faceIdsToDelete = new Set<string>();
    for (const face of selectedFaces) {
      faceIdsToDelete.add(face.id);
      const dir =
        axis === 'normal' ? mesh.computeFaceNormal(face) : axisVector(axis);
      const offset = scaleVec(dir, distance);

      const oldIds = [...face.vertexIds];
      const newIds: string[] = [];
      for (const vid of oldIds) {
        const v = mesh.getVertex(vid);
        if (!v) continue;
        const pos = addVec(v.position, offset);
        newIds.push(mesh.addVertex(pos[0], pos[1], pos[2]).id);
      }
      if (newIds.length !== oldIds.length) continue;

      const k = oldIds.length;
      for (let i = 0; i < k; i++) {
        const nextI = (i + 1) % k;
        mesh.addFace([oldIds[i], oldIds[nextI], newIds[nextI], newIds[i]]);
      }

      const capFace = mesh.addFace(newIds);
      if (capFace) nextSelected.add(capFace.id);
    }
    mesh.deleteFaces(faceIdsToDelete);
    return { mesh, nextSelectedIds: nextSelected };
  }

  // REGION EXTRUDE (Connected faces share new extruded vertices)
  const selectedFaceIdSet = new Set(selectedFaces.map((f) => f.id));
  const vertexNormalsAccum = new Map<string, Vec3>();
  const vertSet = new Set<string>();

  for (const face of selectedFaces) {
    const fn = mesh.computeFaceNormal(face);
    for (const vid of face.vertexIds) {
      vertSet.add(vid);
      const prev = vertexNormalsAccum.get(vid) ?? [0, 0, 0];
      vertexNormalsAccum.set(vid, addVec(prev, fn));
    }
  }

  const vertMap = new Map<string, string>();
  for (const vid of vertSet) {
    const v = mesh.getVertex(vid);
    if (!v) continue;
    const dir =
      axis === 'normal'
        ? normVec(vertexNormalsAccum.get(vid) ?? [0, 1, 0])
        : axisVector(axis);
    const pos = addVec(v.position, scaleVec(dir, distance));
    const nv = mesh.addVertex(pos[0], pos[1], pos[2]);
    vertMap.set(vid, nv.id);
  }

  // Count how many selected faces use each canonical edge
  const edgeUseCountInSelection = new Map<string, number>();
  for (const face of selectedFaces) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertexIds[i];
      const b = face.vertexIds[(i + 1) % n];
      const key = canonicalEdgeKey(a, b);
      edgeUseCountInSelection.set(key, (edgeUseCountInSelection.get(key) ?? 0) + 1);
    }
  }

  // Find internal edges (shared exclusively by selected faces) to clean up
  const internalEdgeIds = new Set<string>();
  for (const face of selectedFaces) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertexIds[i];
      const b = face.vertexIds[(i + 1) % n];
      const eid = mesh.findEdgeId(a, b);
      if (!eid) continue;
      const allIncident = mesh.getFacesForEdge(eid);
      if (allIncident.every((fid) => selectedFaceIdSet.has(fid))) {
        const key = canonicalEdgeKey(a, b);
        if ((edgeUseCountInSelection.get(key) ?? 0) >= 2) {
          internalEdgeIds.add(eid);
        }
      }
    }
  }

  // Create boundary wall quads & new cap faces
  const newCapSpecs: string[][] = [];
  for (const face of selectedFaces) {
    const n = face.vertexIds.length;
    const mappedFaceVerts: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = face.vertexIds[i];
      const b = face.vertexIds[(i + 1) % n];
      const ma = vertMap.get(a)!;
      const mb = vertMap.get(b)!;
      mappedFaceVerts.push(ma);

      const key = canonicalEdgeKey(a, b);
      if (edgeUseCountInSelection.get(key) === 1) {
        mesh.addFace([a, b, mb, ma]);
      }
    }
    newCapSpecs.push(mappedFaceVerts);
  }

  // Delete original selected faces & internal edges, add new caps
  mesh.deleteFaces(selectedFaceIdSet);
  if (internalEdgeIds.size > 0) {
    mesh.deleteEdges(internalEdgeIds);
  }
  mesh.pruneOrphanVertices(vertSet);

  for (const verts of newCapSpecs) {
    const cap = mesh.addFace(verts);
    if (cap) nextSelected.add(cap.id);
  }

  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * B. INSET — INSERTAR CARAS
 * ========================================================================== */
export function insetFacesMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  params: InsetParams,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();
  const thickness = Math.max(0.02, Math.min(0.92, params.thickness));
  const depth = params.depth;

  // Gather target faces (if not in face mode, take faces whose all vertices are selected)
  const targetFaces: MeshFace[] = [];
  if (mode === 'face') {
    for (const fid of selectedIds) {
      const f = mesh.getFace(fid);
      if (f) targetFaces.push(f);
    }
  } else {
    const selVerts = mesh.getVertexIdsFromSelection(mode, selectedIds);
    for (const f of mesh.faces) {
      if (f.vertexIds.every((vid) => selVerts.has(vid))) {
        targetFaces.push(f);
      }
    }
  }

  if (targetFaces.length === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  const doIndividual = () => {
    const toDelete = new Set<string>();
    for (const face of targetFaces) {
      toDelete.add(face.id);
      const center = mesh.computeFaceCenter(face);
      const normal = mesh.computeFaceNormal(face);
      const depthVec = scaleVec(normal, depth);

      const oldIds = [...face.vertexIds];
      const innerIds: string[] = [];

      for (const vid of oldIds) {
        const v = mesh.getVertex(vid);
        if (!v) continue;
        const insetPos = addVec(lerpVec(v.position, center, thickness), depthVec);
        innerIds.push(mesh.addVertex(insetPos[0], insetPos[1], insetPos[2]).id);
      }

      if (innerIds.length !== oldIds.length) continue;
      const k = oldIds.length;
      for (let i = 0; i < k; i++) {
        const nextI = (i + 1) % k;
        mesh.addFace([oldIds[i], oldIds[nextI], innerIds[nextI], innerIds[i]]);
      }

      const innerFace = mesh.addFace(innerIds);
      if (innerFace) nextSelected.add(innerFace.id);
    }
    mesh.deleteFaces(toDelete);
  };

  if (params.individual || targetFaces.length === 1) {
    doIndividual();
    return { mesh, nextSelectedIds: nextSelected };
  }

  // REGION INSET: find boundary edges of targetFaces
  const targetFaceIds = new Set(targetFaces.map((f) => f.id));
  const edgeUseCount = new Map<string, number>();
  const boundaryHalfEdges: { a: string; b: string; face: MeshFace }[] = [];

  for (const face of targetFaces) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const key = canonicalEdgeKey(face.vertexIds[i], face.vertexIds[(i + 1) % n]);
      edgeUseCount.set(key, (edgeUseCount.get(key) ?? 0) + 1);
    }
  }

  for (const face of targetFaces) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertexIds[i];
      const b = face.vertexIds[(i + 1) % n];
      if (edgeUseCount.get(canonicalEdgeKey(a, b)) === 1) {
        boundaryHalfEdges.push({ a, b, face });
      }
    }
  }

  // If closed shell (no boundary edges), fall back to individual inset
  if (boundaryHalfEdges.length === 0) {
    doIndividual();
    return { mesh, nextSelectedIds: nextSelected };
  }

  // Compute inward displacement per boundary vertex
  const inwardAccum = new Map<string, Vec3>();
  const normalAccum = new Map<string, Vec3>();
  const edgeLenSum = new Map<string, number>();
  const edgeLenCount = new Map<string, number>();

  for (const { a, b, face } of boundaryHalfEdges) {
    const va = mesh.getVertex(a)?.position;
    const vb = mesh.getVertex(b)?.position;
    if (!va || !vb) continue;
    const fn = mesh.computeFaceNormal(face);
    const edgeVec = subVec(vb, va);
    const elen = lenVec(edgeVec);
    // Outward normal of edge in face plane is edgeVec x fn, so inward is fn x edgeVec
    const inward = normVec(crossVec(fn, edgeVec));

    for (const vid of [a, b]) {
      inwardAccum.set(vid, addVec(inwardAccum.get(vid) ?? [0, 0, 0], inward));
      normalAccum.set(vid, addVec(normalAccum.get(vid) ?? [0, 0, 0], fn));
      edgeLenSum.set(vid, (edgeLenSum.get(vid) ?? 0) + elen);
      edgeLenCount.set(vid, (edgeLenCount.get(vid) ?? 0) + 1);
    }
  }

  // Map vertices inside targetFaces -> inner vertices
  const allVertsInTarget = new Set<string>();
  const interiorNormalAccum = new Map<string, Vec3>();
  for (const face of targetFaces) {
    const fn = mesh.computeFaceNormal(face);
    for (const vid of face.vertexIds) {
      allVertsInTarget.add(vid);
      interiorNormalAccum.set(
        vid,
        addVec(interiorNormalAccum.get(vid) ?? [0, 0, 0], fn),
      );
    }
  }

  const vertMap = new Map<string, string>();
  const internalEdgeIds = new Set<string>();

  for (const vid of allVertsInTarget) {
    const v = mesh.getVertex(vid);
    if (!v) continue;
    if (inwardAccum.has(vid)) {
      const avgInward = normVec(inwardAccum.get(vid)!);
      const avgNormal = normVec(normalAccum.get(vid)!);
      const avgLen =
        (edgeLenSum.get(vid) ?? 1) / Math.max(1, edgeLenCount.get(vid) ?? 1);
      const moveDist = avgLen * 0.5 * thickness;
      const newPos = addVec(
        addVec(v.position, scaleVec(avgInward, moveDist)),
        scaleVec(avgNormal, depth),
      );
      vertMap.set(vid, mesh.addVertex(newPos[0], newPos[1], newPos[2]).id);
    } else {
      const avgNormal = normVec(interiorNormalAccum.get(vid) ?? [0, 1, 0]);
      const newPos = addVec(v.position, scaleVec(avgNormal, depth));
      vertMap.set(vid, mesh.addVertex(newPos[0], newPos[1], newPos[2]).id);
    }
  }

  // Collect internal edges to remove
  for (const face of targetFaces) {
    const n = face.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const eid = mesh.findEdgeId(face.vertexIds[i], face.vertexIds[(i + 1) % n]);
      if (!eid) continue;
      if (mesh.getFacesForEdge(eid).every((fid) => targetFaceIds.has(fid))) {
        if ((edgeUseCount.get(canonicalEdgeKey(face.vertexIds[i], face.vertexIds[(i + 1) % n])) ?? 0) >= 2) {
          internalEdgeIds.add(eid);
        }
      }
    }
  }

  // Create border quads along boundaryHalfEdges
  for (const { a, b } of boundaryHalfEdges) {
    const ma = vertMap.get(a)!;
    const mb = vertMap.get(b)!;
    mesh.addFace([a, b, mb, ma]);
  }

  const newInnerSpecs = targetFaces.map((f) =>
    f.vertexIds.map((vid) => vertMap.get(vid)!),
  );

  mesh.deleteFaces(targetFaceIds);
  if (internalEdgeIds.size > 0) {
    mesh.deleteEdges(internalEdgeIds);
  }
  mesh.pruneOrphanVertices(allVertsInTarget);

  for (const verts of newInnerSpecs) {
    const nf = mesh.addFace(verts);
    if (nf) nextSelected.add(nf.id);
  }

  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * C. SUBDIVIDE — SUBDIVIDIR (Aristas y Caras)
 * ========================================================================== */
export function subdivideMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  params: SubdivideParams,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();
  const cuts = Math.max(1, Math.min(6, Math.round(params.cuts)));
  const smoothness = Math.max(0, Math.min(1, params.smoothness));
  const fractal = Math.max(0, Math.min(0.5, params.fractal));

  if (selectedIds.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  // 1. Collect edges to subdivide
  const edgeIdsToSubdivide = new Set<string>();
  if (mode === 'edge') {
    for (const eid of selectedIds) {
      if (mesh.getEdge(eid)) edgeIdsToSubdivide.add(eid);
    }
  } else if (mode === 'face') {
    for (const fid of selectedIds) {
      for (const eid of mesh.getEdgesForFace(fid)) {
        edgeIdsToSubdivide.add(eid);
      }
    }
  } else {
    for (const edge of mesh.edges) {
      if (selectedIds.has(edge.v0) && selectedIds.has(edge.v1)) {
        edgeIdsToSubdivide.add(edge.id);
      }
    }
  }

  if (edgeIdsToSubdivide.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  // Precompute vertex normals for smoothing/fractal
  const vNormals = new Map<string, Vec3>();
  for (const v of mesh.vertices) {
    vNormals.set(v.id, mesh.computeVertexNormal(v.id));
  }

  // 2. Create split vertices along each subdivided edge (keyed by canonicalEdgeKey)
  // Ordered from minId -> maxId
  const edgeSplits = new Map<string, string[]>();
  const createdVertIds: string[] = [];

  for (const eid of edgeIdsToSubdivide) {
    const edge = mesh.getEdge(eid);
    if (!edge) continue;
    const minId = edge.v0 < edge.v1 ? edge.v0 : edge.v1;
    const maxId = edge.v0 < edge.v1 ? edge.v1 : edge.v0;
    const va = mesh.getVertex(minId)!;
    const vb = mesh.getVertex(maxId)!;
    const na = vNormals.get(minId) ?? [0, 1, 0];
    const nb = vNormals.get(maxId) ?? [0, 1, 0];
    const edgeLen = lenVec(subVec(vb.position, va.position));

    const splitIds: string[] = [];
    for (let k = 1; k <= cuts; k++) {
      const t = k / (cuts + 1);
      let pos = lerpVec(va.position, vb.position, t);

      if (smoothness > 0) {
        const arc = 4 * t * (1 - t); // peaks at 1 at midpoint
        const avgN = normVec(addVec(na, nb));
        const bulged = scaleVec(avgN, smoothness * 0.22 * edgeLen * arc);
        pos = addVec(pos, bulged);
      }
      if (fractal > 0) {
        const avgN = normVec(addVec(na, nb));
        const jitter = deterministicJitter(`${minId}_${maxId}_${k}`);
        pos = addVec(pos, scaleVec(avgN, jitter * fractal * edgeLen * 0.35));
      }

      const nv = mesh.addVertex(pos[0], pos[1], pos[2]);
      splitIds.push(nv.id);
      createdVertIds.push(nv.id);
    }
    edgeSplits.set(canonicalEdgeKey(edge.v0, edge.v1), splitIds);
  }

  // Helper to get ordered chain [vStart, ...splits, vEnd]
  const getEdgeChain = (vStart: string, vEnd: string): string[] => {
    const splits = edgeSplits.get(canonicalEdgeKey(vStart, vEnd));
    if (!splits) return [vStart, vEnd];
    const ordered = vStart < vEnd ? splits : [...splits].reverse();
    return [vStart, ...ordered, vEnd];
  };

  // 3. Rebuild faces
  const oldFaces = [...mesh.faces];
  const facesToDelete = new Set<string>();
  const newFacesSpec: { verts: string[]; select: boolean }[] = [];

  for (const face of oldFaces) {
    const k = face.vertexIds.length;
    const edgeFlags: boolean[] = [];
    let subCount = 0;
    for (let i = 0; i < k; i++) {
      const key = canonicalEdgeKey(
        face.vertexIds[i],
        face.vertexIds[(i + 1) % k],
      );
      const isSub = edgeSplits.has(key);
      edgeFlags.push(isSub);
      if (isSub) subCount++;
    }

    if (subCount === 0) continue;
    facesToDelete.add(face.id);

    const isSelectedFace = mode === 'face' && selectedIds.has(face.id);

    // Case 1: Quad with all 4 edges subdivided -> (cuts+1) x (cuts+1) grid
    if (k === 4 && subCount === 4) {
      const [v0, v1, v2, v3] = face.vertexIds;
      const top = getEdgeChain(v0, v1); // len = cuts + 2
      const right = getEdgeChain(v1, v2);
      const bottom = getEdgeChain(v3, v2); // same direction v0->v1
      const left = getEdgeChain(v0, v3);
      const n = cuts + 2;

      const grid: string[][] = Array.from({ length: n }, () =>
        new Array<string>(n),
      );

      for (let j = 0; j < n; j++) {
        grid[0][j] = top[j];
        grid[n - 1][j] = bottom[j];
      }
      for (let i = 0; i < n; i++) {
        grid[i][0] = left[i];
        grid[i][n - 1] = right[i];
      }

      // Interior grid vertices via Coons bilinear blend
      const p00 = mesh.getVertex(v0)!.position;
      const p01 = mesh.getVertex(v1)!.position;
      const p11 = mesh.getVertex(v2)!.position;
      const p10 = mesh.getVertex(v3)!.position;

      for (let i = 1; i < n - 1; i++) {
        const u = i / (n - 1);
        for (let j = 1; j < n - 1; j++) {
          const v = j / (n - 1);
          const pTop = mesh.getVertex(top[j])!.position;
          const pBot = mesh.getVertex(bottom[j])!.position;
          const pLeft = mesh.getVertex(left[i])!.position;
          const pRight = mesh.getVertex(right[i])!.position;

          const lr = lerpVec(pLeft, pRight, v);
          const tb = lerpVec(pTop, pBot, u);
          const bilin = lerpVec(lerpVec(p00, p01, v), lerpVec(p10, p11, v), u);
          const pos = subVec(addVec(lr, tb), bilin);
          const nv = mesh.addVertex(pos[0], pos[1], pos[2]);
          grid[i][j] = nv.id;
          createdVertIds.push(nv.id);
        }
      }

      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1; j++) {
          newFacesSpec.push({
            verts: [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]],
            select: isSelectedFace || subCount === 4,
          });
        }
      }
      continue;
    }

    // Case 2: Quad with 2 opposite edges subdivided -> cuts+1 quad strips
    if (
      k === 4 &&
      subCount === 2 &&
      ((edgeFlags[0] && edgeFlags[2]) || (edgeFlags[1] && edgeFlags[3]))
    ) {
      const [v0, v1, v2, v3] = face.vertexIds;
      if (edgeFlags[0] && edgeFlags[2]) {
        const top = getEdgeChain(v0, v1);
        const bot = getEdgeChain(v3, v2);
        for (let j = 0; j < top.length - 1; j++) {
          newFacesSpec.push({
            verts: [top[j], top[j + 1], bot[j + 1], bot[j]],
            select: isSelectedFace,
          });
        }
      } else {
        const left = getEdgeChain(v0, v3);
        const right = getEdgeChain(v1, v2);
        for (let i = 0; i < left.length - 1; i++) {
          newFacesSpec.push({
            verts: [left[i], right[i], right[i + 1], left[i + 1]],
            select: isSelectedFace,
          });
        }
      }
      continue;
    }

    // Case 3: Triangle with all 3 edges subdivided
    if (k === 3 && subCount === 3) {
      const [v0, v1, v2] = face.vertexIds;
      const e01 = getEdgeChain(v0, v1);
      const e02 = getEdgeChain(v0, v2);
      const e12 = getEdgeChain(v1, v2);
      const n = cuts + 2; // rows 0..n-1

      const rows: string[][] = [];
      for (let r = 0; r < n; r++) {
        const row: string[] = new Array(r + 1);
        row[0] = e02[r];
        row[r] = e01[r];
        if (r === n - 1) {
          for (let c = 0; c <= r; c++) row[c] = e12[r - c];
          // Ensure row[0] = v2 and row[r] = v1
          row[0] = v2;
          row[r] = v1;
          const e21 = getEdgeChain(v2, v1);
          for (let c = 0; c <= r; c++) row[c] = e21[c];
        } else if (r > 1) {
          const pLeft = mesh.getVertex(row[0])!.position;
          const pRight = mesh.getVertex(row[r])!.position;
          for (let c = 1; c < r; c++) {
            const p = lerpVec(pLeft, pRight, c / r);
            const nv = mesh.addVertex(p[0], p[1], p[2]);
            row[c] = nv.id;
            createdVertIds.push(nv.id);
          }
        }
        rows.push(row);
      }

      for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c <= r; c++) {
          // Downward-pointing in (r,c) -> CCW matches [v0, v1, v2]
          newFacesSpec.push({
            verts: [rows[r][c], rows[r + 1][c + 1], rows[r + 1][c]],
            select: isSelectedFace || subCount === 3,
          });
          if (c < r) {
            newFacesSpec.push({
              verts: [rows[r][c], rows[r][c + 1], rows[r + 1][c + 1]],
              select: isSelectedFace || subCount === 3,
            });
          }
        }
      }
      continue;
    }

    // Case 4: N-gon with all edges subdivided -> center fan
    if (k >= 5 && subCount === k) {
      const centerPos = mesh.computeFaceCenter(face);
      const centerVert = mesh.addVertex(centerPos[0], centerPos[1], centerPos[2]);
      createdVertIds.push(centerVert.id);

      const perimeter: string[] = [];
      for (let i = 0; i < k; i++) {
        const chain = getEdgeChain(
          face.vertexIds[i],
          face.vertexIds[(i + 1) % k],
        );
        for (let j = 0; j < chain.length - 1; j++) {
          perimeter.push(chain[j]);
        }
      }

      const pLen = perimeter.length;
      for (let i = 0; i < pLen; i++) {
        newFacesSpec.push({
          verts: [perimeter[i], perimeter[(i + 1) % pLen], centerVert.id],
          select: isSelectedFace,
        });
      }
      continue;
    }

    // Case 5: Partial edge subdivision -> splice split vertices into polygon (no T-junctions)
    const expanded: string[] = [];
    for (let i = 0; i < k; i++) {
      const chain = getEdgeChain(
        face.vertexIds[i],
        face.vertexIds[(i + 1) % k],
      );
      for (let j = 0; j < chain.length - 1; j++) {
        expanded.push(chain[j]);
      }
    }
    newFacesSpec.push({ verts: expanded, select: isSelectedFace });
  }

  // 4. Delete original faces & subdivided edges, insert sub-edges for loose edges (like Circle) & new faces
  mesh.deleteFaces(facesToDelete);

  const looseEdgesToKeep: [string, string][] = [];
  for (const eid of edgeIdsToSubdivide) {
    const edge = mesh.getEdge(eid);
    if (!edge) continue;
    const chain = getEdgeChain(edge.v0, edge.v1);
    for (let i = 0; i < chain.length - 1; i++) {
      looseEdgesToKeep.push([chain[i], chain[i + 1]]);
    }
  }
  mesh.deleteEdges(edgeIdsToSubdivide);

  for (const [a, b] of looseEdgesToKeep) {
    const ne = mesh.addEdge(a, b);
    if (ne && mode === 'edge') nextSelected.add(ne.id);
  }

  for (const spec of newFacesSpec) {
    const nf = mesh.addFace(spec.verts);
    if (nf && mode === 'face' && spec.select) {
      nextSelected.add(nf.id);
    }
  }

  if (mode === 'vertex') {
    for (const vid of createdVertIds) nextSelected.add(vid);
  }

  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * D. BEVEL — BISELAR (Aristas y Vértices)
 * ========================================================================== */
function evalProfileOffset(t: number, profile: number): number {
  // t in [0, 1] across bevel corner; returns radial bulge weight in [0, 1]
  // profile = 0.5 -> linear chamfer (0 bulge)
  // profile > 0.5 -> convex round
  // profile < 0.5 -> concave
  const arc = 4 * t * (1 - t); // 0 at ends, 1 at center
  return (profile - 0.5) * 0.7 * arc;
}

export function bevelMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  params: BevelParams,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();
  const width = Math.max(0.01, Math.min(1.5, params.width));
  const segments = Math.max(1, Math.min(5, Math.round(params.segments)));
  const profile = Math.max(0.1, Math.min(1.0, params.profile));

  if (selectedIds.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  // VERTEX BEVEL
  if (mode === 'vertex') {
    const targetVertIds = Array.from(selectedIds).filter((id) =>
      Boolean(mesh.getVertex(id)),
    );
    for (const vid of targetVertIds) {
      const centerVert = mesh.getVertex(vid);
      if (!centerVert) continue;
      const origPos = [...centerVert.position] as Vec3;
      const incEdgeIds = mesh.getEdgesForVertex(vid);
      if (incEdgeIds.length < 2) continue;

      // For each neighbor u along an incident edge, create a beveled rail vertex
      const neighborToNewVert = new Map<string, string>();
      for (const eid of incEdgeIds) {
        const edge = mesh.getEdge(eid);
        if (!edge) continue;
        const neighborId = edge.v0 === vid ? edge.v1 : edge.v0;
        const nv = mesh.getVertex(neighborId);
        if (!nv) continue;
        const diff = subVec(nv.position, origPos);
        const edgeLen = lenVec(diff);
        if (edgeLen < 1e-6) continue;
        const d = params.clampOverlap
          ? Math.min(width, edgeLen * 0.45)
          : Math.min(width, edgeLen * 0.9);
        const pos = addVec(origPos, scaleVec(normVec(diff), d));
        const created = mesh.addVertex(pos[0], pos[1], pos[2]);
        neighborToNewVert.set(neighborId, created.id);
      }

      // Update incident faces by replacing vid with [prevNew, nextNew]
      const incFaceIds = mesh.getFacesForVertex(vid);
      const cornerLinks = new Map<string, string>(); // prevNew -> nextNew (in face order, reversed for cap)
      const facesToReplace: { oldId: string; verts: string[] }[] = [];

      for (const fid of incFaceIds) {
        const face = mesh.getFace(fid);
        if (!face) continue;
        const idx = face.vertexIds.indexOf(vid);
        if (idx === -1) continue;
        const k = face.vertexIds.length;
        const prevId = face.vertexIds[(idx - 1 + k) % k];
        const nextId = face.vertexIds[(idx + 1) % k];
        const pPrev = neighborToNewVert.get(prevId);
        const pNext = neighborToNewVert.get(nextId);
        if (!pPrev || !pNext) continue;

        const updatedVerts = [
          ...face.vertexIds.slice(0, idx),
          pPrev,
          pNext,
          ...face.vertexIds.slice(idx + 1),
        ];
        facesToReplace.push({ oldId: fid, verts: updatedVerts });
        // For outward cap face, edge direction is opposite to adjacent face edge pPrev -> pNext
        cornerLinks.set(pNext, pPrev);
      }

      const oldFaceSet = new Set(facesToReplace.map((f) => f.oldId));
      mesh.deleteFaces(oldFaceSet);
      for (const f of facesToReplace) {
        mesh.addFace(f.verts);
      }

      // Build cap polygon around vid by walking cornerLinks
      if (cornerLinks.size >= 3) {
        const orderedCap: string[] = [];
        const start = cornerLinks.keys().next().value as string;
        let curr: string | undefined = start;
        const visited = new Set<string>();
        while (curr && !visited.has(curr) && orderedCap.length <= cornerLinks.size) {
          visited.add(curr);
          orderedCap.push(curr);
          curr = cornerLinks.get(curr);
        }

        if (orderedCap.length >= 3) {
          if (segments === 1) {
            const cap = mesh.addFace(orderedCap);
            if (cap) nextSelected.add(cap.id);
          } else {
            // Multi-segment radial bevel dome toward origPos
            const rings: string[][] = [orderedCap];
            for (let s = 1; s < segments; s++) {
              const t = s / segments;
              const ring: string[] = [];
              for (const rv of orderedCap) {
                const p = mesh.getVertex(rv)!.position;
                const bulge = evalProfileOffset(t * 0.5, profile);
                const interp = lerpVec(p, origPos, t * (1 - bulge));
                ring.push(mesh.addVertex(interp[0], interp[1], interp[2]).id);
              }
              rings.push(ring);
            }
            const centerTop = lerpVec(
              mesh.computeCentroid(orderedCap) ?? origPos,
              origPos,
              Math.max(0, profile - 0.15),
            );
            const apex = mesh.addVertex(centerTop[0], centerTop[1], centerTop[2]).id;

            for (let r = 0; r < rings.length - 1; r++) {
              const outer = rings[r];
              const inner = rings[r + 1];
              for (let i = 0; i < outer.length; i++) {
                const ni = (i + 1) % outer.length;
                mesh.addFace([outer[i], outer[ni], inner[ni], inner[i]]);
              }
            }
            const lastRing = rings[rings.length - 1];
            for (let i = 0; i < lastRing.length; i++) {
              const ni = (i + 1) % lastRing.length;
              mesh.addFace([lastRing[i], lastRing[ni], apex]);
            }
            nextSelected.add(apex);
          }
        }
      }

      mesh.deleteVertices(new Set([vid]));
    }

    return { mesh, nextSelectedIds: nextSelected };
  }

  // EDGE BEVEL (also supports Face mode by beveling boundary/all edges of selected faces)
  const bevelEdgeIds = new Set<string>();
  if (mode === 'edge') {
    for (const eid of selectedIds) {
      if (mesh.getEdge(eid)) bevelEdgeIds.add(eid);
    }
  } else if (mode === 'face') {
    for (const fid of selectedIds) {
      for (const eid of mesh.getEdgesForFace(fid)) {
        bevelEdgeIds.add(eid);
      }
    }
  }

  if (bevelEdgeIds.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  const bevelEdgeKeys = new Set<string>();
  const touchedVertices = new Set<string>();
  for (const eid of bevelEdgeIds) {
    const e = mesh.getEdge(eid);
    if (!e) continue;
    bevelEdgeKeys.add(canonicalEdgeKey(e.v0, e.v1));
    touchedVertices.add(e.v0);
    touchedVertices.add(e.v1);
  }

  // Compute safe bevel distance per edge
  const edgeOffsetDist = new Map<string, number>();
  for (const eid of bevelEdgeIds) {
    const e = mesh.getEdge(eid);
    if (!e) continue;
    edgeOffsetDist.set(eid, width);
  }

  // For each touched vertex v, compute corner positions inside each face incident to v
  // Key: `${vid}::${faceId}` -> vertex ID
  const cornerVertexMap = new Map<string, string>();
  // Also cache split point on each NON-beveled edge touching v so adjacent non-beveled faces share the same split vertex!
  // Key: `${vid}::edge::${nonBevelEdgeId}` -> vertex ID
  const nonBevelEdgeSplitMap = new Map<string, string>();

  const getOrCreateNonBevelSplit = (vid: string, eid: string): string => {
    const mapKey = `${vid}::edge::${eid}`;
    const existing = nonBevelEdgeSplitMap.get(mapKey);
    if (existing) return existing;
    const edge = mesh.getEdge(eid)!;
    const vPos = mesh.getVertex(vid)!.position;
    const otherId = edge.v0 === vid ? edge.v1 : edge.v0;
    const otherPos = mesh.getVertex(otherId)!.position;
    const diff = subVec(otherPos, vPos);
    const elen = lenVec(diff);
    const d = params.clampOverlap
      ? Math.min(width, elen * 0.45)
      : Math.min(width, elen * 0.85);
    const pos = addVec(vPos, scaleVec(normVec(diff), d));
    const nv = mesh.addVertex(pos[0], pos[1], pos[2]);
    nonBevelEdgeSplitMap.set(mapKey, nv.id);
    return nv.id;
  };

  // For every face touching a touched vertex, compute its corner replacement vertex sequence
  const faceReplacements = new Map<string, string[]>();
  const facesToDelete = new Set<string>();
  const cornerTrianglesToBuild: {
    vid: string;
    vertIds: string[];
  }[] = [];

  for (const face of mesh.faces) {
    const k = face.vertexIds.length;
    let touchesBevel = false;
    for (const vid of face.vertexIds) {
      if (touchedVertices.has(vid)) {
        touchesBevel = true;
        break;
      }
    }
    if (!touchesBevel) continue;

    facesToDelete.add(face.id);
    const newVerts: string[] = [];

    for (let i = 0; i < k; i++) {
      const vid = face.vertexIds[i];
      if (!touchedVertices.has(vid)) {
        newVerts.push(vid);
        continue;
      }

      const prevId = face.vertexIds[(i - 1 + k) % k];
      const nextId = face.vertexIds[(i + 1) % k];
      const eInId = mesh.findEdgeId(prevId, vid);
      const eOutId = mesh.findEdgeId(vid, nextId);
      const inBeveled = eInId ? bevelEdgeKeys.has(canonicalEdgeKey(prevId, vid)) : false;
      const outBeveled = eOutId ? bevelEdgeKeys.has(canonicalEdgeKey(vid, nextId)) : false;

      if (inBeveled && outBeveled) {
        // Both edges of this face at vid are beveled -> create 1 interior offset corner vertex
        const vPos = mesh.getVertex(vid)!.position;
        const pPrev = mesh.getVertex(prevId)!.position;
        const pNext = mesh.getVertex(nextId)!.position;
        const d1 = normVec(subVec(pPrev, vPos));
        const d2 = normVec(subVec(pNext, vPos));
        const len1 = lenVec(subVec(pPrev, vPos));
        const len2 = lenVec(subVec(pNext, vPos));

        const cosA = Math.max(-0.95, Math.min(0.95, dotVec(d1, d2)));
        const sinHalf = Math.sqrt(Math.max(0.05, (1 - cosA) / 2));
        const bisector = normVec(addVec(d1, d2), d1);
        const maxMove = params.clampOverlap
          ? Math.min(len1, len2) * 0.45
          : Math.min(len1, len2) * 0.85;
        const moveDist = Math.min(maxMove, width / sinHalf);
        const pos = addVec(vPos, scaleVec(bisector, moveDist));
        const cornerV = mesh.addVertex(pos[0], pos[1], pos[2]);
        cornerVertexMap.set(`${vid}::${face.id}`, cornerV.id);
        newVerts.push(cornerV.id);
      } else if (inBeveled && !outBeveled && eOutId) {
        // Slide along outgoing non-beveled edge
        const splitV = getOrCreateNonBevelSplit(vid, eOutId);
        cornerVertexMap.set(`${vid}::${face.id}`, splitV);
        newVerts.push(splitV);
      } else if (!inBeveled && outBeveled && eInId) {
        // Slide along incoming non-beveled edge
        const splitV = getOrCreateNonBevelSplit(vid, eInId);
        cornerVertexMap.set(`${vid}::${face.id}`, splitV);
        newVerts.push(splitV);
      } else if (eInId && eOutId) {
        // Neither eIn nor eOut is beveled, yet vid has a beveled edge elsewhere!
        // Replace vid with the two split points along eIn and eOut
        const splitIn = getOrCreateNonBevelSplit(vid, eInId);
        const splitOut = getOrCreateNonBevelSplit(vid, eOutId);
        if (splitIn !== splitOut) {
          newVerts.push(splitIn, splitOut);
        } else {
          newVerts.push(splitIn);
        }
      } else {
        newVerts.push(vid);
      }
    }

    faceReplacements.set(face.id, newVerts);
  }

  // Track edges touching touchedVertices that had faces before, to prune dead old edges afterward
  const candidateOldEdgesHadFaces = new Set<string>();
  for (const vid of touchedVertices) {
    for (const eid of mesh.getEdgesForVertex(vid)) {
      if (mesh.getFacesForEdge(eid).length > 0) {
        candidateOldEdgesHadFaces.add(eid);
      }
    }
  }

  // Create bevel strips along each beveled edge (with optional segments + profile)
  const bevelFaceSpecs: string[][] = [];
  // Map `${vid}` -> list of directed rail chains [rail0, rail1, ..., railSegments] around beveled edges
  const vertexCornerChains = new Map<string, string[][]>();

  for (const eid of bevelEdgeIds) {
    const edge = mesh.getEdge(eid);
    if (!edge) continue;
    const adjFaces = mesh.getFacesForEdge(eid);
    if (adjFaces.length !== 2) continue;

    // Identify fForward (traverses v0 -> v1) and fBackward (traverses v1 -> v0)
    let fForward: MeshFace | null = null;
    let fBackward: MeshFace | null = null;
    for (const fid of adjFaces) {
      const f = mesh.getFace(fid);
      if (!f) continue;
      const idx = f.vertexIds.indexOf(edge.v0);
      if (idx !== -1) {
        const nextV = f.vertexIds[(idx + 1) % f.vertexIds.length];
        if (nextV === edge.v1) fForward = f;
        else fBackward = f;
      }
    }
    if (!fForward || !fBackward) continue;

    const uF = cornerVertexMap.get(`${edge.v0}::${fForward.id}`);
    const vF = cornerVertexMap.get(`${edge.v1}::${fForward.id}`);
    const uB = cornerVertexMap.get(`${edge.v0}::${fBackward.id}`);
    const vB = cornerVertexMap.get(`${edge.v1}::${fBackward.id}`);
    if (!uF || !vF || !uB || !vB) continue;

    let railsU: string[];
    let railsV: string[];

    if (segments === 1) {
      railsU = [uB, uF];
      railsV = [vB, vF];
      bevelFaceSpecs.push([uB, vB, vF, uF]);
    } else {
      const origU = mesh.getVertex(edge.v0)!.position;
      const origV = mesh.getVertex(edge.v1)!.position;
      const pUF = mesh.getVertex(uF)!.position;
      const pUB = mesh.getVertex(uB)!.position;
      const pVF = mesh.getVertex(vF)!.position;
      const pVB = mesh.getVertex(vB)!.position;

      const uMidPush = subVec(origU, lerpVec(pUB, pUF, 0.5));
      const vMidPush = subVec(origV, lerpVec(pVB, pVF, 0.5));

      railsU = [uB];
      railsV = [vB];

      for (let s = 1; s < segments; s++) {
        const t = s / segments;
        const bulge = evalProfileOffset(t, profile) * 1.4;
        const posU = addVec(lerpVec(pUB, pUF, t), scaleVec(uMidPush, bulge));
        const posV = addVec(lerpVec(pVB, pVF, t), scaleVec(vMidPush, bulge));
        railsU.push(mesh.addVertex(posU[0], posU[1], posU[2]).id);
        railsV.push(mesh.addVertex(posV[0], posV[1], posV[2]).id);
      }
      railsU.push(uF);
      railsV.push(vF);

      for (let s = 0; s < segments; s++) {
        bevelFaceSpecs.push([railsU[s], railsV[s], railsV[s + 1], railsU[s + 1]]);
      }
    }

    if (uF !== uB) {
      if (!vertexCornerChains.has(edge.v0)) vertexCornerChains.set(edge.v0, []);
      // Around v0, bevel strip runs uF -> ... -> uB on the corner side
      vertexCornerChains.get(edge.v0)!.push([...railsU].reverse());
    }
    if (vF !== vB) {
      if (!vertexCornerChains.has(edge.v1)) vertexCornerChains.set(edge.v1, []);
      vertexCornerChains.get(edge.v1)!.push([...railsV]);
    }
  }

  // Build corner cap polygons where >= 3 beveled rails meet at a vertex
  for (const [vid, chains] of vertexCornerChains.entries()) {
    if (chains.length < 3) continue;
    const byStart = new Map<string, string[]>();
    for (const ch of chains) {
      byStart.set(ch[0], ch);
    }
    const orderedPerimeter: string[] = [];
    let currChain: string[] | undefined = chains[0];
    const startVert = chains[0][0];
    const visitedStarts = new Set<string>();

    while (currChain && !visitedStarts.has(currChain[0])) {
      visitedStarts.add(currChain[0]);
      for (let i = 0; i < currChain.length - 1; i++) {
        orderedPerimeter.push(currChain[i]);
      }
      const nextStart = currChain[currChain.length - 1];
      if (nextStart === startVert) break;
      currChain = byStart.get(nextStart);
    }

    if (orderedPerimeter.length >= 3) {
      // Reverse so normal points outward
      const outwardLoop = orderedPerimeter.reverse();
      if (segments === 1) {
        cornerTrianglesToBuild.push({ vid, vertIds: outwardLoop });
      } else {
        const origVPos = mesh.getVertex(vid)?.position ?? [0, 0, 0];
        const loopCenter = mesh.computeCentroid(outwardLoop) ?? origVPos;
        const centerPos = lerpVec(
          loopCenter,
          origVPos,
          Math.max(0, Math.min(0.95, profile * 0.85)),
        );
        const centerV = mesh.addVertex(centerPos[0], centerPos[1], centerPos[2]);
        const plen = outwardLoop.length;
        for (let i = 0; i < plen; i++) {
          cornerTrianglesToBuild.push({
            vid,
            vertIds: [outwardLoop[i], outwardLoop[(i + 1) % plen], centerV.id],
          });
        }
      }
    }
  }

  // Apply face deletions and additions
  mesh.deleteFaces(facesToDelete);
  mesh.deleteEdges(bevelEdgeIds);

  for (const verts of faceReplacements.values()) {
    if (verts.length >= 3) {
      mesh.addFace(verts);
    }
  }

  for (const verts of bevelFaceSpecs) {
    const nf = mesh.addFace(verts);
    if (nf && mode === 'face') nextSelected.add(nf.id);
    if (nf && mode === 'edge') {
      for (const eid of mesh.getEdgesForFace(nf.id)) nextSelected.add(eid);
    }
  }

  for (const corner of cornerTrianglesToBuild) {
    const nf = mesh.addFace(corner.vertIds);
    if (nf && mode === 'face') nextSelected.add(nf.id);
  }

  // Clean up old incident edges that lost all their faces due to vertex splitting
  const deadOldEdges = new Set<string>();
  for (const eid of candidateOldEdgesHadFaces) {
    if (mesh.getEdge(eid) && mesh.getFacesForEdge(eid).length === 0) {
      deadOldEdges.add(eid);
    }
  }
  if (deadOldEdges.size > 0) {
    mesh.deleteEdges(deadOldEdges);
  }
  mesh.pruneOrphanVertices(touchedVertices);

  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * E. LOOP CUT — CORTE DE BUCLE (Detección + Previsualización + Corte)
 * ========================================================================== */
function getOppositeEdgeInQuad(
  mesh: EditableMesh,
  face: MeshFace,
  edgeId: string,
): {
  a0: string;
  b0: string;
  a1: string;
  b1: string;
  oppositeEdgeId: string | undefined;
} | null {
  if (face.vertexIds.length !== 4) return null;
  const edge = mesh.getEdge(edgeId);
  if (!edge) return null;
  const [v0, v1, v2, v3] = face.vertexIds;
  const pairs: [string, string, string, string][] = [
    [v0, v1, v3, v2],
    [v1, v2, v0, v3],
    [v2, v3, v1, v0],
    [v3, v0, v2, v1],
  ];
  for (const [p0, p1, q0, q1] of pairs) {
    if (canonicalEdgeKey(p0, p1) === canonicalEdgeKey(edge.v0, edge.v1)) {
      return {
        a0: p0,
        b0: p1,
        a1: q0,
        b1: q1,
        oppositeEdgeId: mesh.findEdgeId(q0, q1),
      };
    }
  }
  return null;
}

export function findEdgeLoopRing(
  mesh: EditableMesh,
  startEdgeId: string,
): EdgeLoopRing | null {
  const startEdge = mesh.getEdge(startEdgeId);
  if (!startEdge) return null;

  const adjFaces = mesh.getFacesForEdge(startEdgeId);
  if (adjFaces.length === 0) return null;

  const walkDirection = (initialFaceId: string, startEdgeParam: string) => {
    const steps: EdgeLoopRing['quadSteps'] = [];
    const edges: string[] = [];
    const visitedFaces = new Set<string>();
    let currFaceId: string | undefined = initialFaceId;
    let currEdgeId: string | undefined = startEdgeParam;

    while (currFaceId && currEdgeId && !visitedFaces.has(currFaceId)) {
      const face = mesh.getFace(currFaceId);
      if (!face || face.vertexIds.length !== 4) break;
      const opp = getOppositeEdgeInQuad(mesh, face, currEdgeId);
      if (!opp || !opp.oppositeEdgeId) break;

      visitedFaces.add(currFaceId);
      steps.push({
        faceId: currFaceId,
        a0: opp.a0,
        b0: opp.b0,
        a1: opp.a1,
        b1: opp.b1,
      });
      edges.push(opp.oppositeEdgeId);

      if (opp.oppositeEdgeId === startEdgeId) {
        return { steps, edges, closed: true };
      }

      const nextAdj = mesh.getFacesForEdge(opp.oppositeEdgeId);
      const nextFace = nextAdj.find((fid) => fid !== currFaceId);
      currFaceId = nextFace;
      currEdgeId = opp.oppositeEdgeId;
    }
    return { steps, edges, closed: false };
  };

  // Walk in first direction
  const dir1 = walkDirection(adjFaces[0], startEdgeId);
  if (dir1.closed && dir1.steps.length > 0) {
    return {
      edgeIds: [startEdgeId, ...dir1.edges.slice(0, -1)],
      faceIds: dir1.steps.map((s) => s.faceId),
      quadSteps: dir1.steps,
      isClosed: true,
    };
  }

  // Open loop: walk opposite direction from adjFaces[1] if present
  const dir2 =
    adjFaces.length > 1
      ? walkDirection(adjFaces[1], startEdgeId)
      : { steps: [], edges: [], closed: false };

  const backwardSteps = [...dir2.steps].reverse().map((s) => ({
    faceId: s.faceId,
    a0: s.a1,
    b0: s.b1,
    a1: s.a0,
    b1: s.b0,
  }));
  const backwardEdges = [...dir2.edges].reverse();

  const allSteps = [...backwardSteps, ...dir1.steps];
  const allEdges = [...backwardEdges, startEdgeId, ...dir1.edges];

  if (allSteps.length === 0) return null;

  return {
    edgeIds: allEdges,
    faceIds: allSteps.map((s) => s.faceId),
    quadSteps: allSteps,
    isClosed: false,
  };
}

export function findFirstValidLoopEdge(
  mesh: EditableMesh,
  preferredEdgeIds?: Iterable<string>,
): string | null {
  if (preferredEdgeIds) {
    for (const eid of preferredEdgeIds) {
      const ring = findEdgeLoopRing(mesh, eid);
      if (ring && ring.quadSteps.length > 0) return eid;
    }
  }
  for (const edge of mesh.edges) {
    const ring = findEdgeLoopRing(mesh, edge.id);
    if (ring && ring.quadSteps.length > 0) return edge.id;
  }
  return null;
}

export function computeLoopCutPreviewSegments(
  mesh: EditableMesh,
  ring: EdgeLoopRing,
  cuts: number,
  slide: number,
): [Vec3, Vec3][] {
  const segments: [Vec3, Vec3][] = [];
  const count = Math.max(1, Math.min(8, Math.round(cuts)));
  const clampedSlide = Math.max(-0.9, Math.min(0.9, slide));

  for (let c = 1; c <= count; c++) {
    const baseT = c / (count + 1);
    const t =
      count === 1
        ? 0.5 + clampedSlide * 0.45
        : Math.max(0.04, Math.min(0.96, baseT + clampedSlide * (0.45 / count)));

    for (const step of ring.quadSteps) {
      const pa0 = mesh.getVertex(step.a0)?.position;
      const pb0 = mesh.getVertex(step.b0)?.position;
      const pa1 = mesh.getVertex(step.a1)?.position;
      const pb1 = mesh.getVertex(step.b1)?.position;
      if (!pa0 || !pb0 || !pa1 || !pb1) continue;

      const pStart = lerpVec(pa0, pb0, t);
      const pEnd = lerpVec(pa1, pb1, t);
      segments.push([pStart, pEnd]);
    }
  }
  return segments;
}

export function loopCutMesh(
  sourceMesh: EditableMesh,
  params: LoopCutParams,
): { result: MeshOperatorResult; error?: string } {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();

  if (!params.edgeId) {
    return {
      result: { mesh, nextSelectedIds: nextSelected },
      error: 'No se encontró un recorrido de aristas cuadrangular válido en esta malla.',
    };
  }

  const ring = findEdgeLoopRing(mesh, params.edgeId);
  if (!ring || ring.quadSteps.length === 0) {
    return {
      result: { mesh, nextSelectedIds: nextSelected },
      error: 'La arista seleccionada no pertenece a un bucle de caras cuadrangulares compatible.',
    };
  }

  const count = Math.max(1, Math.min(8, Math.round(params.cuts)));
  const clampedSlide = Math.max(-0.9, Math.min(0.9, params.slide));

  // Build ordered split vertices along each directed edge (a -> b) of each quadStep
  // Key: canonicalEdgeKey -> ordered list of new vertex IDs from minId -> maxId
  const splitMap = new Map<string, string[]>();

  const ensureSplitForDirectedEdge = (u: string, v: string): string[] => {
    const key = canonicalEdgeKey(u, v);
    const existing = splitMap.get(key);
    if (existing) {
      return existing;
    }
    const pu = mesh.getVertex(u)!.position;
    const pv = mesh.getVertex(v)!.position;
    const ids: string[] = [];
    for (let c = 1; c <= count; c++) {
      const baseT = c / (count + 1);
      const t =
        count === 1
          ? 0.5 + clampedSlide * 0.45
          : Math.max(0.04, Math.min(0.96, baseT + clampedSlide * (0.45 / count)));
      const pos = lerpVec(pu, pv, t);
      ids.push(mesh.addVertex(pos[0], pos[1], pos[2]).id);
    }
    splitMap.set(key, ids);
    return ids;
  };

  // Orient every split consistently with step.a0 -> step.b0!
  const stepPairs: {
    startChain: string[];
    endChain: string[];
  }[] = [];

  for (let i = 0; i < ring.quadSteps.length; i++) {
    const step = ring.quadSteps[i];
    let sSplits = splitMap.get(canonicalEdgeKey(step.a0, step.b0));
    if (!sSplits) {
      sSplits = ensureSplitForDirectedEdge(step.a0, step.b0);
    } else {
      // Align orientation to step.a0 -> step.b0 if created in reverse
      const pFirst = mesh.getVertex(sSplits[0])!.position;
      const pA0 = mesh.getVertex(step.a0)!.position;
      const pB0 = mesh.getVertex(step.b0)!.position;
      if (lenVec(subVec(pFirst, pB0)) < lenVec(subVec(pFirst, pA0))) {
        sSplits = [...sSplits].reverse();
      }
    }

    let eSplits = splitMap.get(canonicalEdgeKey(step.a1, step.b1));
    if (!eSplits) {
      eSplits = ensureSplitForDirectedEdge(step.a1, step.b1);
    } else {
      const pFirst = mesh.getVertex(eSplits[0])!.position;
      const pA1 = mesh.getVertex(step.a1)!.position;
      const pB1 = mesh.getVertex(step.b1)!.position;
      if (lenVec(subVec(pFirst, pB1)) < lenVec(subVec(pFirst, pA1))) {
        eSplits = [...eSplits].reverse();
      }
    }

    stepPairs.push({
      startChain: [step.a0, ...sSplits, step.b0],
      endChain: [step.a1, ...eSplits, step.b1],
    });
  }

  const facesToDelete = new Set(ring.faceIds);
  const edgesToDelete = new Set(ring.edgeIds);

  // Also check if any NON-ring face shares one of the split edges (only possible on open boundary? No, boundary has 1 face, non-quad adjacent face has 1!)
  const splitExtraFaces: { oldId: string; verts: string[] }[] = [];
  for (const face of mesh.faces) {
    if (facesToDelete.has(face.id)) continue;
    const k = face.vertexIds.length;
    let touches = false;
    for (let i = 0; i < k; i++) {
      if (splitMap.has(canonicalEdgeKey(face.vertexIds[i], face.vertexIds[(i + 1) % k]))) {
        touches = true;
        break;
      }
    }
    if (!touches) continue;
    facesToDelete.add(face.id);
    const expanded: string[] = [];
    for (let i = 0; i < k; i++) {
      const va = face.vertexIds[i];
      const vb = face.vertexIds[(i + 1) % k];
      expanded.push(va);
      const splits = splitMap.get(canonicalEdgeKey(va, vb));
      if (splits) {
        const pFirst = mesh.getVertex(splits[0])!.position;
        const pA = mesh.getVertex(va)!.position;
        const pB = mesh.getVertex(vb)!.position;
        const ordered =
          lenVec(subVec(pFirst, pA)) <= lenVec(subVec(pFirst, pB))
            ? splits
            : [...splits].reverse();
        expanded.push(...ordered);
      }
    }
    splitExtraFaces.push({ oldId: face.id, verts: expanded });
  }

  mesh.deleteFaces(facesToDelete);
  mesh.deleteEdges(edgesToDelete);

  for (const extra of splitExtraFaces) {
    mesh.addFace(extra.verts);
  }

  for (const pair of stepPairs) {
    const m = pair.startChain.length;
    for (let j = 0; j < m - 1; j++) {
      // Original quad had [a0, b0, b1, a1]
      mesh.addFace([
        pair.startChain[j],
        pair.startChain[j + 1],
        pair.endChain[j + 1],
        pair.endChain[j],
      ]);
      if (j > 0) {
        const cutEdgeId = mesh.findEdgeId(pair.startChain[j], pair.endChain[j]);
        if (cutEdgeId) nextSelected.add(cutEdgeId);
      }
    }
  }

  return { result: { mesh, nextSelectedIds: nextSelected } };
}

/* ============================================================================
 * F. MERGE — FUSIONAR VÉRTICES
 * ========================================================================== */
export function mergeVerticesMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  params: MergeParams,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();

  const orderedVertIds: string[] = [];
  if (mode === 'vertex') {
    for (const vid of selectedIds) {
      if (mesh.getVertex(vid)) orderedVertIds.push(vid);
    }
  } else {
    const vertSet = mesh.getVertexIdsFromSelection(mode, selectedIds);
    for (const vid of vertSet) orderedVertIds.push(vid);
  }

  if (orderedVertIds.length < 2) {
    if (orderedVertIds.length === 1) nextSelected.add(orderedVertIds[0]);
    return { mesh, nextSelectedIds: nextSelected };
  }

  const mergeSet = new Set(orderedVertIds);
  let keepId = orderedVertIds[0];
  let targetPos: Vec3 = mesh.computeCentroid(orderedVertIds) ?? [0, 0, 0];

  if (params.mode === 'first') {
    keepId = orderedVertIds[0];
    targetPos = [...mesh.getVertex(keepId)!.position];
  } else if (params.mode === 'last') {
    keepId = orderedVertIds[orderedVertIds.length - 1];
    targetPos = [...mesh.getVertex(keepId)!.position];
  } else if (params.mode === 'cursor' && params.cursorPosition) {
    targetPos = [...params.cursorPosition];
  }

  const keepVert = mesh.getVertex(keepId)!;
  keepVert.position = [targetPos[0], targetPos[1], targetPos[2]];

  // Remap edges
  for (const edge of mesh.edges) {
    if (mergeSet.has(edge.v0)) edge.v0 = keepId;
    if (mergeSet.has(edge.v1)) edge.v1 = keepId;
  }

  // Remap faces and collapse consecutive duplicates
  const nextFaces: MeshFace[] = [];
  for (const face of mesh.faces) {
    const remapped = face.vertexIds.map((vid) =>
      mergeSet.has(vid) ? keepId : vid,
    );
    const collapsed: string[] = [];
    for (const vid of remapped) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== vid) {
        collapsed.push(vid);
      }
    }
    if (collapsed.length > 1 && collapsed[0] === collapsed[collapsed.length - 1]) {
      collapsed.pop();
    }
    // Also ensure keepId doesn't create a bow-tie pinch inside the same face
    const uniqueCount = new Set(collapsed).size;
    if (collapsed.length >= 3 && uniqueCount >= 3) {
      face.vertexIds = collapsed;
      nextFaces.push(face);
    }
  }
  mesh.faces = nextFaces;

  // Remove merged vertices except keepId
  mesh.vertices = mesh.vertices.filter(
    (v) => v.id === keepId || !mergeSet.has(v.id),
  );
  mesh.rebuildIndices();

  if (mode === 'vertex') {
    nextSelected.add(keepId);
  }
  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * G. DELETE & DISSOLVE — MENÚ CONTEXTUAL DE ELIMINACIÓN
 * ========================================================================== */
function dissolveSingleEdgeInPlace(mesh: EditableMesh, edgeId: string): boolean {
  const edge = mesh.getEdge(edgeId);
  if (!edge) return false;
  const adjFaces = mesh.getFacesForEdge(edgeId);

  if (adjFaces.length === 0) {
    mesh.deleteEdges(new Set([edgeId]));
    return true;
  }

  if (adjFaces.length !== 2 || adjFaces[0] === adjFaces[1]) {
    return false;
  }

  const f1 = mesh.getFace(adjFaces[0]);
  const f2 = mesh.getFace(adjFaces[1]);
  if (!f1 || !f2) return false;

  // Find directed edge (u -> v) in f1, and (v -> u) in f2
  const n1 = f1.vertexIds.length;
  let idx1 = -1;
  let u = '';
  let v = '';
  for (let i = 0; i < n1; i++) {
    const a = f1.vertexIds[i];
    const b = f1.vertexIds[(i + 1) % n1];
    if (canonicalEdgeKey(a, b) === canonicalEdgeKey(edge.v0, edge.v1)) {
      idx1 = i;
      u = a;
      v = b;
      break;
    }
  }
  if (idx1 === -1) return false;

  const n2 = f2.vertexIds.length;
  let idx2 = -1;
  let f2Reversed = false;
  for (let i = 0; i < n2; i++) {
    const a = f2.vertexIds[i];
    const b = f2.vertexIds[(i + 1) % n2];
    if (a === v && b === u) {
      idx2 = i;
      f2Reversed = false;
      break;
    }
    if (a === u && b === v) {
      idx2 = i;
      f2Reversed = true;
      break;
    }
  }
  if (idx2 === -1) return false;

  const f2Ordered = f2Reversed ? [...f2.vertexIds].reverse() : f2.vertexIds;
  const startInF2 = f2Ordered.indexOf(v);

  // Build merged polygon: walk f1 from v .. u (n1 vertices), then f2 from after u .. before v (n2 - 2 vertices)
  const merged: string[] = [];
  for (let step = 0; step < n1; step++) {
    merged.push(f1.vertexIds[(idx1 + 1 + step) % n1]);
  }
  for (let step = 2; step < n2; step++) {
    merged.push(f2Ordered[(startInF2 + step) % n2]);
  }

  if (merged.length < 3 || new Set(merged).size < 3) return false;

  mesh.deleteFaces(new Set([f1.id, f2.id]));
  mesh.deleteEdges(new Set([edgeId]));
  mesh.addFace(merged);
  return true;
}

export function applyDeleteAction(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
  action: DeleteActionType,
): MeshOperatorResult {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();

  if (selectedIds.size === 0) {
    return { mesh, nextSelectedIds: nextSelected };
  }

  switch (action) {
    case 'delete_vertices': {
      mesh.deleteVertices(selectedIds);
      break;
    }
    case 'dissolve_vertices': {
      for (const vid of Array.from(selectedIds)) {
        if (!mesh.getVertex(vid)) continue;
        const incEdges = mesh.getEdgesForVertex(vid);
        const incFaces = mesh.getFacesForVertex(vid);
        if (incEdges.length === 2 && incFaces.length === 0) {
          const eA = mesh.getEdge(incEdges[0]);
          const eB = mesh.getEdge(incEdges[1]);
          if (eA && eB) {
            const nA = eA.v0 === vid ? eA.v1 : eA.v0;
            const nB = eB.v0 === vid ? eB.v1 : eB.v0;
            mesh.deleteVertices(new Set([vid]));
            mesh.addEdge(nA, nB);
          }
        } else if (incFaces.length === 1) {
          const f = mesh.getFace(incFaces[0]);
          if (f) {
            const filtered = f.vertexIds.filter((id) => id !== vid);
            mesh.deleteFaces(new Set([f.id]));
            mesh.deleteVertices(new Set([vid]));
            if (filtered.length >= 3) mesh.addFace(filtered);
          }
        } else if (incFaces.length >= 2) {
          // Merge the star of faces around vid into one polygon by chaining next -> ... -> prev
          const chains: {
            faceId: string;
            start: string;
            end: string;
            verts: string[];
          }[] = [];
          for (const fid of incFaces) {
            const f = mesh.getFace(fid);
            if (!f) continue;
            const idx = f.vertexIds.indexOf(vid);
            if (idx === -1) continue;
            const k = f.vertexIds.length;
            const verts: string[] = [];
            for (let s = 1; s < k; s++) {
              verts.push(f.vertexIds[(idx + s) % k]);
            }
            if (verts.length >= 2) {
              chains.push({
                faceId: fid,
                start: verts[0],
                end: verts[verts.length - 1],
                verts,
              });
            }
          }

          if (chains.length === incFaces.length) {
            const used = new Set<string>([chains[0].faceId]);
            const merged: string[] = [...chains[0].verts];
            let currEnd = chains[0].end;
            let closed = false;

            for (let iter = 0; iter < chains.length; iter++) {
              // Match next chain whose start === currEnd (same winding) or end === currEnd (reversed winding)
              let matched = chains.find(
                (c) => !used.has(c.faceId) && c.start === currEnd,
              );
              let sliceVerts: string[] | null = null;
              if (matched) {
                sliceVerts = matched.verts.slice(1);
              } else {
                matched = chains.find(
                  (c) => !used.has(c.faceId) && c.end === currEnd,
                );
                if (matched) {
                  sliceVerts = [...matched.verts].reverse().slice(1);
                }
              }
              if (!matched || !sliceVerts) break;
              used.add(matched.faceId);
              merged.push(...sliceVerts);
              currEnd = merged[merged.length - 1];
              if (currEnd === merged[0] && used.size === chains.length) {
                merged.pop();
                closed = true;
                break;
              }
            }

            if (closed && merged.length >= 3 && new Set(merged).size >= 3) {
              mesh.deleteFaces(new Set(incFaces));
              mesh.deleteVertices(new Set([vid]));
              mesh.addFace(merged);
            } else {
              // Open boundary fan fallback: strip vid from individual faces
              const toDelete = new Set<string>(incFaces);
              const toAdd: string[][] = [];
              for (const fid of incFaces) {
                const f = mesh.getFace(fid);
                if (!f) continue;
                const filtered = f.vertexIds.filter((id) => id !== vid);
                if (filtered.length >= 3) toAdd.push(filtered);
              }
              mesh.deleteFaces(toDelete);
              mesh.deleteVertices(new Set([vid]));
              for (const verts of toAdd) mesh.addFace(verts);
            }
          }
        } else {
          mesh.deleteVertices(new Set([vid]));
        }
      }
      break;
    }
    case 'delete_edges': {
      mesh.deleteEdges(selectedIds);
      break;
    }
    case 'delete_edges_and_vertices': {
      const candidateVerts = mesh.getVertexIdsFromSelection('edge', selectedIds);
      mesh.deleteEdges(selectedIds);
      mesh.pruneOrphanVertices(candidateVerts);
      break;
    }
    case 'dissolve_edges': {
      for (const eid of Array.from(selectedIds)) {
        dissolveSingleEdgeInPlace(mesh, eid);
      }
      break;
    }
    case 'delete_only_faces': {
      mesh.deleteFaces(selectedIds);
      break;
    }
    case 'delete_faces_and_edges': {
      const candidateEdges = new Set<string>();
      const candidateVerts = mesh.getVertexIdsFromSelection('face', selectedIds);
      for (const fid of selectedIds) {
        for (const eid of mesh.getEdgesForFace(fid)) candidateEdges.add(eid);
      }
      mesh.deleteFaces(selectedIds);
      const orphanEdges = new Set<string>();
      for (const eid of candidateEdges) {
        if (mesh.getFacesForEdge(eid).length === 0) orphanEdges.add(eid);
      }
      mesh.deleteEdges(orphanEdges);
      mesh.pruneOrphanVertices(candidateVerts);
      break;
    }
    case 'dissolve_faces': {
      // Find internal edges shared by 2 selected faces and dissolve them
      const faceSet = new Set(selectedIds);
      const internalEdges: string[] = [];
      for (const edge of mesh.edges) {
        const adj = mesh.getFacesForEdge(edge.id);
        if (adj.length === 2 && faceSet.has(adj[0]) && faceSet.has(adj[1])) {
          internalEdges.push(edge.id);
        }
      }
      for (const eid of internalEdges) {
        dissolveSingleEdgeInPlace(mesh, eid);
      }
      break;
    }
  }

  // Keep mode-clean empty selection after deletion
  if (mode === 'vertex' || mode === 'edge' || mode === 'face') {
    return { mesh, nextSelectedIds: nextSelected };
  }
  return { mesh, nextSelectedIds: nextSelected };
}

/* ============================================================================
 * H. FILL — RELLENAR (Crear Arista o Cara a partir de selección)
 * ========================================================================== */
export function fillMesh(
  sourceMesh: EditableMesh,
  mode: EditSelectionMode,
  selectedIds: Set<string>,
): { result: MeshOperatorResult; message?: string } {
  const mesh = sourceMesh.clone();
  const nextSelected = new Set<string>();

  if (selectedIds.size === 0) {
    return {
      result: { mesh, nextSelectedIds: nextSelected },
      message: 'Selecciona al menos 2 vértices o aristas para rellenar',
    };
  }

  const vertIdsSet = mesh.getVertexIdsFromSelection(mode, selectedIds);
  const vertIds = Array.from(vertIdsSet);

  if (vertIds.length < 2) {
    return {
      result: { mesh, nextSelectedIds: nextSelected },
      message: 'Selecciona al menos 2 vértices para crear una arista o cara',
    };
  }

  // Case 1: Exactly 2 vertices -> connect with an edge
  if (vertIds.length === 2) {
    const existing = mesh.findEdgeId(vertIds[0], vertIds[1]);
    if (existing) {
      return {
        result: { mesh, nextSelectedIds: new Set(selectedIds) },
        message: 'Ya existe una arista entre los dos vértices',
      };
    }
    const edge = mesh.addEdge(vertIds[0], vertIds[1]);
    if (edge && mode === 'edge') nextSelected.add(edge.id);
    else if (mode === 'vertex') {
      nextSelected.add(vertIds[0]);
      nextSelected.add(vertIds[1]);
    }
    return { result: { mesh, nextSelectedIds: nextSelected } };
  }

  // Case 2: 3+ vertices -> build a cyclic loop and fill with a face
  // First try walking a single closed cycle along edges connecting vertIdsSet
  const adj = new Map<string, string[]>();
  for (const vid of vertIds) adj.set(vid, []);
  for (const edge of mesh.edges) {
    if (vertIdsSet.has(edge.v0) && vertIdsSet.has(edge.v1)) {
      adj.get(edge.v0)!.push(edge.v1);
      adj.get(edge.v1)!.push(edge.v0);
    }
  }

  let orderedLoop: string[] | null = null;
  const allDegreeTwo = vertIds.every((vid) => (adj.get(vid)?.length ?? 0) === 2);
  if (allDegreeTwo) {
    const walked: string[] = [];
    const visited = new Set<string>();
    let curr: string | undefined = vertIds[0];
    let prev: string | null = null;
    while (curr && !visited.has(curr)) {
      visited.add(curr);
      walked.push(curr);
      const neighbors: string[] = adj.get(curr) ?? [];
      const next: string | undefined = neighbors.find((n: string) => n !== prev);
      prev = curr;
      curr = next;
    }
    if (walked.length === vertIds.length) {
      orderedLoop = walked;
    }
  }

  // Fallback: project onto best-fit plane around centroid and sort angularly
  if (!orderedLoop) {
    const centroid = mesh.computeCentroid(vertIds) ?? [0, 0, 0];
    const pts = vertIds.map((vid) => mesh.getVertex(vid)!.position);
    // Estimate plane normal via average cross products around centroid
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = subVec(pts[i], centroid);
        const b = subVec(pts[j], centroid);
        const c = crossVec(a, b);
        if (dotVec(c, [nx, ny, nz]) < 0) {
          nx -= c[0];
          ny -= c[1];
          nz -= c[2];
        } else {
          nx += c[0];
          ny += c[1];
          nz += c[2];
        }
      }
    }
    const normal = normVec([nx, ny, nz], [0, 1, 0]);
    const ref: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normVec(crossVec(ref, normal), [1, 0, 0]);
    const v = normVec(crossVec(normal, u), [0, 0, 1]);

    orderedLoop = [...vertIds].sort((idA, idB) => {
      const dA = subVec(mesh.getVertex(idA)!.position, centroid);
      const dB = subVec(mesh.getVertex(idB)!.position, centroid);
      const angA = Math.atan2(dotVec(dA, v), dotVec(dA, u));
      const angB = Math.atan2(dotVec(dB, v), dotVec(dB, u));
      return angA - angB;
    });
  }

  // Prevent exact duplicate face
  const sortedTarget = [...orderedLoop].sort().join('|');
  const duplicateFace = mesh.faces.find(
    (f) =>
      f.vertexIds.length === orderedLoop!.length &&
      [...f.vertexIds].sort().join('|') === sortedTarget,
  );
  if (duplicateFace) {
    return {
      result: { mesh, nextSelectedIds: new Set(selectedIds) },
      message: 'Ya existe una cara con esos vértices',
    };
  }

  const face = mesh.addFace(orderedLoop);
  if (!face) {
    return {
      result: { mesh, nextSelectedIds: new Set(selectedIds) },
      message: 'No se pudo crear la cara',
    };
  }

  if (mode === 'face') {
    nextSelected.add(face.id);
  } else {
    for (const id of selectedIds) nextSelected.add(id);
  }

  return { result: { mesh, nextSelectedIds: nextSelected } };
}

/* ============================================================================
 * Register operators into extensible MeshOperatorRegistry
 * ========================================================================== */
meshOperatorRegistry.register({
  id: 'extrude',
  label: 'Extruir',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size > 0,
  execute: (ctx: MeshOperatorContext, params = {}) =>
    extrudeMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds, {
      distance: Number(params.distance ?? 0.5),
      axis: (params.axis as ExtrudeAxis) ?? 'normal',
      individual: Boolean(params.individual ?? false),
    }),
});

meshOperatorRegistry.register({
  id: 'inset',
  label: 'Insertar Caras',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size > 0,
  execute: (ctx: MeshOperatorContext, params = {}) =>
    insetFacesMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds, {
      thickness: Number(params.thickness ?? 0.25),
      depth: Number(params.depth ?? 0),
      individual: Boolean(params.individual ?? false),
    }),
});

meshOperatorRegistry.register({
  id: 'subdivide',
  label: 'Subdividir',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size > 0,
  execute: (ctx: MeshOperatorContext, params = {}) =>
    subdivideMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds, {
      cuts: Number(params.cuts ?? 1),
      smoothness: Number(params.smoothness ?? 0),
      fractal: Number(params.fractal ?? 0),
    }),
});

meshOperatorRegistry.register({
  id: 'bevel',
  label: 'Biselar',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size > 0,
  execute: (ctx: MeshOperatorContext, params = {}) =>
    bevelMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds, {
      width: Number(params.width ?? 0.2),
      segments: Number(params.segments ?? 1),
      profile: Number(params.profile ?? 0.5),
      clampOverlap: params.clampOverlap !== false,
    }),
});

meshOperatorRegistry.register({
  id: 'merge',
  label: 'Fusionar',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size >= 2,
  execute: (ctx: MeshOperatorContext, params = {}) =>
    mergeVerticesMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds, {
      mode: (params.mode as MergeMode) ?? 'center',
      cursorPosition: params.cursorPosition as Vec3 | undefined,
    }),
});

meshOperatorRegistry.register({
  id: 'fill',
  label: 'Rellenar',
  canExecute: (ctx: MeshOperatorContext) => ctx.selectedIds.size >= 2,
  execute: (ctx: MeshOperatorContext) =>
    fillMesh(ctx.mesh, ctx.selectionMode, ctx.selectedIds).result,
});
