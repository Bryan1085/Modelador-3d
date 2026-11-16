import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditableMesh, Vec3 } from '../core/mesh/EditableMesh';
import {
  deleteSelectedComponents,
  EditSelectionMode,
  selectAllComponents,
} from '../core/mesh/operations';
import {
  createPrimitiveMesh,
  PRIMITIVE_LABELS,
  PrimitiveOptions,
  PrimitiveType,
} from '../core/mesh/primitives';
import {
  cloneDefaultRadialLayouts,
  DEFAULT_RADIAL_LAYOUTS,
  RADIAL_SLOT_COUNT,
  RadialActionId,
  RadialWorkMode,
} from '../core/radial/radialActions';
import {
  createNewProject,
  createDefaultTouchSettings,
  deleteProjectLocally,
  generateId,
  getActiveStoredProjectId,
  listSavedProjects,
  loadInitialProject,
  loadProjectFromAnyStorage,
  loadProjectLocally,
  loadSettingsLocally,
  saveProjectLocally,
  saveSettingsLocally,
} from '../core/project/storage';
import {
  applyDeleteAction,
  bevelMesh,
  BevelParams,
  computeLoopCutPreviewSegments,
  DeleteActionType,
  extrudeMesh,
  ExtrudeParams,
  fillMesh,
  findEdgeLoopRing,
  findFirstValidLoopEdge,
  insetFacesMesh,
  InsetParams,
  loopCutMesh,
  LoopCutParams,
  mergeVerticesMesh,
  MergeParams,
  subdivideMesh,
  SubdivideParams,
} from '../core/mesh/advancedOperations';
import {
  addCollectionToScene,
  addSceneToProject,
  createReferenceImageObject,
  DeleteCollectionResolution,
  deleteCollectionFromScene,
  deleteSceneFromProject,
  detectOrientationFromRotation,
  getActiveScene,
  isEditableMeshObject,
  moveObjectToCollectionInScene,
  REFERENCE_ORIENTATION_ROTATIONS,
  renameCollectionInScene,
  renameSceneInProject,
  setActiveCollectionInScene,
  switchSceneInProject,
  toggleCollectionExpandedInScene,
  updateActiveScene,
} from '../core/project/hierarchy';
import { ObjImportResult } from '../core/io/objImport';
import { StlImportResult } from '../core/io/stlImport';
import { LoadedImageReferencePayload } from '../core/io/imageReference';
import {
  AxisConstraint,
  CameraProjection,
  ModelerSettings,
  ObjectTransform,
  ProjectData,
  ProjectSummary,
  ReferenceImageData,
  ReferenceImageOrientation,
  SceneData,
  SceneObjectData,
  TouchControlSettings,
  TouchModifierKey,
  TouchModifierSlotConfig,
  TransformTool,
  WorkMode,
} from '../core/project/types';
import { SerializedEditableMesh } from '../core/mesh/EditableMesh';

