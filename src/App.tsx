import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExportFormat,
  ExportModelModal,
  ExportRequestConfig,
  ExportScope,
  IoErrorModal,
  IoProgressModal,
  PendingStlImport,
  ReferenceImageImportModal,
  StlImportModal,
} from './components/FileIoModals';
import { OutlinerPanel } from './components/OutlinerPanel';
import { ProjectModal } from './components/ProjectModal';
import { SettingsModal } from './components/SettingsModal';
import { ToolPanel } from './components/ToolPanel';
import { TopBar } from './components/TopBar';
import { Viewport3D } from './components/Viewport3D';
import {
  LoadedImageReferencePayload,
  loadReferenceImageFile,
} from './core/io/imageReference';
import {
  MAX_IMPORT_FILE_BYTES,
  stripFileExtension,
  triggerFileDownload,
} from './core/io/meshUtils';
import { exportObjectsToObj } from './core/io/objExport';
import { parseObjContent } from './core/io/objImport';
import { exportObjectsToStl } from './core/io/stlExport';
import { inspectStlBuffer, parseStlBuffer } from './core/io/stlImport';
import {
  ObjectTransform,
  ReferenceImageOrientation,
  SceneObjectData,
} from './core/project/types';
import { useModelerStore } from './state/useModelerStore';

