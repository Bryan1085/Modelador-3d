import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  Box,
  Circle,
  Cylinder,
  Globe,
  Plus,
  Pyramid,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { DeleteActionType } from '../core/mesh/advancedOperations';
import { EditSelectionMode } from '../core/mesh/operations';
import { PrimitiveType } from '../core/mesh/primitives';
import {
  AxisConstraint,
  CameraProjection,
  FloatingMenuCorner,
  FloatingMenuSize,
  TransformTool,
  WorkMode,
} from '../core/project/types';
import {
  RADIAL_ACTION_MAP,
  RadialActionDefinition,
  RadialActionId,
  RadialMenuLayouts,
  RadialWorkMode,
} from '../core/radial/radialActions';
import { CameraPreset } from '../engine/ViewportEngine';
import { EditOperatorType } from '../state/useModelerStore';
import { RadialActionIcon } from './RadialActionIcon';
import { RadialSlotEditorModal } from './RadialSlotEditorModal';

interface FloatingRadialMenuProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  workMode: WorkMode;
  editSelectionMode: EditSelectionMode;
  activeTool: TransformTool;
  axisConstraint: AxisConstraint;
  projection: CameraProjection;
  xrayEditMode: boolean;
  showGrid: boolean;
  multiSelectTouch: boolean;
  screenShiftActive: boolean;
  hasSelectedObject: boolean;
  canEditSelected: boolean;
  hasSelectedComponents: boolean;
  canUndo: boolean;
  canRedo: boolean;
  corner: FloatingMenuCorner;
  size: FloatingMenuSize;
  customPos: { xPct: number; yPct: number } | null;
  radialLayouts: RadialMenuLayouts;
  onUpdateCustomPos: (pos: { xPct: number; yPct: number }) => void;
  onUpdateRadialSlot: (
    mode: RadialWorkMode,
    slotIndex: number,
    actionId: RadialActionId | null,
  ) => void;
  onResetRadialSlot: (mode: RadialWorkMode, slotIndex: number) => void;
  onResetRadialLayout: (mode: RadialWorkMode) => void;
  onAddPrimitive: (type: PrimitiveType) => void;
  onSelectTool: (tool: TransformTool) => void;
  onChangeAxisConstraint: (axis: AxisConstraint) => void;
  onDuplicateObject: () => void;
  onDeleteObject: () => void;
  onSetCameraPreset: (preset: CameraPreset) => void;
  onToggleProjection: () => void;
  onToggleWorkMode: (mode: WorkMode) => void;
  onChangeEditSelectionMode: (mode: EditSelectionMode) => void;
  onToggleXray: () => void;
  onToggleGrid: () => void;
  onToggleMultiSelectTouch: () => void;
  onToggleScreenShift: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onStartOperator: (type: EditOperatorType) => void;
  onFillSelection: () => void;
  onQuickDissolve: () => void;
  onExecuteContextualDelete: (action: DeleteActionType) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onSaveProject: () => void;
  onOpenSettings: () => void;
}

const SIZE_PX: Record<FloatingMenuSize, number> = {
  small: 48,
  medium: 56,
  large: 64,
};

const RING_RADIUS: Record<FloatingMenuSize, number> = {
  small: 112,
  medium: 128,
  large: 142,
};

const SLOT_LONG_PRESS_MS = 450;

