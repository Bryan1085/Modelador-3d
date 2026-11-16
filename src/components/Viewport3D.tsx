import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowBigUpDash,
  Camera,
  Eye,
  Focus,
  Grid3X3,
} from 'lucide-react';
import { EditableMesh, Vec3 } from '../core/mesh/EditableMesh';
import { DeleteActionType } from '../core/mesh/advancedOperations';
import { EditSelectionMode } from '../core/mesh/operations';
import { PrimitiveType } from '../core/mesh/primitives';
import {
  AxisConstraint,
  CameraProjection,
  ModelerSettings,
  ObjectTransform,
  SceneObjectData,
  TouchControlSettings,
  TouchModifierState,
  TransformTool,
  WorkMode,
} from '../core/project/types';
import {
  RadialActionId,
  RadialWorkMode,
} from '../core/radial/radialActions';
import { EMPTY_MODIFIER_STATE } from '../engine/TouchGestureManager';
import {
  CameraPreset,
  CameraQuaternionTuple,
  ViewportContextInfo,
  ViewportEngine,
} from '../engine/ViewportEngine';
import {
  EditOperatorParams,
  EditOperatorSession,
  EditOperatorType,
} from '../state/useModelerStore';
import { AxisGizmoHandle, AxisGizmoWidget } from './AxisGizmoWidget';
import { EditOperatorBar } from './EditOperatorBar';
import { FloatingRadialMenu } from './FloatingRadialMenu';
import {
  ContextMenuState,
  ViewportContextMenu,
} from './ViewportContextMenu';

interface Viewport3DProps {
  objects: SceneObjectData[];
  selectedObject: SceneObjectData | null;
  selectedObjectId: string | null;
  workMode: WorkMode;
  editSelectionMode: EditSelectionMode;
  selectedComponentIds: Set<string>;
  activeTool: TransformTool;
  axisConstraint: AxisConstraint;
  projection: CameraProjection;
  settings: ModelerSettings;
  meshRevision: number;
  toastMessage: string | null;
  screenShiftActive: boolean;
  operatorSession: EditOperatorSession | null;
  loopCutPreviewSegments: [Vec3, Vec3][];
  canUndo: boolean;
  canRedo: boolean;
  onSelectObject: (id: string | null) => void;
  onSelectComponent: (
    id: string | null,
    additive: boolean,
    addOnly?: boolean,
  ) => void;
  onPickLoopCutEdge: (edgeId: string | null) => void;
  onTwoFingerUndo: () => void;
  onThreeFingerRedo: () => void;
  onUndo: () => void;
  onRedo: () => void;
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
  onUpdateOperatorConfig: (config: EditOperatorParams) => void;
  onConfirmOperator: () => void;
  onCancelOperator: () => void;
  onChangeAxisConstraint: (axis: AxisConstraint) => void;
  onToggleProjection: (projection: CameraProjection) => void;
  onToggleXray: () => void;
  onToggleGrid: () => void;
  onToggleMultiSelectTouch: () => void;
  onToggleScreenShift: () => void;
  onUpdateTouchSettings: (patch: Partial<TouchControlSettings>) => void;
  onUpdateRadialSlot: (
    mode: RadialWorkMode,
    slotIndex: number,
    actionId: RadialActionId | null,
  ) => void;
  onResetRadialSlot: (mode: RadialWorkMode, slotIndex: number) => void;
  onResetRadialLayout: (mode: RadialWorkMode) => void;
  onAddPrimitive: (type: PrimitiveType) => void;
  onSelectTool: (tool: TransformTool) => void;
  onDuplicateObject: () => void;
  onHideObject: (id: string) => void;
  onDeleteObject: () => void;
  onToggleWorkMode: (mode: WorkMode) => void;
  onChangeEditSelectionMode: (mode: EditSelectionMode) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onStartOperator: (type: EditOperatorType) => void;
  onFillSelection: () => void;
  onQuickDissolve: () => void;
  onExecuteContextualDelete: (action: DeleteActionType) => void;
  onSaveProject: () => void;
  onOpenSettings: () => void;
}

