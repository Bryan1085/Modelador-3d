import { EditableMesh } from './EditableMesh';

export type PrimitiveType = 'cube' | 'circle' | 'uv_sphere' | 'cylinder' | 'pyramid';

export interface PrimitiveOptions {
  size?: number;
  radius?: number;
  height?: number;
  segments?: number;
  rings?: number;
}

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  cube: 'Cubo',
  circle: 'Círculo',
  uv_sphere: 'Esfera UV',
  cylinder: 'Cilindro',
  pyramid: 'Pirámide',
};

/**
 * Cubo: 8 vértices, 12 aristas y 6 caras (quads).
 */
export function createCubeMesh(size = 2): EditableMesh {
  const mesh = new EditableMesh();
  const h = size / 2;

  const v0 = mesh.addVertex(-h, -h, h).id;  // 0: front-bottom-left
  const v1 = mesh.addVertex(h, -h, h).id;   // 1: front-bottom-right
  const v2 = mesh.addVertex(h, h, h).id;    // 2: front-top-right
  const v3 = mesh.addVertex(-h, h, h).id;   // 3: front-top-left
  const v4 = mesh.addVertex(-h, -h, -h).id; // 4: back-bottom-left
  const v5 = mesh.addVertex(h, -h, -h).id;  // 5: back-bottom-right
  const v6 = mesh.addVertex(h, h, -h).id;   // 6: back-top-right
  const v7 = mesh.addVertex(-h, h, -h).id;  // 7: back-top-left

  // Outward CCW winding
  mesh.addFace([v0, v1, v2, v3]); // Front (+Z)
  mesh.addFace([v5, v4, v7, v6]); // Back (-Z)
  mesh.addFace([v3, v2, v6, v7]); // Top (+Y)
  mesh.addFace([v4, v5, v1, v0]); // Bottom (-Y)
  mesh.addFace([v1, v5, v6, v2]); // Right (+X)
  mesh.addFace([v4, v0, v3, v7]); // Left (-X)

  return mesh;
}

/**
 * Círculo: 32 vértices conectados mediante 32 aristas, sin cara de relleno inicialmente.
 */
export function createCircleMesh(radius = 1, segments = 32): EditableMesh {
  const mesh = new EditableMesh();
  const count = Math.max(3, Math.min(128, Math.round(segments)));
  const vertIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    vertIds.push(mesh.addVertex(x, 0, z).id);
  }

  for (let i = 0; i < count; i++) {
    mesh.addEdge(vertIds[i], vertIds[(i + 1) % count]);
  }

  return mesh;
}

/**
 * Esfera UV: resolución configurable mediante segmentos y anillos.
 */
export function createUVSphereMesh(
  radius = 1,
  segments = 16,
  rings = 12,
): EditableMesh {
  const mesh = new EditableMesh();
  const segs = Math.max(3, Math.min(64, Math.round(segments)));
  const rngs = Math.max(3, Math.min(48, Math.round(rings)));

  const topPole = mesh.addVertex(0, radius, 0).id;
  const ringVerts: string[][] = [];

  for (let r = 1; r < rngs; r++) {
    const phi = (r / rngs) * Math.PI;
    const y = Math.cos(phi) * radius;
    const ringRadius = Math.sin(phi) * radius;
    const row: string[] = [];
    for (let s = 0; s < segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      const x = Math.cos(theta) * ringRadius;
      const z = -Math.sin(theta) * ringRadius;
      row.push(mesh.addVertex(x, y, z).id);
    }
    ringVerts.push(row);
  }

  const bottomPole = mesh.addVertex(0, -radius, 0).id;

  // Top cap triangles (CCW outward)
  const firstRing = ringVerts[0];
  for (let s = 0; s < segs; s++) {
    const nextS = (s + 1) % segs;
    mesh.addFace([topPole, firstRing[s], firstRing[nextS]]);
  }

  // Middle quad rings
  for (let r = 0; r < ringVerts.length - 1; r++) {
    const upper = ringVerts[r];
    const lower = ringVerts[r + 1];
    for (let s = 0; s < segs; s++) {
      const nextS = (s + 1) % segs;
      mesh.addFace([upper[s], lower[s], lower[nextS], upper[nextS]]);
    }
  }

  // Bottom cap triangles
  const lastRing = ringVerts[ringVerts.length - 1];
  for (let s = 0; s < segs; s++) {
    const nextS = (s + 1) % segs;
    mesh.addFace([bottomPole, lastRing[nextS], lastRing[s]]);
  }

  return mesh;
}

/**
 * Cilindro: resolución inicial de 16 segmentos.
 */
export function createCylinderMesh(
  radius = 1,
  height = 2,
  segments = 16,
): EditableMesh {
  const mesh = new EditableMesh();
  const segs = Math.max(3, Math.min(64, Math.round(segments)));
  const halfH = height / 2;

  const topRing: string[] = [];
  const bottomRing: string[] = [];

  for (let s = 0; s < segs; s++) {
    const theta = (s / segs) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = -Math.sin(theta) * radius;
    topRing.push(mesh.addVertex(x, halfH, z).id);
  }

  for (let s = 0; s < segs; s++) {
    const theta = (s / segs) * Math.PI * 2;
    const x = Math.cos(theta) * radius;
    const z = -Math.sin(theta) * radius;
    bottomRing.push(mesh.addVertex(x, -halfH, z).id);
  }

  // Side quads
  for (let s = 0; s < segs; s++) {
    const nextS = (s + 1) % segs;
    mesh.addFace([topRing[s], bottomRing[s], bottomRing[nextS], topRing[nextS]]);
  }

  // Top cap (+Y normal)
  mesh.addFace([...topRing]);

  // Bottom cap (-Y normal)
  mesh.addFace([...bottomRing].reverse());

  return mesh;
}

/**
 * Pirámide de base cuadrada: 5 vértices, 8 aristas y 5 caras (1 base cuadrada + 4 caras triangulares).
 */
export function createPyramidMesh(baseSize = 2, height = 2): EditableMesh {
  const mesh = new EditableMesh();
  const hBase = baseSize / 2;
  const hHeight = height / 2;

  const v0 = mesh.addVertex(-hBase, -hHeight, hBase).id;  // front-left
  const v1 = mesh.addVertex(hBase, -hHeight, hBase).id;   // front-right
  const v2 = mesh.addVertex(hBase, -hHeight, -hBase).id;  // back-right
  const v3 = mesh.addVertex(-hBase, -hHeight, -hBase).id; // back-left
  const apex = mesh.addVertex(0, hHeight, 0).id;

  // Base face (CCW looking from -Y)
  mesh.addFace([v3, v2, v1, v0]);

  // 4 triangular side faces
  mesh.addFace([v0, v1, apex]); // Front
  mesh.addFace([v1, v2, apex]); // Right
  mesh.addFace([v2, v3, apex]); // Back
  mesh.addFace([v3, v0, apex]); // Left

  return mesh;
}

export function createPrimitiveMesh(
  type: PrimitiveType,
  options: PrimitiveOptions = {},
): EditableMesh {
  switch (type) {
    case 'cube':
      return createCubeMesh(options.size ?? 2);
    case 'circle':
      return createCircleMesh(options.radius ?? 1, options.segments ?? 32);
    case 'uv_sphere':
      return createUVSphereMesh(
        options.radius ?? 1,
        options.segments ?? 16,
        options.rings ?? 12,
      );
    case 'cylinder':
      return createCylinderMesh(
        options.radius ?? 1,
        options.height ?? 2,
        options.segments ?? 16,
      );
    case 'pyramid':
      return createPyramidMesh(options.size ?? 2, options.height ?? 2);
  }
}