export const FloatingRadialMenu: React.FC<FloatingRadialMenuProps> = ({
  containerRef,
  workMode,
  editSelectionMode,
  activeTool,
  axisConstraint,
  projection,
  xrayEditMode,
  showGrid,
  multiSelectTouch,
  screenShiftActive,
  hasSelectedObject,
  canEditSelected,
  hasSelectedComponents,
  canUndo,
  canRedo,
  corner,
  size,
  customPos,
  radialLayouts,
  onUpdateCustomPos,
  onUpdateRadialSlot,
  onResetRadialSlot,
  onResetRadialLayout,
  onAddPrimitive,
  onSelectTool,
  onChangeAxisConstraint,
  onDuplicateObject,
  onDeleteObject,
  onSetCameraPreset,
  onToggleProjection,
  onToggleWorkMode,
  onChangeEditSelectionMode,
  onToggleXray,
  onToggleGrid,
  onToggleMultiSelectTouch,
  onToggleScreenShift,
  onUndo,
  onRedo,
  onStartOperator,
  onFillSelection,
  onQuickDissolve,
  onExecuteContextualDelete,
  onSelectAll,
  onDeselectAll,
  onSaveProject,
  onOpenSettings,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showPrimitivePicker, setShowPrimitivePicker] = useState(false);
  const [customizeMode, setCustomizeMode] = useState(false);
  const [editingSlotIndex, setEditingSlotIndex] = useState<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const slotHoldRef = useRef<{
    slotIndex: number;
    pointerId: number;
    startX: number;
    startY: number;
    timer: number | null;
    triggered: boolean;
  } | null>(null);

  const activeRadialMode: RadialWorkMode = workMode;
  const btnSize = SIZE_PX[size];

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setViewportSize({
        width: Math.max(240, el.clientWidth),
        height: Math.max(240, el.clientHeight),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  useEffect(() => {
    setShowPrimitivePicker(false);
  }, [workMode]);

  useEffect(() => {
    return () => {
      if (slotHoldRef.current?.timer != null) {
        window.clearTimeout(slotHoldRef.current.timer);
      }
    };
  }, []);

  const clearSlotHold = () => {
    if (slotHoldRef.current?.timer != null) {
      window.clearTimeout(slotHoldRef.current.timer);
      slotHoldRef.current.timer = null;
    }
  };

  const buttonPos = useMemo(() => {
    const padX = 16;
    const padTop = 62;
    const padBottom = 16;
    const maxX = Math.max(padX, viewportSize.width - btnSize - padX);
    const maxY = Math.max(padTop, viewportSize.height - btnSize - padBottom);

    if (dragPos) {
      return {
        x: Math.max(8, Math.min(viewportSize.width - btnSize - 8, dragPos.x)),
        y: Math.max(8, Math.min(viewportSize.height - btnSize - 8, dragPos.y)),
      };
    }

    if (customPos) {
      return {
        x: Math.max(
          8,
          Math.min(
            viewportSize.width - btnSize - 8,
            customPos.xPct * viewportSize.width - btnSize / 2,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            viewportSize.height - btnSize - 8,
            customPos.yPct * viewportSize.height - btnSize / 2,
          ),
        ),
      };
    }

    switch (corner) {
      case 'top-left':
        return { x: padX, y: padTop };
      case 'top-right':
        return { x: maxX, y: padTop };
      case 'bottom-left':
        return { x: padX, y: maxY };
      case 'bottom-right':
      default:
        return { x: maxX, y: maxY };
    }
  }, [btnSize, corner, customPos, dragPos, viewportSize]);

  const effectiveRadius = useMemo(() => {
    const maxAllowed = Math.min(viewportSize.width, viewportSize.height) / 2 - 54;
    return Math.max(86, Math.min(RING_RADIUS[size], maxAllowed));
  }, [size, viewportSize]);

  const wheelCenter = useMemo(() => {
    const rawCx = buttonPos.x + btnSize / 2;
    const rawCy = buttonPos.y + btnSize / 2;
    const safeMargin = effectiveRadius + 48;
    return {
      x: Math.max(
        safeMargin,
        Math.min(viewportSize.width - safeMargin, rawCx),
      ),
      y: Math.max(
        safeMargin,
        Math.min(viewportSize.height - safeMargin - 16, rawCy),
      ),
    };
  }, [btnSize, buttonPos, effectiveRadius, viewportSize]);

  const quickDeleteAction: DeleteActionType =
    editSelectionMode === 'vertex'
      ? 'delete_vertices'
      : editSelectionMode === 'edge'
        ? 'delete_edges'
        : 'delete_only_faces';

  const getActionMetaState = (
    def: RadialActionDefinition,
  ): { active: boolean; disabled: boolean; label: string } => {
    let active = false;
    let disabled = false;
    let label = def.shortLabel;

    switch (def.id) {
      case 'open_add_menu':
        active = showPrimitivePicker;
        disabled = workMode !== 'object';
        break;
      case 'add_cube':
      case 'add_circle':
      case 'add_uv_sphere':
      case 'add_cylinder':
      case 'add_pyramid':
        disabled = workMode !== 'object';
        break;
      case 'tool_select':
        active = activeTool === 'select';
        break;
      case 'tool_move':
        active = activeTool === 'move';
        break;
      case 'tool_rotate':
        active = activeTool === 'rotate';
        break;
      case 'tool_scale':
        active = activeTool === 'scale';
        break;
      case 'axis_free':
        active = axisConstraint === 'free';
        break;
      case 'axis_x':
        active = axisConstraint === 'x';
        break;
      case 'axis_y':
        active = axisConstraint === 'y';
        break;
      case 'axis_z':
        active = axisConstraint === 'z';
        break;
      case 'duplicate_object':
        disabled = workMode !== 'object' || !hasSelectedObject;
        break;
      case 'delete_contextual':
        disabled =
          workMode === 'object' ? !hasSelectedObject : !hasSelectedComponents;
        break;
      case 'dissolve_quick':
      case 'delete_edges_verts':
      case 'delete_faces_edges':
        disabled = workMode !== 'edit' || !hasSelectedComponents;
        break;
      case 'op_extrude':
      case 'op_inset':
      case 'op_subdivide':
      case 'op_bevel':
      case 'op_loop_cut':
      case 'op_merge':
      case 'fill_mesh':
      case 'select_all':
        disabled = workMode !== 'edit';
        break;
      case 'mode_vertex':
        active = workMode === 'edit' && editSelectionMode === 'vertex';
        disabled = workMode !== 'edit';
        break;
      case 'mode_edge':
        active = workMode === 'edit' && editSelectionMode === 'edge';
        disabled = workMode !== 'edit';
        break;
      case 'mode_face':
        active = workMode === 'edit' && editSelectionMode === 'face';
        disabled = workMode !== 'edit';
        break;
      case 'toggle_multi_select':
        active = multiSelectTouch;
        disabled = workMode !== 'edit';
        break;
      case 'toggle_shift_modifier':
        active = screenShiftActive;
        disabled = workMode !== 'edit';
        break;
      case 'work_object':
        active = workMode === 'object';
        break;
      case 'work_edit':
        active = workMode === 'edit';
        disabled = workMode !== 'edit' && !canEditSelected;
        break;
      case 'toggle_xray':
        active = xrayEditMode;
        disabled = workMode !== 'edit';
        break;
      case 'toggle_grid':
        active = showGrid;
        break;
      case 'toggle_projection':
        label = projection === 'perspective' ? 'Orto.' : 'Persp.';
        break;
      case 'undo':
        disabled = !canUndo;
        break;
      case 'redo':
        disabled = !canRedo;
        break;
      default:
        break;
    }

    return { active, disabled, label };
  };

  const executeRadialAction = (actionId: RadialActionId) => {
    switch (actionId) {
      case 'focus_camera':
        onSetCameraPreset('focus');
        setIsOpen(false);
        break;
      case 'view_iso':
        onSetCameraPreset('iso');
        setIsOpen(false);
        break;
      case 'view_front':
        onSetCameraPreset('front');
        setIsOpen(false);
        break;
      case 'view_top':
        onSetCameraPreset('top');
        setIsOpen(false);
        break;
      case 'view_right':
        onSetCameraPreset('right');
        setIsOpen(false);
        break;
      case 'toggle_projection':
        onToggleProjection();
        setIsOpen(false);
        break;
      case 'select_all':
        onSelectAll();
        setIsOpen(false);
        break;
      case 'deselect_all':
        onDeselectAll();
        setIsOpen(false);
        break;
      case 'mode_vertex':
        onChangeEditSelectionMode('vertex');
        setIsOpen(false);
        break;
      case 'mode_edge':
        onChangeEditSelectionMode('edge');
        setIsOpen(false);
        break;
      case 'mode_face':
        onChangeEditSelectionMode('face');
        setIsOpen(false);
        break;
      case 'toggle_multi_select':
        onToggleMultiSelectTouch();
        setIsOpen(false);
        break;
      case 'toggle_shift_modifier':
        onToggleScreenShift();
        setIsOpen(false);
        break;
      case 'tool_select':
        onSelectTool('select');
        setIsOpen(false);
        break;
      case 'tool_move':
        onSelectTool('move');
        setIsOpen(false);
        break;
      case 'tool_rotate':
        onSelectTool('rotate');
        setIsOpen(false);
        break;
      case 'tool_scale':
        onSelectTool('scale');
        setIsOpen(false);
        break;
      case 'axis_free':
        onChangeAxisConstraint('free');
        setIsOpen(false);
        break;
      case 'axis_x':
        onChangeAxisConstraint('x');
        setIsOpen(false);
        break;
      case 'axis_y':
        onChangeAxisConstraint('y');
        setIsOpen(false);
        break;
      case 'axis_z':
        onChangeAxisConstraint('z');
        setIsOpen(false);
        break;
      case 'open_add_menu':
        setShowPrimitivePicker((prev) => !prev);
        break;
      case 'add_cube':
        onAddPrimitive('cube');
        setIsOpen(false);
        break;
      case 'add_circle':
        onAddPrimitive('circle');
        setIsOpen(false);
        break;
      case 'add_uv_sphere':
        onAddPrimitive('uv_sphere');
        setIsOpen(false);
        break;
      case 'add_cylinder':
        onAddPrimitive('cylinder');
        setIsOpen(false);
        break;
      case 'add_pyramid':
        onAddPrimitive('pyramid');
        setIsOpen(false);
        break;
      case 'fill_mesh':
        onFillSelection();
        setIsOpen(false);
        break;
      case 'op_extrude':
        onStartOperator('extrude');
        setIsOpen(false);
        break;
      case 'op_inset':
        onStartOperator('inset');
        setIsOpen(false);
        break;
      case 'op_subdivide':
        onStartOperator('subdivide');
        setIsOpen(false);
        break;
      case 'op_bevel':
        onStartOperator('bevel');
        setIsOpen(false);
        break;
      case 'op_loop_cut':
        onStartOperator('loop_cut');
        setIsOpen(false);
        break;
      case 'op_merge':
        onStartOperator('merge');
        setIsOpen(false);
        break;
      case 'duplicate_object':
        onDuplicateObject();
        setIsOpen(false);
        break;
      case 'delete_contextual':
        if (workMode === 'object') {
          onDeleteObject();
        } else {
          onExecuteContextualDelete(quickDeleteAction);
        }
        setIsOpen(false);
        break;
      case 'dissolve_quick':
        onQuickDissolve();
        setIsOpen(false);
        break;
      case 'delete_edges_verts':
        onExecuteContextualDelete('delete_edges_and_vertices');
        setIsOpen(false);
        break;
      case 'delete_faces_edges':
        onExecuteContextualDelete('delete_faces_and_edges');
        setIsOpen(false);
        break;
      case 'undo':
        onUndo();
        setIsOpen(false);
        break;
      case 'redo':
        onRedo();
        setIsOpen(false);
        break;
      case 'work_object':
        onToggleWorkMode('object');
        setIsOpen(false);
        break;
      case 'work_edit':
        onToggleWorkMode('edit');
        setIsOpen(false);
        break;
      case 'toggle_xray':
        onToggleXray();
        setIsOpen(false);
        break;
      case 'toggle_grid':
        onToggleGrid();
        setIsOpen(false);
        break;
      case 'save_project':
        onSaveProject();
        setIsOpen(false);
        break;
      case 'open_settings':
        setIsOpen(false);
        onOpenSettings();
        break;
    }
  };

  const handleTriggerPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (isOpen) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: buttonPos.x,
      origY: buttonPos.y,
      moved: false,
    };
  };

  const handleTriggerPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (!d.moved && Math.hypot(dx, dy) > 8) {
      d.moved = true;
    }
    if (d.moved) {
      setDragPos({
        x: d.origX + dx,
        y: d.origY + dy,
      });
    }
  };

  const handleTriggerPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (d && d.moved) {
      const clampedX = Math.max(
        8,
        Math.min(
          viewportSize.width - btnSize - 8,
          d.origX + (e.clientX - d.startClientX),
        ),
      );
      const clampedY = Math.max(
        8,
        Math.min(
          viewportSize.height - btnSize - 8,
          d.origY + (e.clientY - d.startClientY),
        ),
      );
      setDragPos(null);
      onUpdateCustomPos({
        xPct: (clampedX + btnSize / 2) / viewportSize.width,
        yPct: (clampedY + btnSize / 2) / viewportSize.height,
      });
      return;
    }

    setShowPrimitivePicker(false);
    setCustomizeMode(false);
    setIsOpen((prev) => !prev);
  };

  const handleTriggerPointerCancel = (
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    dragRef.current = null;
    setDragPos(null);
  };

  const handleSlotPointerDown = (
    slotIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    clearSlotHold();
    const timer = window.setTimeout(() => {
      if (slotHoldRef.current && slotHoldRef.current.slotIndex === slotIndex) {
        slotHoldRef.current.triggered = true;
        slotHoldRef.current.timer = null;
        setShowPrimitivePicker(false);
        setEditingSlotIndex(slotIndex);
      }
    }, SLOT_LONG_PRESS_MS);

    slotHoldRef.current = {
      slotIndex,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      timer,
      triggered: false,
    };
  };

  const handleSlotPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const hold = slotHoldRef.current;
    if (!hold || hold.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - hold.startX, e.clientY - hold.startY) > 10) {
      clearSlotHold();
    }
  };

  const handleSlotPointerUpOrCancel = () => {
    clearSlotHold();
  };

  const slots = radialLayouts[activeRadialMode];

  const primitives: {
    type: PrimitiveType;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      type: 'cube',
      label: 'Cubo',
      icon: <Box className="w-4 h-4 text-[#ff9900]" />,
    },
    {
      type: 'circle',
      label: 'Círculo',
      icon: <Circle className="w-4 h-4 text-[#ff9900]" />,
    },
    {
      type: 'uv_sphere',
      label: 'Esfera',
      icon: <Globe className="w-4 h-4 text-[#ff9900]" />,
    },
    {
      type: 'cylinder',
      label: 'Cilindro',
      icon: <Cylinder className="w-4 h-4 text-[#ff9900]" />,
    },
    {
      type: 'pyramid',
      label: 'Pirámide',
      icon: <Pyramid className="w-4 h-4 text-[#ff9900]" />,
    },
  ];

  return (
    <>
      {/* Backdrop when radial menu is open */}
      {isOpen && (
        <div
          className="absolute inset-0 z-20 bg-black/30 transition-opacity duration-150"
          onPointerDown={(e) => {
            e.stopPropagation();
            setShowPrimitivePicker(false);
            setCustomizeMode(false);
            setIsOpen(false);
          }}
        />
      )}

      {/* Draggable Floating Circular Trigger (when closed) */}
      {!isOpen && (
        <button
          type="button"
          onPointerDown={handleTriggerPointerDown}
          onPointerMove={handleTriggerPointerMove}
          onPointerUp={handleTriggerPointerUp}
          onPointerCancel={handleTriggerPointerCancel}
          style={{
            width: btnSize,
            height: btnSize,
            left: buttonPos.x,
            top: buttonPos.y,
            touchAction: 'none',
          }}
          className="absolute z-20 rounded-full bg-[#181a1f] hover:bg-[#22252d] border-2 border-[#3d424f] shadow-xl flex items-center justify-center text-[#ff9900] transition-colors select-none cursor-grab active:cursor-grabbing"
          title="Abrir menú radial (arrastrar para reubicar)"
          aria-label="Abrir menú radial de herramientas"
        >
          <Aperture className="w-6 h-6" />
        </button>
      )}

      {/* Expanded Radial Wheel Overlay */}
      {isOpen && (
        <div
          style={{
            left: wheelCenter.x,
            top: wheelCenter.y,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute z-30 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
        >
          <div className="relative pointer-events-auto transition-transform duration-150 ease-out scale-100">
            {/* Subtle Connecting Ring Guide */}
            <div
              style={{
                width: effectiveRadius * 2,
                height: effectiveRadius * 2,
              }}
              className="rounded-full border border-[#3a3f4b]/75 bg-[#14161b]/65 -translate-x-1/2 -translate-y-1/2 absolute left-0 top-0 pointer-events-none"
            />

            {/* Configurable Radial Slots */}
            {slots.map((actionId, idx) => {
              const angle = -Math.PI / 2 + (idx / slots.length) * Math.PI * 2;
              const ix = Math.cos(angle) * effectiveRadius;
              const iy = Math.sin(angle) * effectiveRadius;
              const def = actionId ? RADIAL_ACTION_MAP[actionId] : null;
              const meta = def
                ? getActionMetaState(def)
                : { active: false, disabled: false, label: 'Vacío' };

              const isSlotDisabled = !customizeMode && def !== null && meta.disabled;

              return (
                <button
                  key={`slot-${idx}`}
                  type="button"
                  onPointerDown={(e) => handleSlotPointerDown(idx, e)}
                  onPointerMove={handleSlotPointerMove}
                  onPointerUp={handleSlotPointerUpOrCancel}
                  onPointerCancel={handleSlotPointerUpOrCancel}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingSlotIndex(idx);
                  }}
                  onClick={() => {
                    if (
                      slotHoldRef.current &&
                      slotHoldRef.current.slotIndex === idx &&
                      slotHoldRef.current.triggered
                    ) {
                      slotHoldRef.current = null;
                      return;
                    }
                    if (customizeMode || !def) {
                      setShowPrimitivePicker(false);
                      setEditingSlotIndex(idx);
                      return;
                    }
                    if (isSlotDisabled) return;
                    executeRadialAction(def.id);
                  }}
                  style={{
                    left: ix,
                    top: iy,
                  }}
                  title={
                    def
                      ? `${def.label} (mantener pulsado para personalizar)`
                      : 'Espacio vacío (tocar o mantener pulsado para asignar)'
                  }
                  className={`absolute -translate-x-1/2 -translate-y-1/2 w-[68px] h-[58px] rounded-xl border shadow-lg flex flex-col items-center justify-center gap-1 px-1 transition-transform duration-150 active:scale-95 ${
                    !def
                      ? 'bg-[#171920]/90 hover:bg-[#232732] border-dashed border-[#3f4554] text-[#7c8496]'
                      : isSlotDisabled
                        ? 'bg-[#1a1c22] border-[#2c303a] text-[#6b7280] opacity-45'
                        : customizeMode
                          ? 'bg-[#212530] hover:bg-[#2b303e] border-[#ff9900]/65 text-[#f3f4f6]'
                          : meta.active
                            ? 'bg-[#2c313b] border-[#ff9900] text-[#ff9900]'
                            : def.danger
                              ? 'bg-[#23191c] hover:bg-[#352024] border-[#593036] text-[#f87171]'
                              : 'bg-[#1c1f26] hover:bg-[#272b35] border-[#383e4c] text-[#e5e7eb]'
                  }`}
                >
                  {def ? (
                    <RadialActionIcon icon={def.icon} className="w-4 h-4" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  <span className="text-[10px] font-semibold leading-none tracking-tight truncate max-w-[62px]">
                    {meta.label}
                  </span>
                </button>
              );
            })}

            {/* Center Hub Close Button + Mode & Customize Trigger */}
            <div className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowPrimitivePicker(false);
                  setCustomizeMode(false);
                  setIsOpen(false);
                }}
                style={{ width: btnSize, height: btnSize }}
                className="rounded-full bg-[#242832] hover:bg-[#2d323e] border-2 border-[#ff9900]/75 text-[#f3f4f6] shadow-xl flex items-center justify-center transition-colors"
                aria-label="Cerrar menú radial"
              >
                <X className="w-5 h-5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowPrimitivePicker(false);
                  setCustomizeMode((prev) => !prev);
                }}
                className={`h-7 px-2.5 rounded-md border text-[10px] font-semibold whitespace-nowrap flex items-center gap-1 shadow-md transition-colors ${
                  customizeMode
                    ? 'bg-[#ff9900] border-[#ff9900] text-[#111215]'
                    : 'bg-[#181a1f] hover:bg-[#23262e] border-[#353a46] text-[#b4bac4]'
                }`}
                title="Alternar modo de edición rápida del menú radial (o mantén presionado cualquier botón)"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>{customizeMode ? 'Editando' : 'Personalizar'}</span>
              </button>
            </div>

            {/* Subtle Helper Label */}
            <div
              style={{ top: effectiveRadius + 42 }}
              className="absolute left-0 -translate-x-1/2 px-2.5 py-1 rounded bg-[#15171c]/95 border border-[#2d313c] text-[10px] text-[#9ca3af] whitespace-nowrap pointer-events-none"
            >
              {customizeMode
                ? 'Toca cualquier botón para asignar o vaciar'
                : `${workMode === 'object' ? 'Modo Objeto' : 'Modo Edición'} · Mantén un botón para configurar`}
            </div>

            {/* Inline Quick Primitive Picker (when open_add_menu tapped) */}
            {showPrimitivePicker && workMode === 'object' && (
              <div
                style={{ top: -effectiveRadius - 72 }}
                className="absolute left-0 -translate-x-1/2 rounded-xl bg-[#181a1f] border border-[#3a3f4b] shadow-2xl p-1.5 flex items-center gap-1"
              >
                {primitives.map((prim) => (
                  <button
                    key={prim.type}
                    type="button"
                    onClick={() => {
                      onAddPrimitive(prim.type);
                      setShowPrimitivePicker(false);
                      setIsOpen(false);
                    }}
                    className="min-w-[54px] h-12 px-2 rounded-lg bg-[#22252d] hover:bg-[#2c313b] border border-[#323743] flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-[#e5e7eb]"
                  >
                    {prim.icon}
                    <span>{prim.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Radial Slot Configuration Editor */}
      {editingSlotIndex !== null && (
        <RadialSlotEditorModal
          mode={activeRadialMode}
          slotIndex={editingSlotIndex}
          currentActionId={slots[editingSlotIndex] ?? null}
          onAssignAction={(actionId) =>
            onUpdateRadialSlot(activeRadialMode, editingSlotIndex, actionId)
          }
          onRestoreDefaultSlot={() =>
            onResetRadialSlot(activeRadialMode, editingSlotIndex)
          }
          onRestoreEntireLayout={() => onResetRadialLayout(activeRadialMode)}
          onClose={() => setEditingSlotIndex(null)}
        />
      )}
    </>
  );
};
