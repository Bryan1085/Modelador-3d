import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EditableMesh, Vec3 } from '../core/mesh/EditableMesh';
import { EditSelectionMode, applyTransformToVertices } from '../core/mesh/operations';
import {
  AxisConstraint,
  CameraProjection,
  ModelerSettings,
  ObjectTransform,
  SceneObjectData,
  TouchModifierState,
  TransformTool,
  WorkMode,
} from '../core/project/types';
import { DEFAULT_TOUCH_SETTINGS } from '../core/project/storage';
import {
  EMPTY_MODIFIER_STATE,
  TouchGestureManager,
  TrackedPointer,
} from './TouchGestureManager';

export interface ViewportContextInfo {
  clientX: number;
  clientY: number;
  hitObjectId: string | null;
  hitComponentId: string | null;
}

export interface ViewportCallbacks {
  onSelectObject: (id: string | null) => void;
  onSelectComponent: (
    id: string | null,
    additive: boolean,
    addOnly?: boolean,
  ) => void;
  onPickLoopCutEdge: (edgeId: string | null) => void;
  onTwoFingerUndo: () => void;
  onThreeFingerRedo: () => void;
  onOpenContextMenu: (info: ViewportContextInfo) => void;
  onModifierStateChange?: (modifiers: TouchModifierState) => void;
  onLiveObjectTransform: (id: string, transform: ObjectTransform) => void;
  onCommitObjectTransform: (
    id: string,
    before: ObjectTransform,
    after: ObjectTransform,
  ) => void;
  onCommitMeshEdit: (
    id: string,
    before: EditableMesh,
    after: EditableMesh,
  ) => void;
}