export default function App() {
  const store = useModelerStore();

  const [showOutliner, setShowOutliner] = useState(true);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [liveTransformOverride, setLiveTransformOverride] = useState<{
    id: string;
    transform: ObjectTransform;
  } | null>(null);

  // Import/Export workflow states & modals
  const [pendingStl, setPendingStl] = useState<PendingStlImport | null>(null);
  const [pendingRefImage, setPendingRefImage] =
    useState<LoadedImageReferencePayload | null>(null);
  const [exportModalConfig, setExportModalConfig] = useState<{
    format: ExportFormat;
    scope: ExportScope;
  } | null>(null);
  const [ioProgress, setIoProgress] = useState<{
    title: string;
    label: string;
    progress: number;
  } | null>(null);
  const [ioError, setIoError] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // Hidden file inputs mounted synchronously for iPad Safari compatibility
  const objInputRef = useRef<HTMLInputElement | null>(null);
  const stlInputRef = useRef<HTMLInputElement | null>(null);
  const jpgInputRef = useRef<HTMLInputElement | null>(null);
  const pngInputRef = useRef<HTMLInputElement | null>(null);

  const handleLiveObjectTransform = useCallback(
    (id: string, transform: ObjectTransform) => {
      setLiveTransformOverride({ id, transform });
    },
    [],
  );

  const handleCommitObjectTransform = useCallback(
    (id: string, before: ObjectTransform, after: ObjectTransform) => {
      setLiveTransformOverride(null);
      store.commitObjectTransformFromGizmo(id, before, after);
    },
    [store],
  );

  /* ==========================================================================
   * File Import Handlers (OBJ, STL, JPG, PNG)
   * ======================================================================== */
  const handleObjFilesSelected = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const objFile = files.find((f) => f.name.toLowerCase().endsWith('.obj'));
      const mtlFile = files.find((f) => f.name.toLowerCase().endsWith('.mtl'));

      if (!objFile) {
        setIoError({
          title: 'Archivo no compatible',
          message:
            'Selecciona un archivo con extensión .obj (opcionalmente acompañado de su archivo .mtl).',
        });
        return;
      }

      if (objFile.size === 0) {
        setIoError({
          title: 'Archivo OBJ vacío',
          message: `El archivo "${objFile.name}" no contiene datos.`,
        });
        return;
      }

      if (objFile.size > MAX_IMPORT_FILE_BYTES) {
        setIoError({
          title: 'Archivo demasiado grande',
          message: `El archivo "${objFile.name}" supera el límite seguro de ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB.`,
        });
        return;
      }

      try {
        setIoProgress({
          title: 'Importando modelo OBJ',
          label: `Leyendo "${objFile.name}"...`,
          progress: 0.05,
        });
        const objText = await objFile.text();
        const mtlText = mtlFile ? await mtlFile.text() : undefined;

        const result = await parseObjContent(objText, objFile.name, {
          mtlText,
          onProgress: (progress, label) => {
            setIoProgress({
              title: 'Importando modelo OBJ',
              label,
              progress,
            });
          },
        });

        store.importObjParts(result);
        setIoProgress(null);

        if (result.warnings.length > 0) {
          store.showToast(result.warnings[0]);
        }
      } catch (err) {
        setIoProgress(null);
        setIoError({
          title: 'Error al importar OBJ',
          message:
            err instanceof Error
              ? err.message
              : 'El archivo OBJ está dañado o no pudo procesarse.',
        });
      }
    },
    [store],
  );

  const handleStlFileSelected = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setIoError({
        title: 'Archivo no compatible',
        message: 'Selecciona un archivo 3D con extensión .stl.',
      });
      return;
    }

    if (file.size === 0) {
      setIoError({
        title: 'Archivo STL vacío',
        message: `El archivo "${file.name}" está vacío.`,
      });
      return;
    }

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setIoError({
        title: 'Archivo demasiado grande',
        message: `El archivo "${file.name}" supera el límite seguro de ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB.`,
      });
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const inspection = inspectStlBuffer(buffer);
      setPendingStl({
        fileName: file.name,
        fileSizeBytes: file.size,
        buffer,
        inspection,
      });
    } catch (err) {
      setIoError({
        title: 'Error al leer STL',
        message:
          err instanceof Error
            ? err.message
            : 'El archivo STL está dañado o no es compatible.',
      });
    }
  }, []);

  const handleConfirmStlImport = useCallback(
    async (scale: number) => {
      if (!pendingStl) return;
      const target = pendingStl;
      setPendingStl(null);
      try {
        setIoProgress({
          title: 'Importando modelo STL',
          label: `Procesando "${target.fileName}"...`,
          progress: 0.08,
        });
        const result = await parseStlBuffer(target.buffer, target.fileName, {
          scale,
          onProgress: (progress, label) => {
            setIoProgress({
              title: 'Importando modelo STL',
              label,
              progress,
            });
          },
        });
        store.importStlResult(result);
        setIoProgress(null);
        if (result.warnings.length > 0) {
          store.showToast(result.warnings[0]);
        }
      } catch (err) {
        setIoProgress(null);
        setIoError({
          title: 'Error al importar STL',
          message:
            err instanceof Error
              ? err.message
              : 'No se pudo procesar la geometría STL.',
        });
      }
    },
    [pendingStl, store],
  );

  const handleImageFileSelected = useCallback(
    async (fileList: FileList | null, expectedFormat: 'jpg' | 'png') => {
      if (!fileList || fileList.length === 0) return;
      const file = fileList[0];
      try {
        const payload = await loadReferenceImageFile(file, expectedFormat);
        setPendingRefImage(payload);
      } catch (err) {
        setIoError({
          title: 'Imagen de referencia no compatible',
          message:
            err instanceof Error
              ? err.message
              : 'No se pudo cargar la imagen seleccionada.',
        });
      }
    },
    [],
  );

  const handleConfirmReferenceImage = useCallback(
    (orientation: ReferenceImageOrientation) => {
      if (!pendingRefImage) return;
      store.addReferenceImage(pendingRefImage, orientation);
      setPendingRefImage(null);
    },
    [pendingRefImage, store],
  );

  /* ==========================================================================
   * Export Handlers (OBJ / STL)
   * ======================================================================== */
  const openExportModal = useCallback(
    (format: ExportFormat, scope: ExportScope) => {
      if (scope === 'selected' && !store.selectedObjectId) {
        store.showToast('Selecciona un objeto o exporta la escena completa');
        return;
      }
      setExportModalConfig({ format, scope });
    },
    [store],
  );

  const handleExecuteExport = useCallback(
    async (config: ExportRequestConfig) => {
      const sceneObjects = store.activeScene.objects;
      let targets: SceneObjectData[] = [];
      if (config.scope === 'selected') {
        const sel = sceneObjects.find((o) => o.id === store.selectedObjectId);
        if (sel) targets = [sel];
      } else if (config.scope === 'multiple') {
        const idSet = new Set(config.selectedIds);
        targets = sceneObjects.filter((o) => idSet.has(o.id));
      } else {
        targets = sceneObjects;
      }

      const baseFilename =
        config.scope === 'selected' && targets.length === 1
          ? stripFileExtension(targets[0].name)
          : stripFileExtension(store.project.name || 'escena');

      setExportModalConfig(null);

      try {
        if (config.format === 'obj') {
          setIoProgress({
            title: 'Exportando modelo OBJ',
            label: 'Preparando geometría...',
            progress: 0.1,
          });
          const result = await exportObjectsToObj(targets, {
            applyTransform: config.applyTransform,
            exportScale: config.exportScale,
            onProgress: (progress, label) => {
              setIoProgress({
                title: 'Exportando modelo OBJ',
                label,
                progress,
              });
            },
          });
          triggerFileDownload(
            result.objText,
            `${baseFilename}.obj`,
            'text/plain;charset=utf-8',
          );
          setIoProgress(null);
          const skippedMsg =
            result.skippedObjects.length > 0
              ? ` (${result.skippedObjects.length} omitido(s))`
              : '';
          store.showToast(
            `OBJ exportado: ${result.exportedCount} objeto(s)${skippedMsg}`,
          );
        } else {
          setIoProgress({
            title: 'Exportando modelo STL',
            label: 'Verificando y triangulando mallas...',
            progress: 0.1,
          });
          const result = await exportObjectsToStl(targets, {
            binary: config.stlBinary,
            applyTransform: config.applyTransform,
            exportScale: config.exportScale,
            onProgress: (progress, label) => {
              setIoProgress({
                title: 'Exportando modelo STL',
                label,
                progress,
              });
            },
          });
          triggerFileDownload(
            result.data,
            `${baseFilename}.stl`,
            config.stlBinary
              ? 'application/octet-stream'
              : 'model/stl;charset=utf-8',
          );
          setIoProgress(null);
          const skippedMsg =
            result.validation.skippedObjects.length > 0
              ? ` · ${result.validation.skippedObjects.length} omitido(s)`
              : '';
          store.showToast(
            `STL exportado (${result.totalTriangles.toLocaleString()} triángulos)${skippedMsg}`,
          );
        }
      } catch (err) {
        setIoProgress(null);
        setIoError({
          title: `Error al exportar ${config.format.toUpperCase()}`,
          message:
            err instanceof Error
              ? err.message
              : 'No se pudo completar la exportación.',
        });
      }
    },
    [store],
  );

  // Keyboard shortcuts for iPad Magic Keyboard / Desktop testing
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        store.saveProject();
        return;
      }

      if (e.key === 'Escape' && store.operatorSession) {
        e.preventDefault();
        store.cancelEditOperator();
        return;
      }
      if (e.key === 'Enter' && store.operatorSession) {
        e.preventDefault();
        store.confirmEditOperator();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'tab':
          e.preventDefault();
          store.toggleWorkMode(store.workMode === 'object' ? 'edit' : 'object');
          break;
        case 'g':
          store.setActiveTool('move');
          break;
        case 'r':
          store.setActiveTool('rotate');
          break;
        case 's':
          store.setActiveTool('scale');
          break;
        case 'q':
          store.setActiveTool('select');
          break;
        case 'e':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.startEditOperator('extrude');
          }
          break;
        case 'i':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.startEditOperator('inset');
          }
          break;
        case 'b':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.startEditOperator('bevel');
          }
          break;
        case 'k':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.startEditOperator('loop_cut');
          }
          break;
        case 'm':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.startEditOperator('merge');
          }
          break;
        case 'f':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.executeFillSelection();
          }
          break;
        case 'x':
          store.setAxisConstraint(store.axisConstraint === 'x' ? 'free' : 'x');
          break;
        case 'y':
          store.setAxisConstraint(store.axisConstraint === 'y' ? 'free' : 'y');
          break;
        case 'z':
          store.setAxisConstraint(store.axisConstraint === 'z' ? 'free' : 'z');
          break;
        case 'a':
          if (store.workMode === 'edit' && !store.operatorSession) {
            if (e.altKey) store.deselectAllEditComponents();
            else store.selectAllEditComponents();
          }
          break;
        case 'delete':
        case 'backspace':
          if (store.workMode === 'edit' && !store.operatorSession) {
            store.deleteSelectedEditComponents();
          } else if (store.selectedObjectId && !store.operatorSession) {
            store.deleteObject(store.selectedObjectId);
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  const canEditSelected = Boolean(
    store.selectedObject &&
      store.selectedObject.objectType === 'mesh' &&
      !store.selectedObject.locked,
  );

  return (
    <div className="w-screen h-screen flex flex-col bg-[#18191c] text-[#e4e6eb] overflow-hidden select-none">
      {/* Hidden Safari iPad-compatible file pickers (invoked synchronously inside menu clicks) */}
      <input
        ref={objInputRef}
        type="file"
        accept=".obj,.mtl"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleObjFilesSelected(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={stlInputRef}
        type="file"
        accept=".stl"
        className="hidden"
        onChange={(e) => {
          void handleStlFileSelected(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={jpgInputRef}
        type="file"
        accept=".jpg,.jpeg,image/jpeg"
        className="hidden"
        onChange={(e) => {
          void handleImageFileSelected(e.target.files, 'jpg');
          e.target.value = '';
        }}
      />
      <input
        ref={pngInputRef}
        type="file"
        accept=".png,image/png"
        className="hidden"
        onChange={(e) => {
          void handleImageFileSelected(e.target.files, 'png');
          e.target.value = '';
        }}
      />

      {/* A. Barra Superior */}
      <TopBar
        projectName={store.project.name}
        hasUnsavedChanges={store.hasUnsavedChanges}
        workMode={store.workMode}
        editSelectionMode={store.editSelectionMode}
        canEditSelected={canEditSelected}
        hasSelectedObject={Boolean(store.selectedObject)}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        showOutliner={showOutliner}
        onChangeProjectName={store.setProjectName}
        onSaveProject={store.saveProject}
        onOpenProjectModal={() => setShowProjectModal(true)}
        onOpenSettingsModal={() => setShowSettingsModal(true)}
        onImportObj={() => objInputRef.current?.click()}
        onImportStl={() => stlInputRef.current?.click()}
        onImportJpg={() => jpgInputRef.current?.click()}
        onImportPng={() => pngInputRef.current?.click()}
        onExportSelected={() => openExportModal('obj', 'selected')}
        onExportScene={() => openExportModal('obj', 'scene')}
        onExportObj={() =>
          openExportModal('obj', store.selectedObjectId ? 'selected' : 'scene')
        }
        onExportStl={() =>
          openExportModal('stl', store.selectedObjectId ? 'selected' : 'scene')
        }
        onUndo={() => store.undo()}
        onRedo={() => store.redo()}
        onToggleWorkMode={store.toggleWorkMode}
        onChangeEditSelectionMode={store.changeEditSelectionMode}
        onToggleOutliner={() => setShowOutliner((prev) => !prev)}
      />

      {/* Main Workspace: Tools + 3D Viewport + Outliner */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* B. Panel de Herramientas */}
        <ToolPanel
          workMode={store.workMode}
          editSelectionMode={store.editSelectionMode}
          activeTool={store.activeTool}
          activeOperatorType={store.operatorSession?.config.type ?? null}
          hasSelectedObject={Boolean(store.selectedObject)}
          hasSelectedComponents={store.selectedComponentIds.size > 0}
          multiSelectTouch={store.settings.multiSelectTouch}
          onSelectTool={(tool) => {
            if (store.operatorSession) store.cancelEditOperator();
            store.setActiveTool(tool);
          }}
          onAddPrimitive={store.addPrimitive}
          onDuplicateObject={store.duplicateSelectedObject}
          onDeleteObject={() => {
            if (store.selectedObjectId) store.deleteObject(store.selectedObjectId);
          }}
          onSelectAll={store.selectAllEditComponents}
          onDeselectAll={store.deselectAllEditComponents}
          onStartOperator={store.startEditOperator}
          onFillSelection={store.executeFillSelection}
          onExecuteContextualDelete={store.executeContextualDelete}
          onToggleMultiSelectTouch={() =>
            store.updateSettings({
              multiSelectTouch: !store.settings.multiSelectTouch,
            })
          }
        />

        {/* C. Visor 3D */}
        <Viewport3D
          objects={store.renderedObjects}
          selectedObject={store.selectedObject}
          selectedObjectId={store.selectedObjectId}
          workMode={store.workMode}
          editSelectionMode={store.editSelectionMode}
          selectedComponentIds={store.selectedComponentIds}
          activeTool={store.activeTool}
          axisConstraint={store.axisConstraint}
          projection={store.projection}
          settings={store.settings}
          meshRevision={store.meshRevision}
          toastMessage={store.toastMessage}
          screenShiftActive={store.screenShiftActive}
          operatorSession={store.operatorSession}
          loopCutPreviewSegments={store.loopCutPreviewSegments}
          canUndo={store.canUndo}
          canRedo={store.canRedo}
          onSelectObject={store.selectObject}
          onSelectComponent={store.selectComponentFromViewport}
          onPickLoopCutEdge={store.pickLoopCutEdge}
          onTwoFingerUndo={() => store.undo(true)}
          onThreeFingerRedo={() => store.redo(true)}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
          onLiveObjectTransform={handleLiveObjectTransform}
          onCommitObjectTransform={handleCommitObjectTransform}
          onCommitMeshEdit={store.commitMeshEditFromGizmo}
          onUpdateOperatorConfig={store.updateOperatorConfig}
          onConfirmOperator={store.confirmEditOperator}
          onCancelOperator={store.cancelEditOperator}
          onChangeAxisConstraint={store.setAxisConstraint}
          onToggleProjection={store.setProjection}
          onToggleXray={() =>
            store.updateSettings({ xrayEditMode: !store.settings.xrayEditMode })
          }
          onToggleGrid={() =>
            store.updateSettings({ showGrid: !store.settings.showGrid })
          }
          onToggleMultiSelectTouch={() =>
            store.updateSettings({
              multiSelectTouch: !store.settings.multiSelectTouch,
            })
          }
          onToggleScreenShift={store.toggleScreenShift}
          onUpdateTouchSettings={store.updateTouchSettings}
          onUpdateRadialSlot={store.updateRadialSlot}
          onResetRadialSlot={store.resetRadialSlot}
          onResetRadialLayout={store.resetRadialLayout}
          onAddPrimitive={(type) => store.addPrimitive(type)}
          onSelectTool={(tool) => {
            if (store.operatorSession) store.cancelEditOperator();
            store.setActiveTool(tool);
          }}
          onDuplicateObject={store.duplicateSelectedObject}
          onHideObject={store.toggleObjectVisibility}
          onDeleteObject={() => {
            if (store.selectedObjectId) store.deleteObject(store.selectedObjectId);
          }}
          onToggleWorkMode={store.toggleWorkMode}
          onChangeEditSelectionMode={store.changeEditSelectionMode}
          onSelectAll={store.selectAllEditComponents}
          onDeselectAll={store.deselectAllEditComponents}
          onStartOperator={store.startEditOperator}
          onFillSelection={store.executeFillSelection}
          onQuickDissolve={store.executeQuickDissolve}
          onExecuteContextualDelete={store.executeContextualDelete}
          onSaveProject={store.saveProject}
          onOpenSettings={() => setShowSettingsModal(true)}
        />

        {/* D. Explorador de Jerarquía y Modificadores */}
        {showOutliner && (
          <OutlinerPanel
            scenes={store.scenes}
            activeSceneId={store.activeSceneId}
            activeCollectionId={store.activeCollectionId}
            objects={store.renderedObjects}
            selectedObjectId={store.selectedObjectId}
            workMode={store.workMode}
            editSelectionMode={store.editSelectionMode}
            selectedComponentIds={store.selectedComponentIds}
            liveTransformOverride={liveTransformOverride}
            onSelectObject={store.selectObject}
            onSelectObjectInScene={store.selectObjectInScene}
            onRenameObject={store.renameObject}
            onDuplicateObject={store.duplicateObjectById}
            onToggleVisibility={store.toggleObjectVisibility}
            onToggleLock={store.toggleObjectLock}
            onDeleteObject={store.deleteObject}
            onUpdateObjectTransform={store.updateObjectTransform}
            onUpdateEditCentroidAxis={store.updateSelectedVerticesPosition}
            onCreateScene={() => store.createScene()}
            onSwitchScene={store.switchScene}
            onRenameScene={store.renameScene}
            onDeleteScene={store.deleteScene}
            onCreateCollection={store.createCollection}
            onSelectCollection={store.selectCollection}
            onRenameCollection={store.renameCollection}
            onToggleCollectionExpanded={store.toggleCollectionExpanded}
            onDeleteCollection={store.deleteCollection}
            onMoveObjectToCollection={store.moveObjectToCollection}
            onUpdateReferenceImageProps={store.updateReferenceImageProps}
          />
        )}
      </div>

      {/* Modals */}
      {showProjectModal && (
        <ProjectModal
          currentProjectId={store.project.id}
          currentProjectName={store.project.name}
          savedProjects={store.savedProjects}
          onClose={() => setShowProjectModal(false)}
          onCreateProject={store.createProject}
          onOpenProject={store.openProject}
          onSaveCurrent={store.saveProject}
          onDeleteProject={store.removeSavedProject}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          settings={store.settings}
          onUpdateSettings={store.updateSettings}
          onUpdateTouchSettings={store.updateTouchSettings}
          onUpdateTouchModifier={store.updateTouchModifier}
          onUpdateRadialSlot={store.updateRadialSlot}
          onResetRadialSlot={store.resetRadialSlot}
          onResetRadialLayout={store.resetRadialLayout}
          onResetTouchSettings={store.resetTouchSettings}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {pendingStl && (
        <StlImportModal
          pending={pendingStl}
          onCancel={() => setPendingStl(null)}
          onConfirm={(scale) => {
            void handleConfirmStlImport(scale);
          }}
        />
      )}

      {pendingRefImage && (
        <ReferenceImageImportModal
          payload={pendingRefImage}
          onCancel={() => setPendingRefImage(null)}
          onConfirm={handleConfirmReferenceImage}
        />
      )}

      {exportModalConfig && (
        <ExportModelModal
          initialFormat={exportModalConfig.format}
          initialScope={exportModalConfig.scope}
          sceneObjects={store.activeScene.objects}
          selectedObjectId={store.selectedObjectId}
          onCancel={() => setExportModalConfig(null)}
          onExport={(cfg) => {
            void handleExecuteExport(cfg);
          }}
        />
      )}

      {ioProgress && (
        <IoProgressModal
          title={ioProgress.title}
          label={ioProgress.label}
          progress={ioProgress.progress}
        />
      )}

      {ioError && (
        <IoErrorModal
          title={ioError.title}
          message={ioError.message}
          onClose={() => setIoError(null)}
        />
      )}
    </div>
  );
}
