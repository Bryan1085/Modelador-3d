import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Check,
  ChevronDown,
  Download,
  FileBox,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  PanelRight,
  Redo2,
  Save,
  Settings,
  SlidersHorizontal,
  Triangle,
  Undo2,
  Upload,
} from 'lucide-react';
import { EditSelectionMode } from '../core/mesh/operations';
import { WorkMode } from '../core/project/types';

interface TopBarProps {
  projectName: string;
  hasUnsavedChanges: boolean;
  workMode: WorkMode;
  editSelectionMode: EditSelectionMode;
  canEditSelected: boolean;
  hasSelectedObject: boolean;
  canUndo: boolean;
  canRedo: boolean;
  showOutliner: boolean;
  onChangeProjectName: (name: string) => void;
  onSaveProject: () => void;
  onOpenProjectModal: () => void;
  onOpenSettingsModal: () => void;
  onImportObj: () => void;
  onImportStl: () => void;
  onImportJpg: () => void;
  onImportPng: () => void;
  onExportSelected: () => void;
  onExportScene: () => void;
  onExportObj: () => void;
  onExportStl: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleWorkMode: (mode: WorkMode) => void;
  onChangeEditSelectionMode: (mode: EditSelectionMode) => void;
  onToggleOutliner: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  projectName,
  hasUnsavedChanges,
  workMode,
  editSelectionMode,
  canEditSelected,
  hasSelectedObject,
  canUndo,
  canRedo,
  showOutliner,
  onChangeProjectName,
  onSaveProject,
  onOpenProjectModal,
  onOpenSettingsModal,
  onImportObj,
  onImportStl,
  onImportJpg,
  onImportPng,
  onExportSelected,
  onExportScene,
  onExportObj,
  onExportStl,
  onUndo,
  onRedo,
  onToggleWorkMode,
  onChangeEditSelectionMode,
  onToggleOutliner,
}) => {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(projectName);
  const [fileMenuAnchor, setFileMenuAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const fileBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!fileMenuAnchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFileMenuAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileMenuAnchor]);

  const toggleFileMenu = () => {
    if (fileMenuAnchor) {
      setFileMenuAnchor(null);
      return;
    }
    const rect = fileBtnRef.current?.getBoundingClientRect();
    setFileMenuAnchor({
      left: rect ? Math.min(window.innerWidth - 268, Math.max(8, rect.left)) : 12,
      top: rect ? rect.bottom + 6 : 52,
    });
  };

  const commitName = () => {
    setEditingName(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== projectName) {
      onChangeProjectName(trimmed);
    } else {
      setDraftName(projectName);
    }
  };

  return (
    <header className="h-12 shrink-0 bg-[#181a1f] border-b border-[#2b2e36] px-2.5 flex items-center justify-between gap-2 overflow-x-auto cad-scroll">
      {/* Left: Archivo, Project & History */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          ref={fileBtnRef}
          type="button"
          onClick={toggleFileMenu}
          aria-expanded={Boolean(fileMenuAnchor)}
          aria-haspopup="menu"
          className={`h-9 px-2.5 rounded-md border text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
            fileMenuAnchor
              ? 'bg-[#2c313b] border-[#ff9900]/60 text-[#ff9900]'
              : 'bg-[#23262d] hover:bg-[#2c3039] active:bg-[#343944] border-[#323640] text-[#e4e6eb]'
          }`}
          title="Menú Archivo (Importar y Exportar)"
        >
          <FileText className="w-4 h-4 text-[#ff9900]" />
          <span>Archivo</span>
          <ChevronDown className="w-3.5 h-3.5 opacity-75" />
        </button>

        <button
          type="button"
          onClick={onOpenProjectModal}
          className="h-9 px-2.5 rounded-md bg-[#23262d] hover:bg-[#2c3039] active:bg-[#343944] border border-[#323640] text-xs font-medium text-[#e4e6eb] flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          title="Proyectos"
        >
          <FolderOpen className="w-4 h-4 text-[#ff9900]" />
          <span className="hidden sm:inline">Proyectos</span>
        </button>

        {editingName ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setDraftName(projectName);
                  setEditingName(false);
                }
              }}
              autoFocus
              className="h-9 w-36 sm:w-44 px-2.5 rounded-md bg-[#111317] border border-[#ff9900] text-xs font-medium text-[#f3f4f6] outline-none"
            />
            <button
              type="button"
              onClick={commitName}
              className="h-9 w-9 rounded-md bg-[#ff9900] text-[#141518] flex items-center justify-center shrink-0"
              aria-label="Confirmar nombre"
            >
              <Check className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftName(projectName);
              setEditingName(true);
            }}
            className="h-9 px-2.5 rounded-md hover:bg-[#23262d] text-xs sm:text-sm font-semibold text-[#eceef2] max-w-[140px] sm:max-w-[200px] truncate text-left whitespace-nowrap shrink-0 transition-colors"
            title="Tocar para renombrar proyecto"
          >
            {projectName}
          </button>
        )}

        <button
          type="button"
          onClick={onSaveProject}
          className={`h-9 px-3 rounded-md text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
            hasUnsavedChanges
              ? 'bg-[#d97706] hover:bg-[#e5840b] text-[#111215]'
              : 'bg-[#23262d] hover:bg-[#2c3039] text-[#d1d5db] border border-[#323640]'
          }`}
          title="Guardar proyecto localmente"
        >
          <Save className="w-4 h-4" />
          <span className="hidden md:inline">Guardar</span>
        </button>

        <div className="w-px h-6 bg-[#2c3038] mx-0.5 shrink-0" />

        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="h-9 w-10 rounded-md bg-[#23262d] hover:bg-[#2c3039] disabled:opacity-35 disabled:pointer-events-none border border-[#323640] text-[#e4e6eb] flex items-center justify-center shrink-0 transition-colors"
          title="Deshacer"
          aria-label="Deshacer"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className="h-9 w-10 rounded-md bg-[#23262d] hover:bg-[#2c3039] disabled:opacity-35 disabled:pointer-events-none border border-[#323640] text-[#e4e6eb] flex items-center justify-center shrink-0 transition-colors"
          title="Rehacer"
          aria-label="Rehacer"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {/* Archivo Dropdown Popover (Fixed positioning to avoid header horizontal-scroll clipping) */}
      {fileMenuAnchor && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setFileMenuAnchor(null)}
        >
          <div
            role="menu"
            style={{
              left: fileMenuAnchor.left,
              top: fileMenuAnchor.top,
            }}
            onClick={(e) => e.stopPropagation()}
            className="fixed w-64 rounded-xl bg-[#181a1f] border border-[#2f3440] shadow-2xl p-1.5 space-y-1"
          >
            <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold text-[#8e95a2] flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5 text-[#ff9900]" />
              <span>Importar</span>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onImportObj();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <FileBox className="w-4 h-4 text-[#ff9900] shrink-0" />
              <span>Importar modelo OBJ</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onImportStl();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <FileBox className="w-4 h-4 text-[#34d399] shrink-0" />
              <span>Importar modelo STL</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onImportJpg();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <ImageIcon className="w-4 h-4 text-[#38bdf8] shrink-0" />
              <span>Importar imagen JPG</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onImportPng();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <ImageIcon className="w-4 h-4 text-[#60a5fa] shrink-0" />
              <span>Importar imagen PNG</span>
            </button>

            <div className="my-1 border-t border-[#262931]" />

            <div className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold text-[#8e95a2] flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-[#ff9900]" />
              <span>Exportar</span>
            </div>
            <button
              type="button"
              role="menuitem"
              disabled={!hasSelectedObject}
              onClick={() => {
                setFileMenuAnchor(null);
                onExportSelected();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] disabled:opacity-40 disabled:pointer-events-none text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <Box className="w-4 h-4 text-[#ff9900] shrink-0" />
              <span>Exportar objeto seleccionado</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onExportScene();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <Layers className="w-4 h-4 text-[#a78bfa] shrink-0" />
              <span>Exportar escena completa</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onExportObj();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <Download className="w-4 h-4 text-[#cbd5e1] shrink-0" />
              <span>Exportar modelo en OBJ</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setFileMenuAnchor(null);
                onExportStl();
              }}
              className="w-full h-10 px-2.5 rounded-lg hover:bg-[#252932] active:bg-[#2e333f] text-xs font-medium text-[#e4e6eb] flex items-center gap-2.5 text-left transition-colors"
            >
              <Download className="w-4 h-4 text-[#34d399] shrink-0" />
              <span>Exportar modelo en STL</span>
            </button>
          </div>
        </div>
      )}

      {/* Center: Work Mode & Edit Component Mode */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center p-0.5 rounded-lg bg-[#111317] border border-[#2b2e36]">
          <button
            type="button"
            onClick={() => onToggleWorkMode('object')}
            className={`h-8 px-3 rounded-md text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
              workMode === 'object'
                ? 'bg-[#2c313b] text-[#ff9900]'
                : 'text-[#9ca3af] hover:text-[#e4e6eb]'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            <span>Modo Objeto</span>
          </button>
          <button
            type="button"
            onClick={() => onToggleWorkMode('edit')}
            disabled={!canEditSelected && workMode !== 'edit'}
            className={`h-8 px-3 rounded-md text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors disabled:opacity-40 ${
              workMode === 'edit'
                ? 'bg-[#d97706] text-[#111215]'
                : 'text-[#9ca3af] hover:text-[#e4e6eb]'
            }`}
          >
            <Triangle className="w-3.5 h-3.5" />
            <span>Modo Edición</span>
          </button>
        </div>

        {workMode === 'edit' && (
          <div className="flex items-center p-0.5 rounded-lg bg-[#111317] border border-[#2b2e36]">
            {(
              [
                { id: 'vertex', label: 'Vértices', short: 'Vért.' },
                { id: 'edge', label: 'Aristas', short: 'Aris.' },
                { id: 'face', label: 'Caras', short: 'Caras' },
              ] as const
            ).map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => onChangeEditSelectionMode(sub.id)}
                className={`h-8 px-2.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  editSelectionMode === sub.id
                    ? 'bg-[#2c313b] text-[#ff9900] border border-[#ff9900]/40'
                    : 'text-[#9ca3af] hover:text-[#e4e6eb] border border-transparent'
                }`}
              >
                <span className="hidden lg:inline">{sub.label}</span>
                <span className="lg:hidden">{sub.short}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: Settings & Outliner Toggle */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onOpenSettingsModal}
          className="h-9 px-2.5 rounded-md bg-[#23262d] hover:bg-[#2c3039] border border-[#323640] text-xs font-medium text-[#d1d5db] flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          title="Configuración"
          aria-label="Configuración"
        >
          <Settings className="w-4 h-4" />
          <span className="hidden lg:inline">Configuración</span>
        </button>

        <button
          type="button"
          onClick={onToggleOutliner}
          className={`h-9 w-10 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
            showOutliner
              ? 'bg-[#2c313b] border-[#ff9900]/50 text-[#ff9900]'
              : 'bg-[#23262d] border-[#323640] text-[#d1d5db] hover:bg-[#2c3039]'
          }`}
          title="Mostrar u ocultar explorador de objetos"
          aria-label="Alternar explorador"
        >
          {showOutliner ? (
            <PanelRight className="w-4 h-4" />
          ) : (
            <SlidersHorizontal className="w-4 h-4" />
          )}
        </button>
      </div>
    </header>
  );
};