export const Viewport3D: React.FC<Viewport3DProps> = ({
  objects,
  selectedObject,
  selectedObjectId,
  workMode,
  editSelectionMode,
  selectedComponentIds,
  activeTool,
  axisConstraint,
  projection,
  settings,
  meshRevision,
  toastMessage,
  screenShiftActive,
  operatorSession,
  loopCutPreviewSegments,
  canUndo,
  canRedo,
  onSelectObject,
  onSelectComponent,
  onPickLoopCutEdge,
  onTwoFingerUndo,
  onThreeFingerRedo,
  onUndo,
  onRedo,
  onLiveObjectTransform,
  onCommitObjectTransform,
  onCommitMeshEdit,
  onUpdateOperatorConfig,
  onConfirmOperator,
  onCancelOperator,
  onChangeAxisConstraint,
  onToggleProjection,
  onToggleXray,
  onToggleGrid,
  onToggleMultiSelectTouch,
  onToggleScreenShift,
  onUpdateTouchSettings,
  onUpdateRadialSlot,
  onResetRadialSlot,
  onResetRadialLayout,
  onAddPrimitive,
  onSelectTool,
  onDuplicateObject,
  onHideObject,
  onDeleteObject,
  onToggleWorkMode,
  onChangeEditSelectionMode,
  onSelectAll,
  onDeselectAll,
  onStartOperator,
  onFillSelection,
  onQuickDissolve,
  onExecuteContextualDelete,
  onSaveProject,
  onOpenSettings,
}) => {
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ViewportEngine | null>(null);
  const gizmoRef = useRef<AxisGizmoHandle | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [gestureModifiers, setGestureModifiers] =
    useState<TouchModifierState>(EMPTY_MODIFIER_STATE);

  const handleSelectCameraPreset = useCallback(
    (preset: CameraPreset) => {
      if (
        preset === 'front' ||
        preset === 'back' ||
        preset === 'top' ||
        preset === 'bottom' ||
        preset === 'right' ||
        preset === 'left'
      ) {
        if (projection !== 'orthographic') {
          engineRef.current?.switchProjection('orthographic');
          onToggleProjection('orthographic');
        }
      } else if (preset === 'iso') {
        if (projection !== 'perspective') {
          engineRef.current?.switchProjection('perspective');
          onToggleProjection('perspective');
        }
      }
      engineRef.current?.setCameraPreset(preset);
    },
    [onToggleProjection, projection],
  );

  const handleOpenContextMenu = useCallback(
    (info: ViewportContextInfo) => {
      if (workMode === 'object') {
        if (info.hitObjectId && info.hitObjectId !== selectedObjectId) {
          onSelectObject(info.hitObjectId);
        }
      } else if (
        info.hitComponentId &&
        !selectedComponentIds.has(info.hitComponentId)
      ) {
        onSelectComponent(
          info.hitComponentId,
          Boolean(settings.multiSelectTouch || screenShiftActive),
          screenShiftActive,
        );
      }
      setContextMenu({
        clientX: info.clientX,
        clientY: info.clientY,
        hitObjectId: info.hitObjectId,
        hitComponentId: info.hitComponentId,
      });
    },
    [
      onSelectComponent,
      onSelectObject,
      screenShiftActive,
      selectedComponentIds,
      selectedObjectId,
      settings.multiSelectTouch,
      workMode,
    ],
  );

  const callbacksRef = useRef({
    onSelectObject,
    onSelectComponent,
    onPickLoopCutEdge,
    onTwoFingerUndo,
    onThreeFingerRedo,
    onOpenContextMenu: handleOpenContextMenu,
    onModifierStateChange: (mods: TouchModifierState) =>
      setGestureModifiers(mods),
    onCameraPoseChange: (quat: CameraQuaternionTuple) => {
      gizmoRef.current?.updateOrientation(quat);
    },
    onLiveObjectTransform,
    onCommitObjectTransform,
    onCommitMeshEdit,
  });
  callbacksRef.current = {
    onSelectObject,
    onSelectComponent,
    onPickLoopCutEdge,
    onTwoFingerUndo,
    onThreeFingerRedo,
    onOpenContextMenu: handleOpenContextMenu,
    onModifierStateChange: (mods: TouchModifierState) =>
      setGestureModifiers(mods),
    onCameraPoseChange: (quat: CameraQuaternionTuple) => {
      gizmoRef.current?.updateOrientation(quat);
    },
    onLiveObjectTransform,
    onCommitObjectTransform,
    onCommitMeshEdit,
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new ViewportEngine(container, {
      onSelectObject: (id) => callbacksRef.current.onSelectObject(id),
      onSelectComponent: (id, additive, addOnly) =>
        callbacksRef.current.onSelectComponent(id, additive, addOnly),
      onPickLoopCutEdge: (edgeId) =>
        callbacksRef.current.onPickLoopCutEdge(edgeId),
      onTwoFingerUndo: () => callbacksRef.current.onTwoFingerUndo(),
      onThreeFingerRedo: () => callbacksRef.current.onThreeFingerRedo(),
      onOpenContextMenu: (info) =>
        callbacksRef.current.onOpenContextMenu(info),
      onModifierStateChange: (mods) =>
        callbacksRef.current.onModifierStateChange(mods),
      onCameraPoseChange: (quat) =>
        callbacksRef.current.onCameraPoseChange(quat),
      onLiveObjectTransform: (id, transform) =>
        callbacksRef.current.onLiveObjectTransform(id, transform),
      onCommitObjectTransform: (id, before, after) =>
        callbacksRef.current.onCommitObjectTransform(id, before, after),
      onCommitMeshEdit: (id, before, after) =>
        callbacksRef.current.onCommitMeshEdit(id, before, after),
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.syncScene({
      objects,
      selectedObjectId,
      workMode,
      editSelectionMode,
      selectedComponentIds,
      activeTool,
      axisConstraint,
      projection,
      settings,
      meshRevision,
      suppressGizmo: Boolean(operatorSession),
      loopCutPreviewMode: operatorSession?.config.type === 'loop_cut',
      loopCutPreviewSegments,
    });
  }, [
    objects,
    selectedObjectId,
    workMode,
    editSelectionMode,
    selectedComponentIds,
    activeTool,
    axisConstraint,
    projection,
    settings,
    meshRevision,
    operatorSession,
    loopCutPreviewSegments,
  ]);

  useEffect(() => {
    setContextMenu(null);
    if (workMode !== 'edit') {
      setGestureModifiers(EMPTY_MODIFIER_STATE);
    }
  }, [workMode, operatorSession]);

  const topologyStats = useMemo(() => {
    if (selectedObject) {
      return {
        vertices: selectedObject.mesh.vertices.length,
        edges: selectedObject.mesh.edges.length,
        faces: selectedObject.mesh.faces.length,
      };
    }
    return objects.reduce(
      (acc, obj) => {
        acc.vertices += obj.mesh.vertices.length;
        acc.edges += obj.mesh.edges.length;
        acc.faces += obj.mesh.faces.length;
        return acc;
      },
      { vertices: 0, edges: 0, faces: 0 },
    );
  }, [objects, selectedObject]);

  const editSelectionDetails = useMemo(() => {
    if (workMode !== 'edit' || !selectedObject) {
      return { vertexCount: 0, canInset: false };
    }
    const editable = EditableMesh.fromJSON(selectedObject.mesh);
    const verts = editable.getVertexIdsFromSelection(
      editSelectionMode,
      selectedComponentIds,
    );
    const canInset =
      (editSelectionMode === 'face' && selectedComponentIds.size > 0) ||
      editable.faces.some((f) => f.vertexIds.every((vid) => verts.has(vid)));
    return { vertexCount: verts.size, canInset };
  }, [editSelectionMode, selectedComponentIds, selectedObject, workMode]);

  const modeLabel = useMemo(() => {
    if (workMode === 'object') return 'Modo Objeto';
    const sub =
      editSelectionMode === 'vertex'
        ? 'Vértices'
        : editSelectionMode === 'edge'
          ? 'Aristas'
          : 'Caras';
    return `Modo Edición · ${sub}`;
  }, [editSelectionMode, workMode]);

  const shiftActive =
    workMode === 'edit' && (gestureModifiers.shift || screenShiftActive);
  const showScreenShiftBtn =
    workMode === 'edit' &&
    settings.touch.modifiers.shift.enabled &&
    settings.touch.modifiers.shift.showScreenButton;

  return (
    <main className="relative flex-1 min-w-0 h-full flex flex-col bg-[#1d1f24] overflow-hidden">
      {/* Dedicated WebGL Mount Container */}
      <div
        ref={viewportContainerRef}
        className="relative flex-1 min-h-0 w-full"
      >
        <div ref={mountRef} className="w-full h-full" />

        {/* Top-Left Floating Axis Constraint, X-Ray & On-Screen SHIFT */}
        <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-1.5 pointer-events-auto">
          <div className="flex items-center p-0.5 rounded-md bg-[#181a1f]/95 border border-[#2f333d]">
            {(
              [
                { id: 'free', label: 'Libre', color: 'text-[#e4e6eb]' },
                { id: 'x', label: 'X', color: 'text-[#e05252]' },
                { id: 'y', label: 'Y', color: 'text-[#52b852]' },
                { id: 'z', label: 'Z', color: 'text-[#48bce8]' },
              ] as const
            ).map((ax) => {
              const active = axisConstraint === ax.id;
              return (
                <button
                  key={ax.id}
                  type="button"
                  onClick={() => onChangeAxisConstraint(ax.id)}
                  className={`h-8 px-2.5 rounded text-xs font-semibold transition-colors ${
                    active
                      ? `bg-[#2c313b] ${ax.color} border border-[#464c5a]`
                      : 'text-[#9ca3af] hover:text-[#e4e6eb] border border-transparent'
                  }`}
                >
                  {ax.label}
                </button>
              );
            })}
          </div>

          {workMode === 'edit' && (
            <button
              type="button"
              onClick={onToggleXray}
              className={`h-9 px-2.5 rounded-md border text-xs font-medium flex items-center gap-1.5 transition-colors ${
                settings.xrayEditMode
                  ? 'bg-[#2c313b] border-[#ff9900]/50 text-[#ff9900]'
                  : 'bg-[#181a1f]/95 border-[#2f333d] text-[#b4bac4] hover:text-white'
              }`}
              title="Alternar Rayos X para seleccionar componentes posteriores"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Rayos X</span>
            </button>
          )}

          {showScreenShiftBtn && (
            <button
              type="button"
              onClick={onToggleScreenShift}
              aria-pressed={screenShiftActive}
              className={`h-9 px-2.5 rounded-md border text-xs font-semibold flex items-center gap-1 transition-colors ${
                shiftActive
                  ? 'bg-[#2a1f10] border-[#ff9900] text-[#ffb84d]'
                  : 'bg-[#181a1f]/95 border-[#2f333d] text-[#b4bac4] hover:text-white'
              }`}
              title="Alternar modificador SHIFT en pantalla para sumar elementos"
            >
              <ArrowBigUpDash className="w-3.5 h-3.5" />
              <span>SHIFT</span>
            </button>
          )}
        </div>

        {/* Discrete Active Modifier Indicator */}
        {shiftActive && (
          <div className="absolute top-14 sm:top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-md bg-[#2a1f10] border border-[#ff9900] text-[#ffb84d] text-[11px] font-bold tracking-wide shadow-lg pointer-events-none flex items-center gap-1.5">
            <ArrowBigUpDash className="w-3.5 h-3.5 text-[#ff9900]" />
            <span>SHIFT ACTIVO</span>
          </div>
        )}

        {/* Top-Right Floating Camera & View Controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-wrap items-center justify-end gap-1.5 pointer-events-auto">
          <button
            type="button"
            onClick={() =>
              onToggleProjection(
                projection === 'perspective' ? 'orthographic' : 'perspective',
              )
            }
            className="h-9 px-2.5 rounded-md bg-[#181a1f]/95 hover:bg-[#23262e] border border-[#2f333d] text-xs font-medium text-[#e4e6eb] flex items-center gap-1.5 transition-colors"
            title="Cambiar entre vista Perspectiva y Ortográfica"
          >
            {projection === 'perspective' ? (
              <Camera className="w-3.5 h-3.5 text-[#ff9900]" />
            ) : (
              <Grid3X3 className="w-3.5 h-3.5 text-[#60a5fa]" />
            )}
            <span>{projection === 'perspective' ? 'Persp.' : 'Orto.'}</span>
          </button>

          <div className="hidden sm:flex items-center p-0.5 rounded-md bg-[#181a1f]/95 border border-[#2f333d]">
            {(
              [
                { id: 'front', label: 'Frontal' },
                { id: 'top', label: 'Sup.' },
                { id: 'right', label: 'Der.' },
                { id: 'left', label: 'Izq.' },
                { id: 'iso', label: '3D' },
              ] as const
            ).map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => handleSelectCameraPreset(view.id)}
                className="h-8 px-2 rounded text-[11px] font-medium text-[#b4bac4] hover:text-white hover:bg-[#262a33] transition-colors"
              >
                {view.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => engineRef.current?.setCameraPreset('focus')}
            className="h-9 px-2.5 rounded-md bg-[#181a1f]/95 hover:bg-[#23262e] border border-[#2f333d] text-xs font-medium text-[#d1d5db] flex items-center gap-1.5 transition-colors"
            title="Encuadrar objeto seleccionado"
          >
            <Focus className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Encuadrar</span>
          </button>
        </div>

        {/* Interactive Blender-style Z-Up Axis Gizmo */}
        <div className="absolute top-14 right-3 z-10 pointer-events-none">
          <AxisGizmoWidget
            ref={gizmoRef}
            onSelectPreset={handleSelectCameraPreset}
          />
        </div>

        {/* Floating Draggable Button & Customizable Radial Menu */}
        {settings.touch.floatingMenuEnabled && !operatorSession && (
          <FloatingRadialMenu
            containerRef={viewportContainerRef}
            workMode={workMode}
            editSelectionMode={editSelectionMode}
            activeTool={activeTool}
            axisConstraint={axisConstraint}
            projection={projection}
            xrayEditMode={settings.xrayEditMode}
            showGrid={settings.showGrid}
            multiSelectTouch={settings.multiSelectTouch}
            screenShiftActive={screenShiftActive}
            hasSelectedObject={Boolean(selectedObject)}
            canEditSelected={Boolean(
              selectedObject &&
                selectedObject.objectType === 'mesh' &&
                !selectedObject.locked,
            )}
            hasSelectedComponents={selectedComponentIds.size > 0}
            canUndo={canUndo}
            canRedo={canRedo}
            corner={settings.touch.floatingMenuCorner}
            size={settings.touch.floatingMenuSize}
            customPos={settings.touch.floatingMenuCustomPos}
            radialLayouts={settings.touch.radialLayouts}
            onUpdateCustomPos={(pos) =>
              onUpdateTouchSettings({ floatingMenuCustomPos: pos })
            }
            onUpdateRadialSlot={onUpdateRadialSlot}
            onResetRadialSlot={onResetRadialSlot}
            onResetRadialLayout={onResetRadialLayout}
            onAddPrimitive={onAddPrimitive}
            onSelectTool={onSelectTool}
            onChangeAxisConstraint={onChangeAxisConstraint}
            onDuplicateObject={onDuplicateObject}
            onDeleteObject={onDeleteObject}
            onSetCameraPreset={handleSelectCameraPreset}
            onToggleProjection={() =>
              onToggleProjection(
                projection === 'perspective' ? 'orthographic' : 'perspective',
              )
            }
            onToggleWorkMode={onToggleWorkMode}
            onChangeEditSelectionMode={onChangeEditSelectionMode}
            onToggleXray={onToggleXray}
            onToggleGrid={onToggleGrid}
            onToggleMultiSelectTouch={onToggleMultiSelectTouch}
            onToggleScreenShift={onToggleScreenShift}
            onUndo={onUndo}
            onRedo={onRedo}
            onStartOperator={onStartOperator}
            onFillSelection={onFillSelection}
            onQuickDissolve={onQuickDissolve}
            onExecuteContextualDelete={onExecuteContextualDelete}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
            onSaveProject={onSaveProject}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Long-Press Contextual Menu */}
        {contextMenu && (
          <ViewportContextMenu
            menu={contextMenu}
            workMode={workMode}
            editSelectionMode={editSelectionMode}
            selectedObjectName={selectedObject?.name ?? null}
            hasSelectedObject={
              workMode === 'object'
                ? Boolean(contextMenu.hitObjectId)
                : Boolean(selectedObject)
            }
            canEditSelected={Boolean(
              selectedObject &&
                selectedObject.objectType === 'mesh' &&
                !selectedObject.locked,
            )}
            selectedCount={selectedComponentIds.size}
            selectedVertexCount={editSelectionDetails.vertexCount}
            canInset={editSelectionDetails.canInset}
            canUndo={canUndo}
            canRedo={canRedo}
            onClose={() => setContextMenu(null)}
            onAddPrimitive={onAddPrimitive}
            onSelectTool={onSelectTool}
            onToggleWorkMode={onToggleWorkMode}
            onChangeEditSelectionMode={onChangeEditSelectionMode}
            onDuplicateObject={onDuplicateObject}
            onHideObject={() => {
              if (selectedObjectId) onHideObject(selectedObjectId);
            }}
            onDeleteObject={onDeleteObject}
            onFocusCamera={() => engineRef.current?.setCameraPreset('focus')}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
            onStartOperator={onStartOperator}
            onFillSelection={onFillSelection}
            onExecuteContextualDelete={onExecuteContextualDelete}
            onUndo={onUndo}
            onRedo={onRedo}
          />
        )}

        {/* Live Edit Mode Operator Parameter Bar */}
        {operatorSession && (
          <EditOperatorBar
            session={operatorSession}
            onUpdateConfig={onUpdateOperatorConfig}
            onConfirm={onConfirmOperator}
            onCancel={onCancelOperator}
          />
        )}

        {/* Transient Action Feedback Toast */}
        {toastMessage && (
          <div
            className={`absolute ${
              operatorSession ? 'bottom-28' : 'bottom-4'
            } left-1/2 -translate-x-1/2 z-20 px-3.5 py-2 rounded-md bg-[#181a1f] border border-[#3a3f4b] text-xs font-medium text-[#f3f4f6] shadow-lg pointer-events-none`}
          >
            {toastMessage}
          </div>
        )}
      </div>

      {/* Bottom Topology Information Bar */}
      <footer className="h-8 shrink-0 bg-[#15171b] border-t border-[#2b2e36] px-3 flex items-center justify-between gap-4 text-[11px] text-[#a1a7b3] overflow-x-auto cad-scroll">
        <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
          <span className="font-semibold text-[#e4e6eb]">
            {selectedObject ? selectedObject.name : 'Sin selección'}
          </span>
          <span aria-hidden="true">·</span>
          <span className={workMode === 'edit' ? 'text-[#ff9900] font-medium' : ''}>
            {modeLabel}
          </span>
          {workMode === 'edit' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">
                Selec.: {selectedComponentIds.size}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 font-mono-tabular whitespace-nowrap shrink-0">
          {selectedObject?.objectType === 'reference_image' &&
          selectedObject.referenceImage ? (
            <>
              <span>Referencia de imagen</span>
              <span aria-hidden="true">·</span>
              <span>
                {selectedObject.referenceImage.naturalWidth}×
                {selectedObject.referenceImage.naturalHeight} px
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Opacidad:{' '}
                {Math.round(selectedObject.referenceImage.opacity * 100)}%
              </span>
            </>
          ) : (
            <>
              <span>Vértices: {topologyStats.vertices}</span>
              <span aria-hidden="true">·</span>
              <span>Aristas: {topologyStats.edges}</span>
              <span aria-hidden="true">·</span>
              <span>Caras: {topologyStats.faces}</span>
            </>
          )}
        </div>
      </footer>
    </main>
  );
};