export function applyComponentSelection(
  prev: ReadonlySet<string>,
  id: string | null,
  additive: boolean,
  addOnly = false,
): Set<string> {
  if (id === null) {
    if (additive || addOnly) {
      return new Set(prev);
    }
    return new Set();
  }
  if (addOnly) {
    const next = new Set(prev);
    next.add(id);
    return next;
  }
  const next = new Set(additive ? prev : []);
  if (additive && prev.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export type EditOperatorType =
  | 'extrude'
  | 'inset'
  | 'subdivide'
  | 'bevel'
  | 'loop_cut'
  | 'merge';

export type EditOperatorParams =
  | { type: 'extrude'; params: ExtrudeParams }
  | { type: 'inset'; params: InsetParams }
  | { type: 'subdivide'; params: SubdivideParams }
  | { type: 'bevel'; params: BevelParams }
  | { type: 'loop_cut'; params: LoopCutParams }
  | { type: 'merge'; params: MergeParams };

export interface EditOperatorSession {
  objectId: string;
  baseMesh: SerializedEditableMesh;
  baseSelectionMode: EditSelectionMode;
  baseSelectedIds: string[];
  config: EditOperatorParams;
}

interface HistorySnapshot {
  scenes: SceneData[];
  activeSceneId: string;
  selectedObjectId: string | null;
  workMode: WorkMode;
  editSelectionMode: EditSelectionMode;
  selectedComponentIds: string[];
}

const MAX_HISTORY = 50;

function cloneScenes(scenes: SceneData[]): SceneData[] {
  return JSON.parse(JSON.stringify(scenes)) as SceneData[];
}

export function useModelerStore() {
  const initialProject = useMemo(() => loadInitialProject(), []);

  const [project, setProject] = useState<ProjectData>(initialProject);
  const [savedProjects, setSavedProjects] = useState<ProjectSummary[]>(() =>
    listSavedProjects(),
  );
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(
    () => getActiveScene(initialProject).objects[0]?.id ?? null,
  );
  const [workMode, setWorkMode] = useState<WorkMode>('object');
  const [editSelectionMode, setEditSelectionMode] =
    useState<EditSelectionMode>('vertex');
  const [selectedComponentIds, setSelectedComponentIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [activeTool, setActiveTool] = useState<TransformTool>('move');
  const [axisConstraint, setAxisConstraint] = useState<AxisConstraint>('free');
  const [projection, setProjection] = useState<CameraProjection>('perspective');
  const [settings, setSettings] = useState<ModelerSettings>(() =>
    loadSettingsLocally(),
  );

  const [meshRevision, setMeshRevision] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [screenShiftActive, setScreenShiftActive] = useState(false);
  const [operatorSession, setOperatorSession] =
    useState<EditOperatorSession | null>(null);

  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const redoStackRef = useRef<HistorySnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2600);
  }, []);

  // Hydrate active project from IndexedDB if it holds a newer/larger copy (e.g. embedded reference images)
  const initialHydrateRef = useRef(false);
  useEffect(() => {
    if (initialHydrateRef.current) return;
    initialHydrateRef.current = true;
    const storedId = getActiveStoredProjectId() ?? initialProject.id;
    void loadProjectFromAnyStorage(storedId).then((idbProj) => {
      if (!idbProj) return;
      setProject((curr) => {
        if (curr.id === idbProj.id && idbProj.updatedAt <= curr.updatedAt) {
          return curr;
        }
        setSelectedObjectId(getActiveScene(idbProj).objects[0]?.id ?? null);
        setMeshRevision((r) => r + 1);
        return idbProj;
      });
    });
  }, [initialProject.id]);

  const activeScene = useMemo(() => getActiveScene(project), [project]);
  const activeObjects = activeScene.objects;

  const makeSnapshot = useCallback(
    (
      scenes = project.scenes,
      actSceneId = project.activeSceneId,
      selObjId = selectedObjectId,
      mode = workMode,
      subMode = editSelectionMode,
      compIds = selectedComponentIds,
    ): HistorySnapshot => ({
      scenes: cloneScenes(scenes),
      activeSceneId: actSceneId,
      selectedObjectId: selObjId,
      workMode: mode,
      editSelectionMode: subMode,
      selectedComponentIds: Array.from(compIds),
    }),
    [
      project.scenes,
      project.activeSceneId,
      selectedObjectId,
      workMode,
      editSelectionMode,
      selectedComponentIds,
    ],
  );

  const pushHistory = useCallback((snapshot: HistorySnapshot) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > MAX_HISTORY) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  const selectedObject = useMemo(
    () => activeObjects.find((o) => o.id === selectedObjectId) ?? null,
    [activeObjects, selectedObjectId],
  );

  const canUndo = undoStackRef.current.length > 0 && historyVersion >= 0;
  const canRedo = redoStackRef.current.length > 0 && historyVersion >= 0;

  const undo = useCallback(
    (fromGesture = false) => {
      const prev = undoStackRef.current.pop();
      if (!prev) {
        if (fromGesture) showToast('Nada que deshacer');
        return;
      }
      setOperatorSession(null);
      redoStackRef.current.push(makeSnapshot());
      setProject((p) => ({
        ...p,
        activeSceneId: prev.activeSceneId,
        scenes: cloneScenes(prev.scenes),
      }));
      setSelectedObjectId(prev.selectedObjectId);
      setWorkMode(prev.workMode);
      setEditSelectionMode(prev.editSelectionMode);
      setSelectedComponentIds(new Set(prev.selectedComponentIds));
      if (prev.workMode !== 'edit') setScreenShiftActive(false);
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      setHistoryVersion((v) => v + 1);
      if (fromGesture) showToast('Deshacer');
    },
    [makeSnapshot, showToast],
  );

  const redo = useCallback(
    (fromGesture = false) => {
      const next = redoStackRef.current.pop();
      if (!next) {
        if (fromGesture) showToast('Nada que rehacer');
        return;
      }
      setOperatorSession(null);
      undoStackRef.current.push(makeSnapshot());
      setProject((p) => ({
        ...p,
        activeSceneId: next.activeSceneId,
        scenes: cloneScenes(next.scenes),
      }));
      setSelectedObjectId(next.selectedObjectId);
      setWorkMode(next.workMode);
      setEditSelectionMode(next.editSelectionMode);
      setSelectedComponentIds(new Set(next.selectedComponentIds));
      if (next.workMode !== 'edit') setScreenShiftActive(false);
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      setHistoryVersion((v) => v + 1);
      if (fromGesture) showToast('Rehacer');
    },
    [makeSnapshot, showToast],
  );

  const setProjectName = useCallback((name: string) => {
    setProject((p) => ({ ...p, name }));
    setHasUnsavedChanges(true);
  }, []);

  const saveProject = useCallback(() => {
    const saved = saveProjectLocally(project);
    setProject(saved);
    setSavedProjects(listSavedProjects());
    setHasUnsavedChanges(false);
    showToast(`Proyecto "${saved.name}" guardado`);
  }, [project, showToast]);

  const createProject = useCallback(
    (name: string) => {
      setOperatorSession(null);
      const fresh = saveProjectLocally(createNewProject(name.trim() || 'Nuevo Proyecto'));
      undoStackRef.current = [];
      redoStackRef.current = [];
      setProject(fresh);
      setSavedProjects(listSavedProjects());
      setSelectedObjectId(getActiveScene(fresh).objects[0]?.id ?? null);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(false);
      setMeshRevision((r) => r + 1);
      setHistoryVersion((v) => v + 1);
      showToast(`Proyecto "${fresh.name}" creado`);
    },
    [showToast],
  );

  const openProject = useCallback(
    async (projectId: string) => {
      const loaded =
        (await loadProjectFromAnyStorage(projectId)) ??
        loadProjectLocally(projectId);
      if (!loaded) {
        showToast('No se pudo cargar el proyecto');
        return;
      }
      setOperatorSession(null);
      undoStackRef.current = [];
      redoStackRef.current = [];
      setProject(loaded);
      setSelectedObjectId(getActiveScene(loaded).objects[0]?.id ?? null);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(false);
      setMeshRevision((r) => r + 1);
      setHistoryVersion((v) => v + 1);
      showToast(`Proyecto "${loaded.name}" abierto`);
    },
    [showToast],
  );

  const removeSavedProject = useCallback(
    (projectId: string) => {
      deleteProjectLocally(projectId);
      setSavedProjects(listSavedProjects());
    },
    [],
  );

  const addPrimitive = useCallback(
    (
      type: PrimitiveType,
      options?: PrimitiveOptions,
      targetCollectionId?: string,
    ) => {
      pushHistory(makeSnapshot());
      const mesh = createPrimitiveMesh(type, options);
      const baseName = PRIMITIVE_LABELS[type];
      const existingCount = activeObjects.filter((o) =>
        o.name.startsWith(baseName),
      ).length;
      const name = existingCount === 0 ? baseName : `${baseName} ${existingCount + 1}`;
      const resolvedCollectionId =
        targetCollectionId &&
        activeScene.collections.some((c) => c.id === targetCollectionId)
          ? targetCollectionId
          : activeScene.activeCollectionId;

      const newObj: SceneObjectData = {
        id: generateId('obj'),
        name,
        objectType: 'mesh',
        primitiveType: type,
        collectionId: resolvedCollectionId,
        visible: true,
        locked: false,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mesh: mesh.toJSON(),
        material: {
          color: '#9aa0a6',
          roughness: 0.55,
          metalness: 0.08,
        },
        modifiers: [],
      };

      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          collections: scene.collections.map((c) =>
            c.id === resolvedCollectionId ? { ...c, expanded: true } : c,
          ),
          objects: [...scene.objects, newObj],
        })),
      );
      setSelectedObjectId(newObj.id);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(`${name} agregado`);
    },
    [
      activeObjects,
      activeScene.activeCollectionId,
      activeScene.collections,
      makeSnapshot,
      pushHistory,
      showToast,
    ],
  );

  const selectObject = useCallback(
    (id: string | null) => {
      setOperatorSession(null);
      if (workMode === 'edit' && id !== selectedObjectId) {
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setSelectedObjectId(id);
    },
    [selectedObjectId, workMode],
  );

  const selectObjectInScene = useCallback(
    (sceneId: string, objectId: string) => {
      setOperatorSession(null);
      if (sceneId !== project.activeSceneId) {
        setProject((p) => switchSceneInProject(p, sceneId));
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
        setMeshRevision((r) => r + 1);
      } else if (workMode === 'edit' && objectId !== selectedObjectId) {
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setSelectedObjectId(objectId);
    },
    [project.activeSceneId, selectedObjectId, workMode],
  );

  const toggleWorkMode = useCallback(
    (nextMode: WorkMode) => {
      setOperatorSession(null);
      if (nextMode === 'edit') {
        if (!selectedObject) {
          showToast('Selecciona un objeto para entrar en Modo Edición');
          return;
        }
        if (selectedObject.objectType === 'reference_image') {
          showToast('Las referencias de imagen no permiten el Modo Edición');
          return;
        }
        if (!isEditableMeshObject(selectedObject)) {
          showToast('Este tipo de objeto no es editable por topología');
          return;
        }
        if (selectedObject.locked) {
          showToast('El objeto está bloqueado');
          return;
        }
        setSelectedComponentIds(new Set());
      } else {
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setWorkMode(nextMode);
    },
    [selectedObject, showToast],
  );

  const changeEditSelectionMode = useCallback((mode: EditSelectionMode) => {
    setOperatorSession(null);
    setEditSelectionMode(mode);
    setSelectedComponentIds(new Set());
  }, []);

  const updateObjectTransform = useCallback(
    (objectId: string, transform: ObjectTransform, recordHistory = true) => {
      if (recordHistory) {
        pushHistory(makeSnapshot());
      }
      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          objects: scene.objects.map((o) => {
            if (o.id !== objectId) return o;
            if (o.objectType === 'reference_image' && o.referenceImage) {
              return {
                ...o,
                transform,
                referenceImage: {
                  ...o.referenceImage,
                  orientation: detectOrientationFromRotation(transform.rotation),
                },
              };
            }
            return { ...o, transform };
          }),
        })),
      );
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const commitObjectTransformFromGizmo = useCallback(
    (
      objectId: string,
      beforeTransform: ObjectTransform,
      afterTransform: ObjectTransform,
    ) => {
      const snapshot = makeSnapshot();
      snapshot.scenes = snapshot.scenes.map((s) =>
        s.id === snapshot.activeSceneId
          ? {
              ...s,
              objects: s.objects.map((o) =>
                o.id === objectId ? { ...o, transform: beforeTransform } : o,
              ),
            }
          : s,
      );
      pushHistory(snapshot);

      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          objects: scene.objects.map((o) => {
            if (o.id !== objectId) return o;
            if (o.objectType === 'reference_image' && o.referenceImage) {
              return {
                ...o,
                transform: afterTransform,
                referenceImage: {
                  ...o.referenceImage,
                  orientation: detectOrientationFromRotation(
                    afterTransform.rotation,
                  ),
                },
              };
            }
            return { ...o, transform: afterTransform };
          }),
        })),
      );
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const commitMeshEditFromGizmo = useCallback(
    (objectId: string, beforeMesh: EditableMesh, afterMesh: EditableMesh) => {
      const snapshot = makeSnapshot();
      snapshot.scenes = snapshot.scenes.map((s) =>
        s.id === snapshot.activeSceneId
          ? {
              ...s,
              objects: s.objects.map((o) =>
                o.id === objectId ? { ...o, mesh: beforeMesh.toJSON() } : o,
              ),
            }
          : s,
      );
      pushHistory(snapshot);

      const cleanAfterMesh = afterMesh.clone();
      cleanAfterMesh.clearCustomNormals();

      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === objectId ? { ...o, mesh: cleanAfterMesh.toJSON() } : o,
          ),
        })),
      );
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
    },
    [makeSnapshot, pushHistory],
  );

  const renameObject = useCallback(
    (objectId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      pushHistory(makeSnapshot());
      setProject((p) => ({
        ...p,
        scenes: p.scenes.map((scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === objectId ? { ...o, name: trimmed } : o,
          ),
        })),
      }));
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const toggleObjectVisibility = useCallback(
    (objectId: string) => {
      pushHistory(makeSnapshot());
      setProject((p) => ({
        ...p,
        scenes: p.scenes.map((scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === objectId ? { ...o, visible: !o.visible } : o,
          ),
        })),
      }));
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const toggleObjectLock = useCallback(
    (objectId: string) => {
      pushHistory(makeSnapshot());
      setProject((p) => ({
        ...p,
        scenes: p.scenes.map((scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === objectId ? { ...o, locked: !o.locked } : o,
          ),
        })),
      }));
      if (objectId === selectedObjectId && workMode === 'edit') {
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory, selectedObjectId, workMode],
  );

  const duplicateObjectById = useCallback(
    (objectId: string) => {
      const targetScene =
        project.scenes.find((s) => s.objects.some((o) => o.id === objectId)) ??
        null;
      const target =
        targetScene?.objects.find((o) => o.id === objectId) ?? null;
      if (!targetScene || !target) return;

      pushHistory(makeSnapshot());
      const copy: SceneObjectData = {
        ...JSON.parse(JSON.stringify(target)),
        id: generateId('obj'),
        name: `${target.name} Copia`,
        transform: {
          position: [
            target.transform.position[0] + 0.5,
            target.transform.position[1],
            target.transform.position[2] + 0.5,
          ],
          rotation: [...target.transform.rotation] as Vec3,
          scale: [...target.transform.scale] as Vec3,
        },
      };
      setProject((p) => ({
        ...p,
        activeSceneId: targetScene.id,
        scenes: p.scenes.map((s) =>
          s.id === targetScene.id ? { ...s, objects: [...s.objects, copy] } : s,
        ),
      }));
      setSelectedObjectId(copy.id);
      setWorkMode('object');
      setScreenShiftActive(false);
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(`Objeto duplicado: ${copy.name}`);
    },
    [makeSnapshot, project.scenes, pushHistory, showToast],
  );

  const duplicateSelectedObject = useCallback(() => {
    if (!selectedObject) return;
    duplicateObjectById(selectedObject.id);
  }, [duplicateObjectById, selectedObject]);

  const deleteObject = useCallback(
    (objectId: string) => {
      const targetScene =
        project.scenes.find((s) => s.objects.some((o) => o.id === objectId)) ??
        null;
      const target =
        targetScene?.objects.find((o) => o.id === objectId) ?? null;
      if (!targetScene || !target) return;
      if (target.locked) {
        showToast('Desbloquea el objeto antes de eliminarlo');
        return;
      }
      pushHistory(makeSnapshot());
      const remaining = targetScene.objects.filter((o) => o.id !== objectId);
      setProject((p) => ({
        ...p,
        scenes: p.scenes.map((s) =>
          s.id === targetScene.id ? { ...s, objects: remaining } : s,
        ),
      }));
      if (selectedObjectId === objectId) {
        setSelectedObjectId(remaining[0]?.id ?? null);
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
    },
    [makeSnapshot, project.scenes, pushHistory, selectedObjectId, showToast],
  );

  /* ==========================================================================
   * Scene & Collection Hierarchy Actions
   * ======================================================================== */
  const createScene = useCallback(
    (name?: string) => {
      pushHistory(makeSnapshot());
      const res = addSceneToProject(project, name);
      setProject(res.project);
      setOperatorSession(null);
      setSelectedObjectId(res.scene.objects[0]?.id ?? null);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(`Escena "${res.scene.name}" creada`);
    },
    [makeSnapshot, project, pushHistory, showToast],
  );

  const switchScene = useCallback(
    (sceneId: string) => {
      if (sceneId === project.activeSceneId) return;
      const target = project.scenes.find((s) => s.id === sceneId);
      if (!target) return;
      setOperatorSession(null);
      setProject((p) => switchSceneInProject(p, sceneId));
      setSelectedObjectId(target.objects[0]?.id ?? null);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setMeshRevision((r) => r + 1);
    },
    [project.activeSceneId, project.scenes],
  );

  const renameScene = useCallback(
    (sceneId: string, name: string) => {
      if (!name.trim()) return;
      pushHistory(makeSnapshot());
      setProject((p) => renameSceneInProject(p, sceneId, name));
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const deleteScene = useCallback(
    (sceneId: string) => {
      if (project.scenes.length <= 1) {
        showToast('No se puede eliminar la última escena');
        return;
      }
      pushHistory(makeSnapshot());
      const res = deleteSceneFromProject(project, sceneId);
      if (res.error) {
        showToast(res.error);
        return;
      }
      setProject(res.project);
      const nextScene = getActiveScene(res.project);
      setOperatorSession(null);
      setSelectedObjectId(nextScene.objects[0]?.id ?? null);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast('Escena eliminada');
    },
    [makeSnapshot, project, pushHistory, showToast],
  );

  const createCollection = useCallback(
    (sceneId = activeScene.id, name?: string, parentId: string | null = null) => {
      pushHistory(makeSnapshot());
      const res = addCollectionToScene(project, sceneId, name, parentId);
      if (res.collection) {
        setProject(res.project);
        setHasUnsavedChanges(true);
        showToast(`Colección "${res.collection.name}" creada`);
      }
    },
    [activeScene.id, makeSnapshot, project, pushHistory, showToast],
  );

  const selectCollection = useCallback(
    (sceneId: string, collectionId: string) => {
      setProject((p) => {
        const switched =
          sceneId !== p.activeSceneId ? switchSceneInProject(p, sceneId) : p;
        return setActiveCollectionInScene(switched, sceneId, collectionId);
      });
      if (sceneId !== project.activeSceneId) {
        const target = project.scenes.find((s) => s.id === sceneId);
        setOperatorSession(null);
        setSelectedObjectId(target?.objects[0]?.id ?? null);
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
        setMeshRevision((r) => r + 1);
      }
    },
    [project.activeSceneId, project.scenes],
  );

  const renameCollection = useCallback(
    (sceneId: string, collectionId: string, name: string) => {
      if (!name.trim()) return;
      pushHistory(makeSnapshot());
      setProject((p) => renameCollectionInScene(p, sceneId, collectionId, name));
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const toggleCollectionExpanded = useCallback(
    (sceneId: string, collectionId: string) => {
      setProject((p) =>
        toggleCollectionExpandedInScene(p, sceneId, collectionId),
      );
    },
    [],
  );

  const deleteCollection = useCallback(
    (
      sceneId: string,
      collectionId: string,
      resolution: DeleteCollectionResolution,
    ) => {
      const targetScene = project.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return;
      if (targetScene.collections.length <= 1) {
        showToast('Cada escena debe mantener al menos una colección');
        return;
      }
      pushHistory(makeSnapshot());
      const res = deleteCollectionFromScene(
        project,
        sceneId,
        collectionId,
        resolution,
      );
      if (res.error) {
        showToast(res.error);
        return;
      }
      setProject(res.project);
      if (
        selectedObjectId &&
        res.deletedObjectIds.includes(selectedObjectId)
      ) {
        const nextActiveScene = getActiveScene(res.project);
        setSelectedObjectId(nextActiveScene.objects[0]?.id ?? null);
        setWorkMode('object');
        setScreenShiftActive(false);
        setSelectedComponentIds(new Set());
      }
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(
        resolution.mode === 'move_objects'
          ? 'Colección eliminada y objetos reubicados'
          : 'Colección eliminada',
      );
    },
    [makeSnapshot, project, pushHistory, selectedObjectId, showToast],
  );

  const moveObjectToCollection = useCallback(
    (sceneId: string, objectId: string, targetCollectionId: string) => {
      const scene = project.scenes.find((s) => s.id === sceneId);
      const obj = scene?.objects.find((o) => o.id === objectId);
      if (!scene || !obj || obj.collectionId === targetCollectionId) return;

      pushHistory(makeSnapshot());
      setProject((p) =>
        moveObjectToCollectionInScene(p, sceneId, objectId, targetCollectionId),
      );
      setHasUnsavedChanges(true);
      const destCol = scene.collections.find((c) => c.id === targetCollectionId);
      if (destCol) {
        showToast(`"${obj.name}" movido a ${destCol.name}`);
      }
    },
    [makeSnapshot, project.scenes, pushHistory, showToast],
  );

  /* ==========================================================================
   * Model Import (OBJ / STL) & Reference Image Actions
   * ======================================================================== */
  const importObjParts = useCallback(
    (result: ObjImportResult, targetCollectionId?: string) => {
      if (result.parts.length === 0) return;
      pushHistory(makeSnapshot());

      const baseColId =
        targetCollectionId &&
        activeScene.collections.some((c) => c.id === targetCollectionId)
          ? targetCollectionId
          : activeScene.activeCollectionId;

      let nextProject = project;
      let destCollectionId = baseColId;

      // Preserve multi-group organization by creating a dedicated collection if multiple OBJ groups exist
      if (result.parts.length > 1) {
        const colRes = addCollectionToScene(
          nextProject,
          activeScene.id,
          result.baseName,
          baseColId,
        );
        nextProject = colRes.project;
        if (colRes.collection) {
          destCollectionId = colRes.collection.id;
        }
      }

      const newObjects: SceneObjectData[] = result.parts.map((part) => ({
        id: generateId('obj'),
        name: part.name,
        objectType: 'mesh',
        primitiveType: 'custom',
        collectionId: destCollectionId,
        visible: true,
        locked: false,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mesh: part.mesh.toJSON(),
        material: part.material,
        modifiers: [],
      }));

      nextProject = updateActiveScene(nextProject, (scene) => ({
        ...scene,
        collections: scene.collections.map((c) =>
          c.id === destCollectionId || c.id === baseColId
            ? { ...c, expanded: true }
            : c,
        ),
        objects: [...scene.objects, ...newObjects],
      }));

      setProject(nextProject);
      setOperatorSession(null);
      setSelectedObjectId(newObjects[0].id);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);

      const summary =
        newObjects.length > 1
          ? `OBJ "${result.baseName}" importado (${newObjects.length} grupos)`
          : `OBJ "${newObjects[0].name}" importado`;
      showToast(summary);
    },
    [activeScene.activeCollectionId, activeScene.collections, activeScene.id, makeSnapshot, project, pushHistory, showToast],
  );

  const importStlResult = useCallback(
    (result: StlImportResult, targetCollectionId?: string) => {
      pushHistory(makeSnapshot());

      const resolvedCollectionId =
        targetCollectionId &&
        activeScene.collections.some((c) => c.id === targetCollectionId)
          ? targetCollectionId
          : activeScene.activeCollectionId;

      const existingCount = activeObjects.filter((o) =>
        o.name.startsWith(result.name),
      ).length;
      const finalName =
        existingCount === 0
          ? result.name
          : `${result.name} ${existingCount + 1}`;

      const newObj: SceneObjectData = {
        id: generateId('obj'),
        name: finalName,
        objectType: 'mesh',
        primitiveType: 'custom',
        collectionId: resolvedCollectionId,
        visible: true,
        locked: false,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mesh: result.mesh.toJSON(),
        material: result.material,
        modifiers: [],
      };

      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          collections: scene.collections.map((c) =>
            c.id === resolvedCollectionId ? { ...c, expanded: true } : c,
          ),
          objects: [...scene.objects, newObj],
        })),
      );
      setOperatorSession(null);
      setSelectedObjectId(newObj.id);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(
        `STL "${finalName}" importado (${result.triangleCount.toLocaleString()} triángulos)`,
      );
    },
    [
      activeObjects,
      activeScene.activeCollectionId,
      activeScene.collections,
      makeSnapshot,
      pushHistory,
      showToast,
    ],
  );

  const addReferenceImage = useCallback(
    (
      payload: LoadedImageReferencePayload,
      orientation: ReferenceImageOrientation = 'front',
      targetCollectionId?: string,
    ) => {
      pushHistory(makeSnapshot());
      const resolvedCollectionId =
        targetCollectionId &&
        activeScene.collections.some((c) => c.id === targetCollectionId)
          ? targetCollectionId
          : activeScene.activeCollectionId;

      const baseName = payload.name || 'Referencia';
      const existingCount = activeObjects.filter((o) =>
        o.name.startsWith(baseName),
      ).length;
      const finalName =
        existingCount === 0 ? baseName : `${baseName} ${existingCount + 1}`;

      const refObj = createReferenceImageObject({
        name: finalName,
        collectionId: resolvedCollectionId,
        imageDataUrl: payload.imageDataUrl,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        naturalWidth: payload.naturalWidth,
        naturalHeight: payload.naturalHeight,
        orientation,
      });

      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          collections: scene.collections.map((c) =>
            c.id === resolvedCollectionId ? { ...c, expanded: true } : c,
          ),
          objects: [...scene.objects, refObj],
        })),
      );
      setOperatorSession(null);
      setSelectedObjectId(refObj.id);
      setWorkMode('object');
      setScreenShiftActive(false);
      setSelectedComponentIds(new Set());
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
      showToast(`Referencia "${finalName}" añadida`);
    },
    [
      activeObjects,
      activeScene.activeCollectionId,
      activeScene.collections,
      makeSnapshot,
      pushHistory,
      showToast,
    ],
  );

  const updateReferenceImageProps = useCallback(
    (
      objectId: string,
      patch: Partial<
        Pick<ReferenceImageData, 'opacity' | 'orientation' | 'depthMode'>
      >,
      recordHistory = true,
    ) => {
      if (recordHistory) {
        pushHistory(makeSnapshot());
      }
      setProject((p) => ({
        ...p,
        scenes: p.scenes.map((scene) => ({
          ...scene,
          objects: scene.objects.map((o) => {
            if (
              o.id !== objectId ||
              o.objectType !== 'reference_image' ||
              !o.referenceImage
            ) {
              return o;
            }
            const nextRef: ReferenceImageData = {
              ...o.referenceImage,
              ...patch,
            };
            let nextTransform = o.transform;
            if (patch.orientation && patch.orientation !== 'free') {
              nextTransform = {
                ...o.transform,
                rotation: [...REFERENCE_ORIENTATION_ROTATIONS[patch.orientation]],
              };
            }
            return {
              ...o,
              transform: nextTransform,
              referenceImage: nextRef,
            };
          }),
        })),
      }));
      setHasUnsavedChanges(true);
    },
    [makeSnapshot, pushHistory],
  );

  const selectAllEditComponents = useCallback(() => {
    if (!selectedObject || workMode !== 'edit') return;
    const mesh = EditableMesh.fromJSON(selectedObject.mesh);
    setSelectedComponentIds(selectAllComponents(mesh, editSelectionMode));
  }, [editSelectionMode, selectedObject, workMode]);

  const deselectAllEditComponents = useCallback(() => {
    setSelectedComponentIds(new Set());
  }, []);

  const deleteSelectedEditComponents = useCallback(() => {
    if (!selectedObject || workMode !== 'edit') return;
    if (selectedComponentIds.size === 0) {
      showToast('No hay componentes seleccionados');
      return;
    }
    pushHistory(makeSnapshot());
    const mesh = EditableMesh.fromJSON(selectedObject.mesh);
    deleteSelectedComponents(mesh, editSelectionMode, selectedComponentIds);
    mesh.clearCustomNormals();
    const updatedMeshJson = mesh.toJSON();
    setProject((p) =>
      updateActiveScene(p, (scene) => ({
        ...scene,
        objects: scene.objects.map((o) =>
          o.id === selectedObject.id ? { ...o, mesh: updatedMeshJson } : o,
        ),
      })),
    );
    setSelectedComponentIds(new Set());
    setHasUnsavedChanges(true);
    setMeshRevision((r) => r + 1);
  }, [
    editSelectionMode,
    makeSnapshot,
    pushHistory,
    selectedComponentIds,
    selectedObject,
    showToast,
    workMode,
  ]);

  const toggleScreenShift = useCallback(() => {
    setScreenShiftActive((prev) => !prev);
  }, []);

  const selectComponentFromViewport = useCallback(
    (id: string | null, additive: boolean, addOnly = false) => {
      if (operatorSession) return;
      const effectiveAddOnly = addOnly || screenShiftActive;
      const effectiveAdditive = additive || screenShiftActive;
      setSelectedComponentIds((prev) =>
        applyComponentSelection(prev, id, effectiveAdditive, effectiveAddOnly),
      );
    },
    [operatorSession, screenShiftActive],
  );

  const updateSettings = useCallback((patch: Partial<ModelerSettings>) => {
    setSettings((prev) => {
      const next: ModelerSettings = {
        ...prev,
        ...patch,
        touch: patch.touch ? { ...prev.touch, ...patch.touch } : prev.touch,
      };
      saveSettingsLocally(next);
      return next;
    });
  }, []);

  const updateTouchSettings = useCallback(
    (patch: Partial<TouchControlSettings>) => {
      setSettings((prev) => {
        const next: ModelerSettings = {
          ...prev,
          touch: { ...prev.touch, ...patch },
        };
        saveSettingsLocally(next);
        return next;
      });
    },
    [],
  );

  const updateTouchModifier = useCallback(
    (key: TouchModifierKey, patch: Partial<TouchModifierSlotConfig>) => {
      setSettings((prev) => {
        const next: ModelerSettings = {
          ...prev,
          touch: {
            ...prev.touch,
            modifiers: {
              ...prev.touch.modifiers,
              [key]: {
                ...prev.touch.modifiers[key],
                ...patch,
              },
            },
          },
        };
        saveSettingsLocally(next);
        return next;
      });
    },
    [],
  );

  const updateRadialSlot = useCallback(
    (
      mode: RadialWorkMode,
      slotIndex: number,
      actionId: RadialActionId | null,
    ) => {
      if (slotIndex < 0 || slotIndex >= RADIAL_SLOT_COUNT) return;
      setSettings((prev) => {
        const currentSlots = [...prev.touch.radialLayouts[mode]];
        currentSlots[slotIndex] = actionId;
        const next: ModelerSettings = {
          ...prev,
          touch: {
            ...prev.touch,
            radialLayouts: {
              ...prev.touch.radialLayouts,
              [mode]: currentSlots,
            },
          },
        };
        saveSettingsLocally(next);
        return next;
      });
    },
    [],
  );

  const resetRadialSlot = useCallback(
    (mode: RadialWorkMode, slotIndex: number) => {
      if (slotIndex < 0 || slotIndex >= RADIAL_SLOT_COUNT) return;
      const fallback = DEFAULT_RADIAL_LAYOUTS[mode][slotIndex] ?? null;
      updateRadialSlot(mode, slotIndex, fallback);
      showToast('Botón restaurado al valor predeterminado');
    },
    [showToast, updateRadialSlot],
  );

  const resetRadialLayout = useCallback(
    (mode: RadialWorkMode) => {
      const defaults = cloneDefaultRadialLayouts();
      setSettings((prev) => {
        const next: ModelerSettings = {
          ...prev,
          touch: {
            ...prev.touch,
            radialLayouts: {
              ...prev.touch.radialLayouts,
              [mode]: defaults[mode],
            },
          },
        };
        saveSettingsLocally(next);
        return next;
      });
      showToast('Distribución radial restaurada');
    },
    [showToast],
  );

  const resetTouchSettings = useCallback(() => {
    setSettings((prev) => {
      const next: ModelerSettings = {
        ...prev,
        touch: createDefaultTouchSettings(),
      };
      saveSettingsLocally(next);
      return next;
    });
    showToast('Controles táctiles y menú radial restaurados');
  }, [showToast]);

  const updateSelectedVerticesPosition = useCallback(
    (axis: 0 | 1 | 2, targetValue: number) => {
      if (
        operatorSession ||
        !selectedObject ||
        workMode !== 'edit' ||
        selectedComponentIds.size === 0
      ) {
        return;
      }
      const mesh = EditableMesh.fromJSON(selectedObject.mesh);
      const vertIds = mesh.getVertexIdsFromSelection(
        editSelectionMode,
        selectedComponentIds,
      );
      const centroid = mesh.computeCentroid(vertIds);
      if (!centroid) return;
      const delta = targetValue - centroid[axis];
      if (Math.abs(delta) < 1e-6) return;

      pushHistory(makeSnapshot());
      for (const vid of vertIds) {
        const v = mesh.getVertex(vid);
        if (v) v.position[axis] += delta;
      }
      mesh.clearCustomNormals();
      const updated = mesh.toJSON();
      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === selectedObject.id ? { ...o, mesh: updated } : o,
          ),
        })),
      );
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
    },
    [
      editSelectionMode,
      makeSnapshot,
      operatorSession,
      pushHistory,
      selectedComponentIds,
      selectedObject,
      workMode,
    ],
  );

  /* ==========================================================================
   * Advanced Edit Mode Operators (v0.2)
   * ======================================================================== */
  const startEditOperator = useCallback(
    (type: EditOperatorType) => {
      if (!selectedObject || workMode !== 'edit') return;
      if (selectedObject.locked) {
        showToast('El objeto está bloqueado');
        return;
      }

      const mesh = EditableMesh.fromJSON(selectedObject.mesh);
      const baseIds = Array.from(selectedComponentIds);

      if (type === 'loop_cut') {
        const preferredEdges =
          editSelectionMode === 'edge'
            ? selectedComponentIds
            : editSelectionMode === 'face'
              ? (() => {
                  const s = new Set<string>();
                  for (const fid of selectedComponentIds) {
                    for (const eid of mesh.getEdgesForFace(fid)) s.add(eid);
                  }
                  return s;
                })()
              : undefined;
        const firstEdge = findFirstValidLoopEdge(mesh, preferredEdges);
        if (!firstEdge) {
          showToast(
            'No hay un bucle de caras cuadrangulares compatible en esta malla',
          );
          return;
        }
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'loop_cut',
            params: { edgeId: firstEdge, cuts: 1, slide: 0 },
          },
        });
        return;
      }

      if (selectedComponentIds.size === 0) {
        showToast('Selecciona al menos un componente antes de aplicar la herramienta');
        return;
      }

      if (type === 'extrude') {
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'extrude',
            params: { distance: 0.5, axis: 'normal', individual: false },
          },
        });
      } else if (type === 'inset') {
        const hasFullFace =
          editSelectionMode === 'face' ||
          (() => {
            const verts = mesh.getVertexIdsFromSelection(
              editSelectionMode,
              selectedComponentIds,
            );
            return mesh.faces.some((f) => f.vertexIds.every((v) => verts.has(v)));
          })();
        if (!hasFullFace) {
          showToast('Selecciona al menos una cara completa para insertar');
          return;
        }
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'inset',
            params: { thickness: 0.25, depth: 0, individual: false },
          },
        });
      } else if (type === 'subdivide') {
        if (editSelectionMode === 'vertex' && selectedComponentIds.size < 2) {
          showToast('Selecciona al menos 2 vértices conectados para subdividir');
          return;
        }
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'subdivide',
            params: { cuts: 1, smoothness: 0, fractal: 0 },
          },
        });
      } else if (type === 'bevel') {
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'bevel',
            params: { width: 0.2, segments: 1, profile: 0.5, clampOverlap: true },
          },
        });
      } else if (type === 'merge') {
        const vertIds = mesh.getVertexIdsFromSelection(
          editSelectionMode,
          selectedComponentIds,
        );
        if (vertIds.size < 2) {
          showToast('Selecciona al menos 2 vértices para fusionar');
          return;
        }
        const centroid = mesh.computeCentroid(vertIds) ?? [0, 0, 0];
        setOperatorSession({
          objectId: selectedObject.id,
          baseMesh: selectedObject.mesh,
          baseSelectionMode: editSelectionMode,
          baseSelectedIds: baseIds,
          config: {
            type: 'merge',
            params: { mode: 'center', cursorPosition: centroid },
          },
        });
      }
    },
    [editSelectionMode, selectedComponentIds, selectedObject, showToast, workMode],
  );

  const updateOperatorConfig = useCallback((config: EditOperatorParams) => {
    setOperatorSession((prev) => (prev ? { ...prev, config } : null));
  }, []);

  const pickLoopCutEdge = useCallback(
    (edgeId: string | null) => {
      if (!operatorSession || operatorSession.config.type !== 'loop_cut') return;
      if (!edgeId) return;
      const mesh = EditableMesh.fromJSON(operatorSession.baseMesh);
      const ring = findEdgeLoopRing(mesh, edgeId);
      if (!ring || ring.quadSteps.length === 0) {
        showToast(
          'Esta arista no pertenece a un bucle de caras cuadrangulares compatible',
        );
        return;
      }
      setOperatorSession((prev) =>
        prev && prev.config.type === 'loop_cut'
          ? {
              ...prev,
              config: {
                type: 'loop_cut',
                params: { ...prev.config.params, edgeId },
              },
            }
          : prev,
      );
    },
    [operatorSession, showToast],
  );

  const operatorPreview = useMemo(() => {
    if (!operatorSession) {
      return {
        previewMesh: null as SerializedEditableMesh | null,
        previewSelectedIds: null as Set<string> | null,
        loopCutSegments: [] as [Vec3, Vec3][],
        loopCutError: null as string | null,
      };
    }

    const baseMesh = EditableMesh.fromJSON(operatorSession.baseMesh);
    const baseSel = new Set(operatorSession.baseSelectedIds);
    const mode = operatorSession.baseSelectionMode;
    const cfg = operatorSession.config;

    if (cfg.type === 'loop_cut') {
      if (!cfg.params.edgeId) {
        return {
          previewMesh: null,
          previewSelectedIds: null,
          loopCutSegments: [],
          loopCutError: 'No se encontró un recorrido de aristas compatible.',
        };
      }
      const ring = findEdgeLoopRing(baseMesh, cfg.params.edgeId);
      if (!ring || ring.quadSteps.length === 0) {
        return {
          previewMesh: null,
          previewSelectedIds: null,
          loopCutSegments: [],
          loopCutError: 'La topología actual no forma un bucle cuadrangular.',
        };
      }
      const segments = computeLoopCutPreviewSegments(
        baseMesh,
        ring,
        cfg.params.cuts,
        cfg.params.slide,
      );
      return {
        previewMesh: null,
        previewSelectedIds: null,
        loopCutSegments: segments,
        loopCutError: null,
      };
    }

    let res;
    if (cfg.type === 'extrude') {
      res = extrudeMesh(baseMesh, mode, baseSel, cfg.params);
    } else if (cfg.type === 'inset') {
      res = insetFacesMesh(baseMesh, mode, baseSel, cfg.params);
    } else if (cfg.type === 'subdivide') {
      res = subdivideMesh(baseMesh, mode, baseSel, cfg.params);
    } else if (cfg.type === 'bevel') {
      res = bevelMesh(baseMesh, mode, baseSel, cfg.params);
    } else {
      res = mergeVerticesMesh(baseMesh, mode, baseSel, cfg.params);
    }

    return {
      previewMesh: res.mesh.toJSON(),
      previewSelectedIds: res.nextSelectedIds,
      loopCutSegments: [] as [Vec3, Vec3][],
      loopCutError: null,
    };
  }, [operatorSession]);

  const confirmEditOperator = useCallback(() => {
    if (!operatorSession) return;
    const baseMesh = EditableMesh.fromJSON(operatorSession.baseMesh);
    const cfg = operatorSession.config;

    let finalMesh: EditableMesh;
    let nextSelected: Set<string>;
    let nextMode: EditSelectionMode = operatorSession.baseSelectionMode;

    if (cfg.type === 'loop_cut') {
      const { result, error } = loopCutMesh(baseMesh, cfg.params);
      if (error) {
        showToast(error);
        return;
      }
      finalMesh = result.mesh;
      nextSelected = result.nextSelectedIds;
      nextMode = 'edge';
    } else if (operatorPreview.previewMesh) {
      finalMesh = EditableMesh.fromJSON(operatorPreview.previewMesh);
      nextSelected = operatorPreview.previewSelectedIds ?? new Set();
    } else {
      setOperatorSession(null);
      return;
    }

    const snapshot = makeSnapshot();
    snapshot.scenes = snapshot.scenes.map((s) =>
      s.id === snapshot.activeSceneId
        ? {
            ...s,
            objects: s.objects.map((o) =>
              o.id === operatorSession.objectId
                ? { ...o, mesh: operatorSession.baseMesh }
                : o,
            ),
          }
        : s,
    );
    snapshot.editSelectionMode = operatorSession.baseSelectionMode;
    snapshot.selectedComponentIds = [...operatorSession.baseSelectedIds];
    pushHistory(snapshot);

    finalMesh.clearCustomNormals();
    const serialized = finalMesh.toJSON();
    setProject((p) =>
      updateActiveScene(p, (scene) => ({
        ...scene,
        objects: scene.objects.map((o) =>
          o.id === operatorSession.objectId ? { ...o, mesh: serialized } : o,
        ),
      })),
    );
    setEditSelectionMode(nextMode);
    setSelectedComponentIds(nextSelected);
    setOperatorSession(null);
    setHasUnsavedChanges(true);
    setMeshRevision((r) => r + 1);
  }, [makeSnapshot, operatorPreview, operatorSession, pushHistory, showToast]);

  const cancelEditOperator = useCallback(() => {
    setOperatorSession(null);
    setMeshRevision((r) => r + 1);
  }, []);

  const executeContextualDelete = useCallback(
    (action: DeleteActionType) => {
      if (!selectedObject || workMode !== 'edit') return;
      if (selectedComponentIds.size === 0) {
        showToast('No hay componentes seleccionados');
        return;
      }
      setOperatorSession(null);
      pushHistory(makeSnapshot());
      const mesh = EditableMesh.fromJSON(selectedObject.mesh);
      const res = applyDeleteAction(
        mesh,
        editSelectionMode,
        selectedComponentIds,
        action,
      );
      res.mesh.clearCustomNormals();
      const updated = res.mesh.toJSON();
      setProject((p) =>
        updateActiveScene(p, (scene) => ({
          ...scene,
          objects: scene.objects.map((o) =>
            o.id === selectedObject.id ? { ...o, mesh: updated } : o,
          ),
        })),
      );
      setSelectedComponentIds(res.nextSelectedIds);
      setHasUnsavedChanges(true);
      setMeshRevision((r) => r + 1);
    },
    [
      editSelectionMode,
      makeSnapshot,
      pushHistory,
      selectedComponentIds,
      selectedObject,
      showToast,
      workMode,
    ],
  );

  const executeFillSelection = useCallback(() => {
    if (!selectedObject || workMode !== 'edit') return;
    if (selectedObject.locked) {
      showToast('El objeto está bloqueado');
      return;
    }
    if (selectedComponentIds.size === 0) {
      showToast('Selecciona al menos 2 vértices o aristas para rellenar');
      return;
    }
    setOperatorSession(null);
    const mesh = EditableMesh.fromJSON(selectedObject.mesh);
    const { result, message } = fillMesh(
      mesh,
      editSelectionMode,
      selectedComponentIds,
    );
    if (message) {
      showToast(message);
      return;
    }
    pushHistory(makeSnapshot());
    result.mesh.clearCustomNormals();
    const updated = result.mesh.toJSON();
    setProject((p) =>
      updateActiveScene(p, (scene) => ({
        ...scene,
        objects: scene.objects.map((o) =>
          o.id === selectedObject.id ? { ...o, mesh: updated } : o,
        ),
      })),
    );
    setSelectedComponentIds(result.nextSelectedIds);
    setHasUnsavedChanges(true);
    setMeshRevision((r) => r + 1);
    showToast('Geometría rellenada');
  }, [
    editSelectionMode,
    makeSnapshot,
    pushHistory,
    selectedComponentIds,
    selectedObject,
    showToast,
    workMode,
  ]);

  const executeQuickDissolve = useCallback(() => {
    const action: DeleteActionType =
      editSelectionMode === 'vertex'
        ? 'dissolve_vertices'
        : editSelectionMode === 'edge'
          ? 'dissolve_edges'
          : 'dissolve_faces';
    executeContextualDelete(action);
  }, [editSelectionMode, executeContextualDelete]);

  // Rendered objects & selection include live operator preview when active
  const renderedObjects = useMemo(() => {
    if (!operatorSession || !operatorPreview.previewMesh) {
      return activeObjects;
    }
    return activeObjects.map((o) =>
      o.id === operatorSession.objectId
        ? { ...o, mesh: operatorPreview.previewMesh! }
        : o,
    );
  }, [activeObjects, operatorPreview.previewMesh, operatorSession]);

  const renderedScenes = useMemo(() => {
    if (!operatorSession || !operatorPreview.previewMesh) {
      return project.scenes;
    }
    return project.scenes.map((scene) =>
      scene.id === project.activeSceneId
        ? { ...scene, objects: renderedObjects }
        : scene,
    );
  }, [
    operatorPreview.previewMesh,
    operatorSession,
    project.activeSceneId,
    project.scenes,
    renderedObjects,
  ]);

  const renderedSelectedObject = useMemo(
    () => renderedObjects.find((o) => o.id === selectedObjectId) ?? null,
    [renderedObjects, selectedObjectId],
  );

  const renderedSelectedComponentIds = useMemo(
    () => operatorPreview.previewSelectedIds ?? selectedComponentIds,
    [operatorPreview.previewSelectedIds, selectedComponentIds],
  );

  return {
    project,
    scenes: renderedScenes,
    activeScene,
    activeSceneId: activeScene.id,
    activeCollectionId: activeScene.activeCollectionId,
    renderedObjects,
    savedProjects,
    hasUnsavedChanges,
    selectedObject: renderedSelectedObject,
    selectedObjectId,
    workMode,
    editSelectionMode,
    selectedComponentIds: renderedSelectedComponentIds,
    activeTool,
    axisConstraint,
    projection,
    settings,
    meshRevision,
    toastMessage,
    screenShiftActive,
    canUndo,
    canRedo,
    operatorSession,
    loopCutPreviewSegments: operatorPreview.loopCutSegments,
    setActiveTool,
    setAxisConstraint,
    setProjection,
    setProjectName,
    saveProject,
    createProject,
    openProject,
    removeSavedProject,
    addPrimitive,
    selectObject,
    selectObjectInScene,
    toggleWorkMode,
    changeEditSelectionMode,
    updateObjectTransform,
    commitObjectTransformFromGizmo,
    commitMeshEditFromGizmo,
    renameObject,
    toggleObjectVisibility,
    toggleObjectLock,
    duplicateSelectedObject,
    duplicateObjectById,
    deleteObject,
    createScene,
    switchScene,
    renameScene,
    deleteScene,
    createCollection,
    selectCollection,
    renameCollection,
    toggleCollectionExpanded,
    deleteCollection,
    moveObjectToCollection,
    importObjParts,
    importStlResult,
    addReferenceImage,
    updateReferenceImageProps,
    showToast,
    selectAllEditComponents,
    deselectAllEditComponents,
    deleteSelectedEditComponents,
    executeContextualDelete,
    executeFillSelection,
    executeQuickDissolve,
    selectComponentFromViewport,
    toggleScreenShift,
    setScreenShiftActive,
    updateSettings,
    updateTouchSettings,
    updateTouchModifier,
    updateRadialSlot,
    resetRadialSlot,
    resetRadialLayout,
    resetTouchSettings,
    updateSelectedVerticesPosition,
    startEditOperator,
    updateOperatorConfig,
    pickLoopCutEdge,
    confirmEditOperator,
    cancelEditOperator,
    undo,
    redo,
  };
}