interface ObjectVisual {
  id: string;
  objectType: SceneObjectData['objectType'];
  group: THREE.Group;
  solidMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  wireEdges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  refPlaneMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  refTexture: THREE.Texture | null;
  refImageSrc: string | null;
  triangleToFaceId: string[];
  faceToTriangleRange: Map<string, { start: number; count: number }>;
  editableMesh: EditableMesh;
  hasFaces: boolean;
  locked: boolean;
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _mat4A = new THREE.Matrix4();
const _mat4B = new THREE.Matrix4();
const _mat4C = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function createVertexDotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function distToSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) {
    return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

export class ViewportEngine {
  private container: HTMLElement;
  private callbacks: ViewportCallbacks;
  private isSoftwareGl: boolean;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthographicCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private projection: CameraProjection = 'perspective';

  private orbitControls: OrbitControls;
  private transformControls: TransformControls;
  private editGizmoAnchor: THREE.Object3D;

  private gridHelper: THREE.GridHelper;
  private axesGroup: THREE.Group;
  private shadowPlane: THREE.Mesh;

  private objectsGroup = new THREE.Group();
  private visuals = new Map<string, ObjectVisual>();

  // Edit mode overlays
  private editOverlayGroup = new THREE.Group();
  private editAllEdgesLine: THREE.LineSegments;
  private editSelectedEdgesLine: THREE.LineSegments;
  private editSelectedEdgeBars: THREE.InstancedMesh;
  private loopCutPreviewBars: THREE.InstancedMesh;
  private editSelectedFacesMesh: THREE.Mesh;
  private editUnselectedVerticesPoints: THREE.Points;
  private editSelectedVerticesPoints: THREE.Points;
  private vertexDotTexture: THREE.CanvasTexture;

  // State mirrors
  private selectedObjectId: string | null = null;
  private workMode: WorkMode = 'object';
  private editSelectionMode: EditSelectionMode = 'vertex';
  private selectedComponentIds = new Set<string>();
  private activeTool: TransformTool = 'move';
  private axisConstraint: AxisConstraint = 'free';
  private settings: ModelerSettings | null = null;
  private suppressGizmo = false;
  private loopCutPreviewMode = false;
  private loopCutPreviewSegments: [Vec3, Vec3][] = [];

  // Drag tracking
  private isGizmoDragging = false;
  private objectDragStartTransform: ObjectTransform | null = null;
  private editDragStartMesh: EditableMesh | null = null;
  private editDragStartVertexIds = new Set<string>();
  private editDragStartAnchorInv = new THREE.Matrix4();

  // Centralized Touch & Pointer Gesture Manager
  private gestureManager: TouchGestureManager;
  private suppressOrbitForContextPress = false;

  // Render loop / transition
  private frameId = 0;
  private renderBusy = false;
  private renderDirty = false;
  private cameraAnimTargetPos: THREE.Vector3 | null = null;
  private cameraAnimTargetLook: THREE.Vector3 | null = null;
  private lastAnimTime = 0;
  private disposed = false;

  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement, callbacks: ViewportCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const aspect = width / height;

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1d1f24);
    this.scene.fog = new THREE.FogExp2(0x1d1f24, 0.011);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Cameras
    this.perspectiveCamera = new THREE.PerspectiveCamera(45, aspect, 0.05, 500);
    this.perspectiveCamera.position.set(5.2, 4.0, 6.2);

    const frustum = 7;
    this.orthographicCamera = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      -100,
      500,
    );
    this.orthographicCamera.position.copy(this.perspectiveCamera.position);
    this.activeCamera = this.perspectiveCamera;

    // 3-Point Studio Lighting
    const hemi = new THREE.HemisphereLight(0xa6bddb, 0x262930, 0.8);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff5e8, 1.45);
    keyLight.position.set(7, 12, 8);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -10;
    keyLight.shadow.camera.right = 10;
    keyLight.shadow.camera.top = 10;
    keyLight.shadow.camera.bottom = -10;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 40;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xc2d4ff, 0.55);
    rimLight.position.set(-8, 6, -7);
    this.scene.add(rimLight);

    // Subtle ground shadow receiver
    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -0.004;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    // Reference Grid
    this.gridHelper = new THREE.GridHelper(32, 32, 0x3f444f, 0x2a2d35);
    this.gridHelper.position.y = 0;
    this.scene.add(this.gridHelper);

    // Colored X, Y, Z Axes
    this.axesGroup = this.createAxesGroup();
    this.scene.add(this.axesGroup);

    this.scene.add(this.objectsGroup);

    // Edit Mode Overlay Setup
    this.vertexDotTexture = createVertexDotTexture();

    this.editAllEdgesLine = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x111317,
        depthTest: true,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.editAllEdgesLine.renderOrder = 2;

    this.editSelectedEdgesLine = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xff9900,
        depthTest: false,
      }),
    );
    this.editSelectedEdgesLine.renderOrder = 4;

    const barGeo = new THREE.BoxGeometry(1, 1, 1);
    const barMat = new THREE.MeshBasicMaterial({
      color: 0xff9900,
      depthTest: false,
    });
    this.editSelectedEdgeBars = new THREE.InstancedMesh(barGeo, barMat, 1);
    this.editSelectedEdgeBars.count = 0;
    this.editSelectedEdgeBars.frustumCulled = false;
    this.editSelectedEdgeBars.renderOrder = 4;

    this.editSelectedFacesMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xff9900,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    this.editSelectedFacesMesh.renderOrder = 1;

    this.editUnselectedVerticesPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: 0x121418,
        size: 10,
        sizeAttenuation: false,
        map: this.vertexDotTexture,
        alphaTest: 0.45,
        depthTest: true,
      }),
    );
    this.editUnselectedVerticesPoints.renderOrder = 5;

    this.editSelectedVerticesPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: 0xff9900,
        size: 14,
        sizeAttenuation: false,
        map: this.vertexDotTexture,
        alphaTest: 0.45,
        depthTest: false,
      }),
    );
    this.editSelectedVerticesPoints.renderOrder = 6;

    const loopBarMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      depthTest: false,
    });
    this.loopCutPreviewBars = new THREE.InstancedMesh(barGeo, loopBarMat, 1);
    this.loopCutPreviewBars.count = 0;
    this.loopCutPreviewBars.frustumCulled = false;
    this.loopCutPreviewBars.renderOrder = 7;

    this.editOverlayGroup.add(
      this.editSelectedFacesMesh,
      this.editAllEdgesLine,
      this.editSelectedEdgesLine,
      this.editSelectedEdgeBars,
      this.loopCutPreviewBars,
      this.editUnselectedVerticesPoints,
      this.editSelectedVerticesPoints,
    );
    this.editOverlayGroup.visible = false;
    this.scene.add(this.editOverlayGroup);

    // Gizmo Anchor for Edit Mode
    this.editGizmoAnchor = new THREE.Object3D();
    this.scene.add(this.editGizmoAnchor);

    // OrbitControls (iPad Touch: 1 finger rotate, 2 fingers pinch/pan)
    this.orbitControls = new OrbitControls(this.activeCamera, this.renderer.domElement);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.rotateSpeed = 0.75;
    this.orbitControls.zoomSpeed = 0.9;
    this.orbitControls.panSpeed = 0.85;
    this.orbitControls.minDistance = 0.6;
    this.orbitControls.maxDistance = 120;
    this.orbitControls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    this.orbitControls.addEventListener('start', () => {
      this.cameraAnimTargetPos = null;
      this.cameraAnimTargetLook = null;
    });
    this.orbitControls.addEventListener('change', () => {
      this.requestRender();
    });

    // TransformControls Gizmo
    this.transformControls = new TransformControls(
      this.activeCamera,
      this.renderer.domElement,
    );
    this.transformControls.setSize(1.25);
    this.transformControls.getRaycaster().params.Line.threshold = 0.25;
    this.scene.add(this.transformControls.getHelper());

    this.transformControls.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean(event.value);
      this.isGizmoDragging = dragging;
      if (dragging) {
        this.gestureManager.invalidateCurrentGesture();
      }
      this.orbitControls.enabled = !dragging && !this.suppressOrbitForContextPress;
      if (dragging) {
        this.handleGizmoDragStart();
      } else {
        this.handleGizmoDragEnd();
      }
      this.requestRender();
    });

    this.transformControls.addEventListener('objectChange', () => {
      this.handleGizmoObjectChange();
      this.requestRender();
    });

    this.transformControls.addEventListener('change', () => {
      this.requestRender();
    });

    // Centralized Multi-Touch Pointer Gesture Manager on Canvas
    const dom = this.renderer.domElement;
    this.gestureManager = new TouchGestureManager(dom, DEFAULT_TOUCH_SETTINGS, {
      isGizmoBusy: () =>
        this.isGizmoDragging || this.transformControls.axis !== null,
      getWorkMode: () => this.workMode,
      hasLongPressTarget: (clientX, clientY, pointerType) =>
        this.workMode === 'object'
          ? this.hitTestObject(clientX, clientY, pointerType) !== null
          : this.hitTestEditComponent(clientX, clientY, pointerType) !== null,
      onSingleTap: (clientX, clientY, pointerType, modifiers) => {
        const keyboardShift =
          window.event instanceof MouseEvent && window.event.shiftKey;
        const shiftActive = modifiers.shift || keyboardShift;
        const additive =
          Boolean(this.settings?.multiSelectTouch) || shiftActive;
        this.performTapSelection(
          clientX,
          clientY,
          pointerType,
          additive,
          modifiers.shift,
        );
      },
      onTwoFingerTap: () => {
        if (!this.loopCutPreviewMode) {
          this.callbacks.onTwoFingerUndo();
        }
      },
      onThreeFingerTap: () => {
        if (!this.loopCutPreviewMode) {
          this.callbacks.onThreeFingerRedo();
        }
      },
      onLongPress: (clientX, clientY, pointerType) => {
        this.handleLongPressContext(clientX, clientY, pointerType);
      },
      onModifierStateChange: (modifiers) => {
        this.callbacks.onModifierStateChange?.(modifiers);
      },
      onTouchNavigationChange: (activePointers, modifiers) => {
        this.syncTouchNavigationFlags(activePointers, modifiers);
      },
    });
    dom.addEventListener('webglcontextlost', this.onContextLost);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.activeCamera);
    }

    this.requestRender();
  }

  private createAxesGroup(): THREE.Group {
    const group = new THREE.Group();
    const len = 16;

    const makeAxis = (dir: Vec3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-dir[0] * len, -dir[1] * len, -dir[2] * len),
        new THREE.Vector3(dir[0] * len, dir[1] * len, dir[2] * len),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.72,
      });
      return new THREE.Line(geo, mat);
    };

    group.add(makeAxis([1, 0, 0], 0xe05252)); // X Red
    group.add(makeAxis([0, 1, 0], 0x52b852)); // Y Green
    group.add(makeAxis([0, 0, 1], 0x4a8fe7)); // Z Blue
    return group;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
  };

  private syncTouchNavigationFlags(
    activePointers: ReadonlyMap<number, TrackedPointer>,
    modifiers: TouchModifierState = EMPTY_MODIFIER_STATE,
  ): void {
    if (modifiers.shift) {
      // Lock camera navigation while 1st finger holds touch SHIFT modifier
      this.orbitControls.enabled = false;
      this.orbitControls.enableRotate = false;
      return;
    }

    if (activePointers.size === 0) {
      this.suppressOrbitForContextPress = false;
      this.orbitControls.enabled = !this.isGizmoDragging;
      this.orbitControls.enableRotate = true;
      this.orbitControls.enableZoom = true;
      this.orbitControls.enablePan = true;
      return;
    }

    if (this.suppressOrbitForContextPress) {
      this.orbitControls.enabled = false;
      return;
    }

    const touchCfg = this.settings?.touch ?? DEFAULT_TOUCH_SETTINGS;
    const hasTouch = Array.from(activePointers.values()).some(
      (p) => p.pointerType === 'touch',
    );
    if (!hasTouch) {
      this.orbitControls.enabled = !this.isGizmoDragging;
      this.orbitControls.enableRotate = true;
      this.orbitControls.enableZoom = true;
      this.orbitControls.enablePan = true;
      return;
    }

    this.orbitControls.enableRotate = touchCfg.oneFingerOrbit;
    this.orbitControls.enableZoom = touchCfg.twoFingerPinchZoom;
    this.orbitControls.enablePan = touchCfg.twoFingerPan;
    this.orbitControls.enabled = !this.isGizmoDragging;
  }

  private handleLongPressContext(
    clientX: number,
    clientY: number,
    pointerType: string,
  ): void {
    if (this.loopCutPreviewMode) return;
    this.suppressOrbitForContextPress = true;
    this.orbitControls.enabled = false;

    if (this.workMode === 'object') {
      const hitObjectId = this.hitTestObject(clientX, clientY, pointerType);
      this.callbacks.onOpenContextMenu({
        clientX,
        clientY,
        hitObjectId,
        hitComponentId: null,
      });
    } else {
      const hitComponentId = this.hitTestEditComponent(
        clientX,
        clientY,
        pointerType,
      );
      this.callbacks.onOpenContextMenu({
        clientX,
        clientY,
        hitObjectId: this.selectedObjectId,
        hitComponentId,
      });
    }
  }

  private hitTestObject(
    clientX: number,
    clientY: number,
    pointerType: string,
  ): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);

    const solidTargets: THREE.Object3D[] = [];
    const wireTargets: THREE.Object3D[] = [];
    for (const visual of this.visuals.values()) {
      if (!visual.group.visible || visual.locked) continue;
      if (visual.objectType === 'reference_image' && visual.refPlaneMesh) {
        solidTargets.push(visual.refPlaneMesh);
      } else if (visual.hasFaces) {
        solidTargets.push(visual.solidMesh);
      } else {
        wireTargets.push(visual.wireEdges);
      }
    }

    const solidHits = this.raycaster.intersectObjects(solidTargets, false);
    this.raycaster.params.Line.threshold = pointerType === 'touch' ? 0.35 : 0.2;
    const wireHits = this.raycaster.intersectObjects(wireTargets, false);

    let bestHit: { id: string; distance: number } | null = null;
    if (solidHits.length > 0) {
      const id = solidHits[0].object.userData.objectId as string;
      bestHit = { id, distance: solidHits[0].distance };
    }
    if (wireHits.length > 0) {
      const id = wireHits[0].object.userData.objectId as string;
      if (!bestHit || wireHits[0].distance < bestHit.distance) {
        bestHit = { id, distance: wireHits[0].distance };
      }
    }
    return bestHit ? bestHit.id : null;
  }

  private hitTestEditComponent(
    clientX: number,
    clientY: number,
    pointerType: string,
  ): string | null {
    if (!this.selectedObjectId) return null;
    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const tapPxX = clientX - rect.left;
    const tapPxY = clientY - rect.top;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);

    if (!this.loopCutPreviewMode && this.editSelectionMode === 'face') {
      if (!visual.hasFaces) return null;
      const hits = this.raycaster.intersectObject(visual.solidMesh, false);
      if (hits.length > 0 && hits[0].faceIndex != null) {
        return visual.triangleToFaceId[hits[0].faceIndex] ?? null;
      }
      return null;
    }

    const xray = Boolean(this.settings?.xrayEditMode);
    const camPos = this.activeCamera.position;
    const hitRadius = pointerType === 'touch' ? 26 : 15;
    visual.group.updateMatrixWorld(true);

    const isOccluded = (worldPoint: THREE.Vector3): boolean => {
      if (xray || !visual.hasFaces) return false;
      const projected = _v2.copy(worldPoint).project(this.activeCamera);
      this.raycaster.setFromCamera(
        new THREE.Vector2(projected.x, projected.y),
        this.activeCamera,
      );
      const targetDist = this.raycaster.ray.origin.distanceTo(worldPoint);
      const hits = this.raycaster.intersectObject(visual.solidMesh, false);
      if (hits.length > 0 && hits[0].distance < targetDist - 0.06) {
        return true;
      }
      return false;
    };

    if (!this.loopCutPreviewMode && this.editSelectionMode === 'vertex') {
      let bestId: string | null = null;
      let bestScore = Infinity;

      for (const v of visual.editableMesh.vertices) {
        _v0
          .set(v.position[0], v.position[1], v.position[2])
          .applyMatrix4(visual.group.matrixWorld);
        const worldPos = _v0.clone();
        _v1.copy(worldPos).project(this.activeCamera);
        if (_v1.z < -1 || _v1.z > 1) continue;

        const sx = ((_v1.x + 1) / 2) * rect.width;
        const sy = ((-_v1.y + 1) / 2) * rect.height;
        const pxDist = Math.hypot(sx - tapPxX, sy - tapPxY);
        if (pxDist > hitRadius) continue;
        if (isOccluded(worldPos)) continue;

        const camDist = worldPos.distanceTo(camPos);
        const score = pxDist + camDist * 0.5;
        if (score < bestScore) {
          bestScore = score;
          bestId = v.id;
        }
      }
      return bestId;
    }

    if (this.loopCutPreviewMode || this.editSelectionMode === 'edge') {
      let bestId: string | null = null;
      let bestScore = Infinity;

      for (const edge of visual.editableMesh.edges) {
        const va = visual.editableMesh.getVertex(edge.v0);
        const vb = visual.editableMesh.getVertex(edge.v1);
        if (!va || !vb) continue;

        const wa = new THREE.Vector3(...va.position).applyMatrix4(
          visual.group.matrixWorld,
        );
        const wb = new THREE.Vector3(...vb.position).applyMatrix4(
          visual.group.matrixWorld,
        );

        const pa = wa.clone().project(this.activeCamera);
        const pb = wb.clone().project(this.activeCamera);
        if (pa.z > 1 && pb.z > 1) continue;

        const ax = ((pa.x + 1) / 2) * rect.width;
        const ay = ((-pa.y + 1) / 2) * rect.height;
        const bx = ((pb.x + 1) / 2) * rect.width;
        const by = ((-pb.y + 1) / 2) * rect.height;

        const { dist, t } = distToSegment2D(tapPxX, tapPxY, ax, ay, bx, by);
        if (dist > hitRadius) continue;

        const sampleWorld = wa.clone().lerp(wb, t);
        if (isOccluded(sampleWorld)) continue;

        const camDist = sampleWorld.distanceTo(camPos);
        const score = dist + camDist * 0.5;
        if (score < bestScore) {
          bestScore = score;
          bestId = edge.id;
        }
      }
      return bestId;
    }

    return null;
  }

  private performTapSelection(
    clientX: number,
    clientY: number,
    pointerType: string,
    additive: boolean,
    addOnly = false,
  ): void {
    if (this.workMode === 'object') {
      const hitId = this.hitTestObject(clientX, clientY, pointerType);
      this.callbacks.onSelectObject(hitId);
      return;
    }

    const hitCompId = this.hitTestEditComponent(clientX, clientY, pointerType);
    if (this.loopCutPreviewMode) {
      if (hitCompId) {
        this.callbacks.onPickLoopCutEdge(hitCompId);
      }
    } else {
      this.callbacks.onSelectComponent(hitCompId, additive, addOnly);
    }
  }

  private handleGizmoDragStart(): void {
    if (!this.selectedObjectId) return;
    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual) return;

    if (this.workMode === 'object') {
      const g = visual.group;
      this.objectDragStartTransform = {
        position: [g.position.x, g.position.y, g.position.z],
        rotation: [g.rotation.x, g.rotation.y, g.rotation.z],
        scale: [g.scale.x, g.scale.y, g.scale.z],
      };
    } else {
      this.editDragStartMesh = visual.editableMesh.clone();
      this.editDragStartVertexIds = visual.editableMesh.getVertexIdsFromSelection(
        this.editSelectionMode,
        this.selectedComponentIds,
      );
      this.editGizmoAnchor.updateMatrixWorld(true);
      this.editDragStartAnchorInv.copy(this.editGizmoAnchor.matrixWorld).invert();
    }
  }

  private handleGizmoObjectChange(): void {
    if (!this.isGizmoDragging || !this.selectedObjectId) return;
    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual) return;

    if (this.workMode === 'object') {
      const g = visual.group;
      this.callbacks.onLiveObjectTransform(this.selectedObjectId, {
        position: [g.position.x, g.position.y, g.position.z],
        rotation: [g.rotation.x, g.rotation.y, g.rotation.z],
        scale: [g.scale.x, g.scale.y, g.scale.z],
      });
    } else if (this.editDragStartMesh) {
      // Recompute editableMesh from dragStartMesh using delta matrix
      const nextMesh = this.editDragStartMesh.clone();
      this.editGizmoAnchor.updateMatrixWorld(true);
      visual.group.updateMatrixWorld(true);

      // deltaWorld = M_anchor_curr * M_anchor_start^-1
      _mat4A.multiplyMatrices(
        this.editGizmoAnchor.matrixWorld,
        this.editDragStartAnchorInv,
      );
      // deltaLocal = M_obj^-1 * deltaWorld * M_obj
      _mat4B.copy(visual.group.matrixWorld).invert();
      _mat4C.multiplyMatrices(_mat4B, _mat4A);
      _mat4C.multiply(visual.group.matrixWorld);

      applyTransformToVertices(nextMesh, this.editDragStartVertexIds, _mat4C, [0, 0, 0]);
      visual.editableMesh = nextMesh;
      this.rebuildObjectGeometry(visual);
      this.syncEditModeOverlays();
    }
  }

  private handleGizmoDragEnd(): void {
    if (!this.selectedObjectId) return;
    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual) return;

    if (this.workMode === 'object' && this.objectDragStartTransform) {
      const g = visual.group;
      const after: ObjectTransform = {
        position: [g.position.x, g.position.y, g.position.z],
        rotation: [g.rotation.x, g.rotation.y, g.rotation.z],
        scale: [g.scale.x, g.scale.y, g.scale.z],
      };
      this.callbacks.onCommitObjectTransform(
        this.selectedObjectId,
        this.objectDragStartTransform,
        after,
      );
      this.objectDragStartTransform = null;
    } else if (this.workMode === 'edit' && this.editDragStartMesh) {
      const before = this.editDragStartMesh;
      const after = visual.editableMesh.clone();
      this.editDragStartMesh = null;
      this.callbacks.onCommitMeshEdit(this.selectedObjectId, before, after);
      this.syncGizmoAttachment();
    }
  }

  public syncScene(params: {
    objects: SceneObjectData[];
    selectedObjectId: string | null;
    workMode: WorkMode;
    editSelectionMode: EditSelectionMode;
    selectedComponentIds: Set<string>;
    activeTool: TransformTool;
    axisConstraint: AxisConstraint;
    projection: CameraProjection;
    settings: ModelerSettings;
    meshRevision: number;
    suppressGizmo?: boolean;
    loopCutPreviewMode?: boolean;
    loopCutPreviewSegments?: [Vec3, Vec3][];
  }): void {
    this.selectedObjectId = params.selectedObjectId;
    this.workMode = params.workMode;
    this.editSelectionMode = params.editSelectionMode;
    this.selectedComponentIds = new Set(params.selectedComponentIds);
    this.activeTool = params.activeTool;
    this.axisConstraint = params.axisConstraint;
    this.settings = params.settings;
    this.gestureManager.updateConfig(params.settings.touch);
    this.gestureManager.syncWorkMode(params.workMode);
    this.suppressGizmo = Boolean(params.suppressGizmo);
    this.loopCutPreviewMode = Boolean(params.loopCutPreviewMode);
    this.loopCutPreviewSegments = params.loopCutPreviewSegments ?? [];

    // Grid & Axes visibility
    this.gridHelper.visible = params.settings.showGrid;
    this.axesGroup.visible = params.settings.showAxes;

    // Projection switching
    if (this.projection !== params.projection) {
      this.switchProjection(params.projection);
    }

    // Reconcile objects
    const seen = new Set<string>();
    for (const objData of params.objects) {
      seen.add(objData.id);
      let visual = this.visuals.get(objData.id);
      if (!visual) {
        visual = this.createObjectVisual(objData);
        this.visuals.set(objData.id, visual);
        this.objectsGroup.add(visual.group);
      }

      visual.group.visible = objData.visible;
      visual.locked = objData.locked;

      // Update transform unless currently dragging this object in Object Mode
      if (!(this.isGizmoDragging && this.workMode === 'object' && this.selectedObjectId === objData.id)) {
        visual.group.position.set(...objData.transform.position);
        visual.group.rotation.set(...objData.transform.rotation);
        visual.group.scale.set(...objData.transform.scale);
      }

      // Update mesh geometry or reference image properties
      if (objData.objectType === 'reference_image' && objData.referenceImage) {
        this.syncReferenceVisual(
          visual,
          objData,
          objData.id === params.selectedObjectId,
        );
      } else {
        if (!(this.isGizmoDragging && this.workMode === 'edit' && this.selectedObjectId === objData.id)) {
          const nextEditable = EditableMesh.fromJSON(objData.mesh);
          if (
            visual.group.userData.meshRevision !== params.meshRevision ||
            visual.editableMesh.vertices.length !== nextEditable.vertices.length ||
            visual.editableMesh.edges.length !== nextEditable.edges.length ||
            visual.editableMesh.faces.length !== nextEditable.faces.length
          ) {
            visual.editableMesh = nextEditable;
            this.rebuildObjectGeometry(visual);
            visual.group.userData.meshRevision = params.meshRevision;
          } else {
            // Always sync vertex positions on undo/redo or numeric edit
            visual.editableMesh = nextEditable;
            this.rebuildObjectGeometry(visual);
          }
        }

        // Object Mode selection highlight & Circle visibility
        const isSelected = objData.id === params.selectedObjectId;
        const inEditOnThis = isSelected && params.workMode === 'edit';

        if (inEditOnThis) {
          visual.solidMesh.material.color.set('#8f96a0');
          visual.wireEdges.visible = false; // Handled by editOverlayGroup
        } else {
          visual.solidMesh.material.color.set(
            isSelected ? '#a9b1bc' : objData.material.color,
          );
          visual.solidMesh.material.emissive.setHex(isSelected ? 0x241605 : 0x000000);
          if (!visual.hasFaces) {
            visual.wireEdges.visible = true;
            visual.wireEdges.material.color.setHex(isSelected ? 0xff9900 : 0xc0c6d0);
          } else {
            visual.wireEdges.visible = isSelected;
            visual.wireEdges.material.color.setHex(0xff9900);
          }
        }
      }
    }

    // Remove deleted visuals
    for (const [id, visual] of this.visuals.entries()) {
      if (!seen.has(id)) {
        this.objectsGroup.remove(visual.group);
        this.disposeObjectVisual(visual);
        this.visuals.delete(id);
      }
    }

    this.syncEditModeOverlays();
    this.syncGizmoSettings();
    if (!this.isGizmoDragging) {
      this.syncGizmoAttachment();
    }

    this.requestRender();
  }

  private disposeObjectVisual(visual: ObjectVisual): void {
    visual.solidMesh.geometry.dispose();
    visual.solidMesh.material.dispose();
    visual.wireEdges.geometry.dispose();
    visual.wireEdges.material.dispose();
    if (visual.refPlaneMesh) {
      visual.refPlaneMesh.geometry.dispose();
      visual.refPlaneMesh.material.dispose();
    }
    if (visual.refTexture) {
      visual.refTexture.dispose();
      visual.refTexture = null;
    }
  }

  private syncReferenceVisual(
    visual: ObjectVisual,
    objData: SceneObjectData,
    isSelected: boolean,
  ): void {
    const ref = objData.referenceImage;
    if (!ref || !visual.refPlaneMesh) return;

    const mat = visual.refPlaneMesh.material;
    mat.opacity = Math.max(0.05, Math.min(1, ref.opacity));
    const isFront = ref.depthMode === 'front';
    mat.depthTest = !isFront;
    visual.refPlaneMesh.renderOrder = isFront ? 10 : -1;

    visual.wireEdges.visible = true;
    visual.wireEdges.material.color.setHex(isSelected ? 0xff9900 : 0x525b6c);
    visual.wireEdges.material.depthTest = !isFront;
    visual.wireEdges.renderOrder = isFront ? 11 : 0;

    if (visual.refImageSrc !== ref.imageDataUrl) {
      visual.refImageSrc = ref.imageDataUrl;
      if (visual.refTexture) {
        visual.refTexture.dispose();
        visual.refTexture = null;
      }
      if (ref.imageDataUrl) {
        const loader = new THREE.TextureLoader();
        loader.load(
          ref.imageDataUrl,
          (tex) => {
            if (this.disposed) {
              tex.dispose();
              return;
            }
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            tex.needsUpdate = true;
            visual.refTexture = tex;
            if (visual.refPlaneMesh) {
              visual.refPlaneMesh.material.map = tex;
              visual.refPlaneMesh.material.needsUpdate = true;
            }
            this.requestRender();
          },
          undefined,
          () => {
            this.requestRender();
          },
        );
      }
    }
  }

  private createObjectVisual(objData: SceneObjectData): ObjectVisual {
    const group = new THREE.Group();
    group.userData.objectId = objData.id;

    if (objData.objectType === 'reference_image' && objData.referenceImage) {
      const ref = objData.referenceImage;
      const aspect =
        ref.aspectRatio > 0
          ? ref.aspectRatio
          : ref.naturalWidth / Math.max(1, ref.naturalHeight);
      const baseSize = 4;
      const width = aspect >= 1 ? baseSize : baseSize * aspect;
      const height = aspect >= 1 ? baseSize / Math.max(0.05, aspect) : baseSize;

      const planeGeo = new THREE.PlaneGeometry(width, height);
      const planeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: ref.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: ref.depthMode !== 'front',
      });
      const refPlaneMesh = new THREE.Mesh(planeGeo, planeMat);
      refPlaneMesh.userData.objectId = objData.id;
      refPlaneMesh.renderOrder = ref.depthMode === 'front' ? 10 : -1;

      const hw = width / 2;
      const hh = height / 2;
      const borderGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, -hh, 0),
        new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(hw, hh, 0),
        new THREE.Vector3(hw, hh, 0),
        new THREE.Vector3(-hw, hh, 0),
        new THREE.Vector3(-hw, hh, 0),
        new THREE.Vector3(-hw, -hh, 0),
      ]);
      const wireMat = new THREE.LineBasicMaterial({ color: 0x525b6c });
      const wireEdges = new THREE.LineSegments(borderGeo, wireMat);
      wireEdges.userData.objectId = objData.id;

      // Unused placeholder solidMesh so ObjectVisual contract stays uniform
      const dummySolid = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshStandardMaterial(),
      );
      dummySolid.visible = false;

      group.add(refPlaneMesh, wireEdges);

      const visual: ObjectVisual = {
        id: objData.id,
        objectType: 'reference_image',
        group,
        solidMesh: dummySolid,
        wireEdges,
        refPlaneMesh,
        refTexture: null,
        refImageSrc: null,
        triangleToFaceId: [],
        faceToTriangleRange: new Map(),
        editableMesh: new EditableMesh(),
        hasFaces: false,
        locked: objData.locked,
      };
      this.syncReferenceVisual(
        visual,
        objData,
        objData.id === this.selectedObjectId,
      );
      return visual;
    }

    const solidMat = new THREE.MeshStandardMaterial({
      color: objData.material.color,
      roughness: objData.material.roughness,
      metalness: objData.material.metalness,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const solidMesh = new THREE.Mesh(new THREE.BufferGeometry(), solidMat);
    solidMesh.castShadow = !this.isSoftwareGl;
    solidMesh.receiveShadow = true;
    solidMesh.userData.objectId = objData.id;

    const wireMat = new THREE.LineBasicMaterial({
      color: 0xff9900,
    });
    const wireEdges = new THREE.LineSegments(new THREE.BufferGeometry(), wireMat);
    wireEdges.userData.objectId = objData.id;

    group.add(solidMesh, wireEdges);

    const visual: ObjectVisual = {
      id: objData.id,
      objectType: objData.objectType,
      group,
      solidMesh,
      wireEdges,
      refPlaneMesh: null,
      refTexture: null,
      refImageSrc: null,
      triangleToFaceId: [],
      faceToTriangleRange: new Map(),
      editableMesh: EditableMesh.fromJSON(objData.mesh),
      hasFaces: objData.mesh.faces.length > 0,
      locked: objData.locked,
    };

    this.rebuildObjectGeometry(visual);
    return visual;
  }

  private rebuildObjectGeometry(visual: ObjectVisual): void {
    if (visual.objectType === 'reference_image') return;
    const mesh = visual.editableMesh;
    const triData = mesh.buildTriangulatedData();

    visual.hasFaces = triData.triangleToFaceId.length > 0;
    visual.triangleToFaceId = triData.triangleToFaceId;
    visual.faceToTriangleRange = triData.faceToTriangleRange;

    const solidGeo = new THREE.BufferGeometry();
    solidGeo.setAttribute('position', new THREE.BufferAttribute(triData.positions, 3));
    solidGeo.setAttribute('normal', new THREE.BufferAttribute(triData.normals, 3));
    if (triData.uvs) {
      solidGeo.setAttribute('uv', new THREE.BufferAttribute(triData.uvs, 2));
    }
    solidGeo.computeBoundingBox();
    solidGeo.computeBoundingSphere();

    visual.solidMesh.geometry.dispose();
    visual.solidMesh.geometry = solidGeo;
    visual.solidMesh.visible = visual.hasFaces;

    // Topological edges
    const edgePositions = new Float32Array(mesh.edges.length * 6);
    let ptr = 0;
    for (const edge of mesh.edges) {
      const v0 = mesh.getVertex(edge.v0);
      const v1 = mesh.getVertex(edge.v1);
      if (!v0 || !v1) continue;
      edgePositions[ptr++] = v0.position[0];
      edgePositions[ptr++] = v0.position[1];
      edgePositions[ptr++] = v0.position[2];
      edgePositions[ptr++] = v1.position[0];
      edgePositions[ptr++] = v1.position[1];
      edgePositions[ptr++] = v1.position[2];
    }

    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(edgePositions.subarray(0, ptr), 3),
    );
    wireGeo.computeBoundingSphere();
    visual.wireEdges.geometry.dispose();
    visual.wireEdges.geometry = wireGeo;
  }

  private syncEditModeOverlays(): void {
    if (this.workMode !== 'edit' || !this.selectedObjectId) {
      this.editOverlayGroup.visible = false;
      return;
    }

    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual) {
      this.editOverlayGroup.visible = false;
      return;
    }

    this.editOverlayGroup.visible = true;
    visual.group.updateMatrixWorld(true);
    this.editOverlayGroup.matrixAutoUpdate = false;
    this.editOverlayGroup.matrix.copy(visual.group.matrixWorld);
    this.editOverlayGroup.matrixWorld.copy(visual.group.matrixWorld);

    const mesh = visual.editableMesh;
    const xray = Boolean(this.settings?.xrayEditMode);

    // 1. All Edges
    (this.editAllEdgesLine.material as THREE.LineBasicMaterial).depthTest = !xray;
    this.editAllEdgesLine.geometry.dispose();
    this.editAllEdgesLine.geometry = visual.wireEdges.geometry.clone();

    // 2. Selected Edges
    const selEdgeCoords: number[] = [];
    const selEdgePairs: { a: Vec3; b: Vec3 }[] = [];
    if (this.editSelectionMode === 'edge') {
      for (const eid of this.selectedComponentIds) {
        const edge = mesh.getEdge(eid);
        if (!edge) continue;
        const v0 = mesh.getVertex(edge.v0);
        const v1 = mesh.getVertex(edge.v1);
        if (!v0 || !v1) continue;
        selEdgeCoords.push(...v0.position, ...v1.position);
        selEdgePairs.push({ a: v0.position, b: v1.position });
      }
    }
    const selEdgeGeo = new THREE.BufferGeometry();
    selEdgeGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(selEdgeCoords, 3),
    );
    this.editSelectedEdgesLine.geometry.dispose();
    this.editSelectedEdgesLine.geometry = selEdgeGeo;
    this.editSelectedEdgesLine.visible = selEdgeCoords.length > 0;

    // Thick visible edge bars for selected edges (works reliably on WebGL/Metal)
    if (selEdgePairs.length > 0) {
      if (this.editSelectedEdgeBars.instanceMatrix.count < selEdgePairs.length) {
        const oldBar = this.editSelectedEdgeBars;
        this.editOverlayGroup.remove(oldBar);
        const nextBar = new THREE.InstancedMesh(
          oldBar.geometry,
          oldBar.material,
          Math.max(16, selEdgePairs.length * 2),
        );
        nextBar.frustumCulled = false;
        nextBar.renderOrder = 4;
        this.editSelectedEdgeBars = nextBar;
        this.editOverlayGroup.add(nextBar);
      }
      const up = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3();
      const mid = new THREE.Vector3();
      const scaleVec = new THREE.Vector3();
      selEdgePairs.forEach((pair, idx) => {
        _v0.set(...pair.a);
        _v1.set(...pair.b);
        dir.subVectors(_v1, _v0);
        const len = dir.length();
        mid.addVectors(_v0, _v1).multiplyScalar(0.5);
        if (len > 1e-6) {
          dir.divideScalar(len);
          _quat.setFromUnitVectors(up, dir);
        } else {
          _quat.identity();
        }
        scaleVec.set(0.024, Math.max(len, 0.001), 0.024);
        _mat4A.compose(mid, _quat, scaleVec);
        this.editSelectedEdgeBars.setMatrixAt(idx, _mat4A);
      });
      this.editSelectedEdgeBars.count = selEdgePairs.length;
      this.editSelectedEdgeBars.instanceMatrix.needsUpdate = true;
      this.editSelectedEdgeBars.visible = true;
    } else {
      this.editSelectedEdgeBars.count = 0;
      this.editSelectedEdgeBars.visible = false;
    }

    // 3. Selected Faces Overlay
    const selFacePositions: number[] = [];
    if (this.editSelectionMode === 'face' && this.selectedComponentIds.size > 0) {
      const solidPos = visual.solidMesh.geometry.getAttribute('position');
      if (solidPos) {
        for (const fid of this.selectedComponentIds) {
          const range = visual.faceToTriangleRange.get(fid);
          if (!range) continue;
          const startVert = range.start * 3;
          const endVert = (range.start + range.count) * 3;
          for (let vi = startVert; vi < endVert; vi++) {
            selFacePositions.push(
              solidPos.getX(vi),
              solidPos.getY(vi),
              solidPos.getZ(vi),
            );
          }
        }
      }
    }
    const selFaceGeo = new THREE.BufferGeometry();
    selFaceGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(selFacePositions, 3),
    );
    this.editSelectedFacesMesh.geometry.dispose();
    this.editSelectedFacesMesh.geometry = selFaceGeo;
    this.editSelectedFacesMesh.visible = selFacePositions.length > 0;
    (this.editSelectedFacesMesh.material as THREE.MeshBasicMaterial).depthTest = !xray;

    // 4. Vertices Points (prominent in vertex mode, subtle reference in edge mode)
    const showVertices = this.editSelectionMode === 'vertex';
    const unselVerts: number[] = [];
    const selVerts: number[] = [];

    if (showVertices) {
      for (const v of mesh.vertices) {
        if (this.selectedComponentIds.has(v.id)) {
          selVerts.push(...v.position);
        } else {
          unselVerts.push(...v.position);
        }
      }
    }

    const unselGeo = new THREE.BufferGeometry();
    unselGeo.setAttribute('position', new THREE.Float32BufferAttribute(unselVerts, 3));
    this.editUnselectedVerticesPoints.geometry.dispose();
    this.editUnselectedVerticesPoints.geometry = unselGeo;
    (this.editUnselectedVerticesPoints.material as THREE.PointsMaterial).depthTest = !xray;
    this.editUnselectedVerticesPoints.visible = showVertices && unselVerts.length > 0;

    const selVertGeo = new THREE.BufferGeometry();
    selVertGeo.setAttribute('position', new THREE.Float32BufferAttribute(selVerts, 3));
    this.editSelectedVerticesPoints.geometry.dispose();
    this.editSelectedVerticesPoints.geometry = selVertGeo;
    this.editSelectedVerticesPoints.visible = showVertices && selVerts.length > 0;

    // 5. Loop Cut Preview Ring Bars
    if (this.loopCutPreviewMode && this.loopCutPreviewSegments.length > 0) {
      const segs = this.loopCutPreviewSegments;
      if (this.loopCutPreviewBars.instanceMatrix.count < segs.length) {
        const oldLoop = this.loopCutPreviewBars;
        this.editOverlayGroup.remove(oldLoop);
        const nextLoop = new THREE.InstancedMesh(
          oldLoop.geometry,
          oldLoop.material,
          Math.max(32, segs.length * 2),
        );
        nextLoop.frustumCulled = false;
        nextLoop.renderOrder = 7;
        this.loopCutPreviewBars = nextLoop;
        this.editOverlayGroup.add(nextLoop);
      }
      const up = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3();
      const mid = new THREE.Vector3();
      const scaleVec = new THREE.Vector3();
      segs.forEach((pair, idx) => {
        _v0.set(...pair[0]);
        _v1.set(...pair[1]);
        dir.subVectors(_v1, _v0);
        const len = dir.length();
        mid.addVectors(_v0, _v1).multiplyScalar(0.5);
        if (len > 1e-6) {
          dir.divideScalar(len);
          _quat.setFromUnitVectors(up, dir);
        } else {
          _quat.identity();
        }
        scaleVec.set(0.028, Math.max(len, 0.001), 0.028);
        _mat4A.compose(mid, _quat, scaleVec);
        this.loopCutPreviewBars.setMatrixAt(idx, _mat4A);
      });
      this.loopCutPreviewBars.count = segs.length;
      this.loopCutPreviewBars.instanceMatrix.needsUpdate = true;
      this.loopCutPreviewBars.visible = true;
    } else {
      this.loopCutPreviewBars.count = 0;
      this.loopCutPreviewBars.visible = false;
    }
  }

  private syncGizmoSettings(): void {
    const modeMap: Record<TransformTool, 'translate' | 'rotate' | 'scale'> = {
      select: 'translate',
      move: 'translate',
      rotate: 'rotate',
      scale: 'scale',
    };
    this.transformControls.setMode(modeMap[this.activeTool]);
    this.transformControls.setSize(this.settings?.gizmoSize ?? 1.25);

    const c = this.axisConstraint;
    this.transformControls.showX = c === 'free' || c === 'x';
    this.transformControls.showY = c === 'free' || c === 'y';
    this.transformControls.showZ = c === 'free' || c === 'z';
    this.transformControls.showXY = c === 'free';
    this.transformControls.showYZ = c === 'free';
    this.transformControls.showXZ = c === 'free';
    this.transformControls.showE = c === 'free';
    this.transformControls.showXYZE = c === 'free';

    if (this.settings?.snapEnabled) {
      this.transformControls.setTranslationSnap(this.settings.snapTranslateStep);
      this.transformControls.setRotationSnap(
        THREE.MathUtils.degToRad(this.settings.snapRotateDeg),
      );
      this.transformControls.setScaleSnap(this.settings.snapScaleStep);
    } else {
      this.transformControls.setTranslationSnap(null);
      this.transformControls.setRotationSnap(null);
      this.transformControls.setScaleSnap(null);
    }
  }

  private syncGizmoAttachment(): void {
    if (this.suppressGizmo || this.activeTool === 'select' || !this.selectedObjectId) {
      this.transformControls.detach();
      return;
    }

    const visual = this.visuals.get(this.selectedObjectId);
    if (!visual || !visual.group.visible || visual.locked) {
      this.transformControls.detach();
      return;
    }

    if (this.workMode === 'object') {
      this.transformControls.attach(visual.group);
      return;
    }

    // Edit Mode: attach to centroid of selected vertices
    const vertIds = visual.editableMesh.getVertexIdsFromSelection(
      this.editSelectionMode,
      this.selectedComponentIds,
    );
    if (vertIds.size === 0) {
      this.transformControls.detach();
      return;
    }

    const centroidLocal = visual.editableMesh.computeCentroid(vertIds);
    if (!centroidLocal) {
      this.transformControls.detach();
      return;
    }

    visual.group.updateMatrixWorld(true);
    _v0
      .set(centroidLocal[0], centroidLocal[1], centroidLocal[2])
      .applyMatrix4(visual.group.matrixWorld);

    this.editGizmoAnchor.position.copy(_v0);
    this.editGizmoAnchor.quaternion.identity();
    this.editGizmoAnchor.scale.set(1, 1, 1);
    this.editGizmoAnchor.updateMatrixWorld(true);

    this.transformControls.attach(this.editGizmoAnchor);
  }

  public switchProjection(next: CameraProjection): void {
    if (this.projection === next) return;
    const prevCam = this.activeCamera;
    const target = this.orbitControls.target;
    const distance = prevCam.position.distanceTo(target);

    if (next === 'orthographic') {
      const aspect = Math.max(0.1, this.container.clientWidth / Math.max(1, this.container.clientHeight));
      const frustumHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov / 2));
      this.orthographicCamera.left = (-frustumHeight * aspect) / 2;
      this.orthographicCamera.right = (frustumHeight * aspect) / 2;
      this.orthographicCamera.top = frustumHeight / 2;
      this.orthographicCamera.bottom = -frustumHeight / 2;
      this.orthographicCamera.zoom = 1;
      this.orthographicCamera.position.copy(this.perspectiveCamera.position);
      this.orthographicCamera.quaternion.copy(this.perspectiveCamera.quaternion);
      this.orthographicCamera.updateProjectionMatrix();
      this.activeCamera = this.orthographicCamera;
    } else {
      this.perspectiveCamera.position.copy(this.orthographicCamera.position);
      this.perspectiveCamera.quaternion.copy(this.orthographicCamera.quaternion);
      this.perspectiveCamera.updateProjectionMatrix();
      this.activeCamera = this.perspectiveCamera;
    }

    this.projection = next;
    this.orbitControls.object = this.activeCamera;
    this.transformControls.camera = this.activeCamera;
    this.orbitControls.update();
    this.requestRender();
  }

  public setCameraPreset(preset: 'front' | 'top' | 'right' | 'iso' | 'focus'): void {
    const target = new THREE.Vector3(0, 0, 0);
    if (preset === 'focus' && this.selectedObjectId) {
      const visual = this.visuals.get(this.selectedObjectId);
      if (visual) {
        target.copy(visual.group.position);
      }
    }

    const currentDist = Math.max(
      2.5,
      this.activeCamera.position.distanceTo(this.orbitControls.target),
    );
    const offset = new THREE.Vector3();

    switch (preset) {
      case 'front':
        offset.set(0, 0, currentDist);
        break;
      case 'top':
        offset.set(0, currentDist, 0.001);
        break;
      case 'right':
        offset.set(currentDist, 0, 0);
        break;
      case 'iso':
      case 'focus':
        offset.set(currentDist * 0.65, currentDist * 0.5, currentDist * 0.72);
        break;
    }

    const desiredPos = target.clone().add(offset);
    if (this.isSoftwareGl) {
      this.activeCamera.position.copy(desiredPos);
      this.orbitControls.target.copy(target);
      this.orbitControls.update();
      this.requestRender();
    } else {
      this.cameraAnimTargetPos = desiredPos;
      this.cameraAnimTargetLook = target;
      this.lastAnimTime = performance.now();
      this.requestRender();
    }
  }

  private handleResize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;

    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    const orthoHeight = this.orthographicCamera.top - this.orthographicCamera.bottom;
    this.orthographicCamera.left = (-orthoHeight * aspect) / 2;
    this.orthographicCamera.right = (orthoHeight * aspect) / 2;
    this.orthographicCamera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
    this.requestRender();
  }

  public requestRender(): void {
    if (this.disposed) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }
    this.renderBusy = true;

    this.frameId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.renderDirty = false;

      // Advance damped camera preset transitions
      let animating = false;
      if (this.cameraAnimTargetPos && this.cameraAnimTargetLook) {
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - this.lastAnimTime) / 1000));
        this.lastAnimTime = now;
        const lambda = 11;

        this.activeCamera.position.x = THREE.MathUtils.damp(
          this.activeCamera.position.x,
          this.cameraAnimTargetPos.x,
          lambda,
          dt,
        );
        this.activeCamera.position.y = THREE.MathUtils.damp(
          this.activeCamera.position.y,
          this.cameraAnimTargetPos.y,
          lambda,
          dt,
        );
        this.activeCamera.position.z = THREE.MathUtils.damp(
          this.activeCamera.position.z,
          this.cameraAnimTargetPos.z,
          lambda,
          dt,
        );

        this.orbitControls.target.x = THREE.MathUtils.damp(
          this.orbitControls.target.x,
          this.cameraAnimTargetLook.x,
          lambda,
          dt,
        );
        this.orbitControls.target.y = THREE.MathUtils.damp(
          this.orbitControls.target.y,
          this.cameraAnimTargetLook.y,
          lambda,
          dt,
        );
        this.orbitControls.target.z = THREE.MathUtils.damp(
          this.orbitControls.target.z,
          this.cameraAnimTargetLook.z,
          lambda,
          dt,
        );

        if (
          this.activeCamera.position.distanceTo(this.cameraAnimTargetPos) < 0.01 &&
          this.orbitControls.target.distanceTo(this.cameraAnimTargetLook) < 0.01
        ) {
          this.activeCamera.position.copy(this.cameraAnimTargetPos);
          this.orbitControls.target.copy(this.cameraAnimTargetLook);
          this.cameraAnimTargetPos = null;
          this.cameraAnimTargetLook = null;
        } else {
          animating = true;
        }
      }

      const controlsMoved = this.orbitControls.update();
      this.renderer.render(this.scene, this.activeCamera);

      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty || animating || controlsMoved) {
          this.requestRender();
        }
      };

      if (this.isSoftwareGl) {
        this.afterDraw(done);
      } else {
        done();
      }
    });
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();

    const dom = this.renderer.domElement;
    this.gestureManager.dispose();
    dom.removeEventListener('webglcontextlost', this.onContextLost);

    this.transformControls.dispose();
    this.orbitControls.dispose();
    this.vertexDotTexture.dispose();

    for (const visual of this.visuals.values()) {
      this.disposeObjectVisual(visual);
    }
    this.visuals.clear();

    this.renderer.dispose();
    if (dom.parentElement === this.container) {
      this.container.removeChild(dom);
    }
  }
}
