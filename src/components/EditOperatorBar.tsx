import React from 'react';
import {
  Check,
  Columns,
  FlipHorizontal,
  GitMerge,
  Grid,
  Scissors,
  Square,
  X,
} from 'lucide-react';
import { ExtrudeAxis, MergeMode } from '../core/mesh/advancedOperations';
import { Vec3 } from '../core/mesh/EditableMesh';
import {
  EditOperatorParams,
  EditOperatorSession,
  EditOperatorType,
} from '../state/useModelerStore';

interface EditOperatorBarProps {
  session: EditOperatorSession;
  onUpdateConfig: (config: EditOperatorParams) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const OPERATOR_META: Record<
  EditOperatorType,
  { title: string; icon: React.ReactNode }
> = {
  extrude: {
    title: 'Extruir',
    icon: <FlipHorizontal className="w-4 h-4 text-[#ff9900]" />,
  },
  inset: {
    title: 'Insertar Caras',
    icon: <Square className="w-4 h-4 text-[#ff9900]" />,
  },
  subdivide: {
    title: 'Subdividir',
    icon: <Grid className="w-4 h-4 text-[#ff9900]" />,
  },
  bevel: {
    title: 'Biselar',
    icon: <Columns className="w-4 h-4 text-[#ff9900]" />,
  },
  loop_cut: {
    title: 'Corte de Bucle',
    icon: <Scissors className="w-4 h-4 text-[#38bdf8]" />,
  },
  merge: {
    title: 'Fusionar Vértices',
    icon: <GitMerge className="w-4 h-4 text-[#ff9900]" />,
  },
};

export const EditOperatorBar: React.FC<EditOperatorBarProps> = ({
  session,
  onUpdateConfig,
  onConfirm,
  onCancel,
}) => {
  const { config, baseSelectionMode } = session;
  const meta = OPERATOR_META[config.type];

  const renderNumberControl = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (next: number) => void,
  ) => (
    <div className="flex items-center gap-2 min-w-[190px]">
      <span className="text-[11px] font-medium text-[#b4bac4] whitespace-nowrap">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-24 accent-[#ff9900] cursor-pointer"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(e) => {
          const parsed = parseFloat(e.target.value);
          if (!Number.isNaN(parsed)) {
            onChange(Math.max(min, Math.min(max, parsed)));
          }
        }}
        className="w-16 h-8 px-1.5 rounded bg-[#111317] border border-[#2f333d] text-xs font-mono-tabular text-[#f3f4f6] text-right focus:outline-none focus:border-[#ff9900]"
      />
    </div>
  );

  const renderStepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (next: number) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-medium text-[#b4bac4] whitespace-nowrap mr-0.5">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-8 h-8 rounded bg-[#23262e] hover:bg-[#2c313b] border border-[#363b47] text-sm font-bold text-[#e4e6eb] disabled:opacity-35"
      >
        −
      </button>
      <span className="w-7 text-center text-xs font-mono-tabular font-semibold text-[#f3f4f6]">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-8 h-8 rounded bg-[#23262e] hover:bg-[#2c313b] border border-[#363b47] text-sm font-bold text-[#e4e6eb] disabled:opacity-35"
      >
        +
      </button>
    </div>
  );

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-[min(96%,760px)] rounded-lg bg-[#181a1f] border border-[#363b47] shadow-2xl px-3 py-2.5 flex flex-col gap-2 pointer-events-auto">
      {/* Header + Confirm / Cancel */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {meta.icon}
          <span className="text-xs font-semibold text-[#f3f4f6] tracking-wide">
            {meta.title}
          </span>
          {config.type === 'loop_cut' && (
            <span className="hidden sm:inline text-[11px] text-[#7dd3fc] truncate">
              · Toca una arista en el visor para cambiar el bucle
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[38px] px-3 rounded-md bg-[#23262e] hover:bg-[#2f333d] border border-[#383e4a] text-xs font-medium text-[#d1d5db] flex items-center gap-1.5 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-[#e06c75]" />
            <span>Cancelar</span>
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="min-h-[38px] px-3.5 rounded-md bg-[#ff9900] hover:bg-[#ffa726] text-xs font-bold text-[#111215] flex items-center gap-1.5 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Confirmar</span>
          </button>
        </div>
      </div>

      {/* Dynamic Parameter Controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 border-t border-[#272a33]">
        {config.type === 'extrude' && (
          <>
            {renderNumberControl(
              'Distancia',
              config.params.distance,
              -3,
              3,
              0.05,
              (distance) =>
                onUpdateConfig({
                  type: 'extrude',
                  params: { ...config.params, distance },
                }),
            )}

            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-[#b4bac4] mr-1">
                Dirección
              </span>
              {(
                [
                  { id: 'normal', label: 'Normal' },
                  { id: 'x', label: 'X' },
                  { id: 'y', label: 'Y' },
                  { id: 'z', label: 'Z' },
                ] as { id: ExtrudeAxis; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    onUpdateConfig({
                      type: 'extrude',
                      params: { ...config.params, axis: opt.id },
                    })
                  }
                  className={`h-8 px-2.5 rounded text-xs font-semibold border transition-colors ${
                    config.params.axis === opt.id
                      ? 'bg-[#2c313b] text-[#ff9900] border-[#ff9900]/50'
                      : 'bg-[#20232b] text-[#a1a7b3] border-[#2f333d] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {baseSelectionMode === 'face' && (
              <button
                type="button"
                onClick={() =>
                  onUpdateConfig({
                    type: 'extrude',
                    params: {
                      ...config.params,
                      individual: !config.params.individual,
                    },
                  })
                }
                className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                  config.params.individual
                    ? 'bg-[#2c313b] text-[#ff9900] border-[#ff9900]/50'
                    : 'bg-[#20232b] text-[#a1a7b3] border-[#2f333d] hover:text-white'
                }`}
              >
                Caras individuales
              </button>
            )}
          </>
        )}

        {config.type === 'inset' && (
          <>
            {renderNumberControl(
              'Grosor',
              config.params.thickness,
              0.02,
              0.9,
              0.02,
              (thickness) =>
                onUpdateConfig({
                  type: 'inset',
                  params: { ...config.params, thickness },
                }),
            )}
            {renderNumberControl(
              'Profundidad',
              config.params.depth,
              -1,
              1,
              0.05,
              (depth) =>
                onUpdateConfig({
                  type: 'inset',
                  params: { ...config.params, depth },
                }),
            )}
            <button
              type="button"
              onClick={() =>
                onUpdateConfig({
                  type: 'inset',
                  params: {
                    ...config.params,
                    individual: !config.params.individual,
                  },
                })
              }
              className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                config.params.individual
                  ? 'bg-[#2c313b] text-[#ff9900] border-[#ff9900]/50'
                  : 'bg-[#20232b] text-[#a1a7b3] border-[#2f333d] hover:text-white'
              }`}
            >
              Individual
            </button>
          </>
        )}

        {config.type === 'subdivide' && (
          <>
            {renderStepper('Cortes', config.params.cuts, 1, 6, (cuts) =>
              onUpdateConfig({
                type: 'subdivide',
                params: { ...config.params, cuts },
              }),
            )}
            {renderNumberControl(
              'Suavizado',
              config.params.smoothness,
              0,
              1,
              0.05,
              (smoothness) =>
                onUpdateConfig({
                  type: 'subdivide',
                  params: { ...config.params, smoothness },
                }),
            )}
            {renderNumberControl(
              'Desplazamiento',
              config.params.fractal,
              0,
              0.5,
              0.02,
              (fractal) =>
                onUpdateConfig({
                  type: 'subdivide',
                  params: { ...config.params, fractal },
                }),
            )}
          </>
        )}

        {config.type === 'bevel' && (
          <>
            {renderNumberControl(
              'Ancho',
              config.params.width,
              0.01,
              1,
              0.02,
              (width) =>
                onUpdateConfig({
                  type: 'bevel',
                  params: { ...config.params, width },
                }),
            )}
            {renderStepper(
              'Segmentos',
              config.params.segments,
              1,
              5,
              (segments) =>
                onUpdateConfig({
                  type: 'bevel',
                  params: { ...config.params, segments },
                }),
            )}
            {renderNumberControl(
              'Perfil',
              config.params.profile,
              0.1,
              1,
              0.05,
              (profile) =>
                onUpdateConfig({
                  type: 'bevel',
                  params: { ...config.params, profile },
                }),
            )}
            <button
              type="button"
              onClick={() =>
                onUpdateConfig({
                  type: 'bevel',
                  params: {
                    ...config.params,
                    clampOverlap: !config.params.clampOverlap,
                  },
                })
              }
              className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                config.params.clampOverlap
                  ? 'bg-[#2c313b] text-[#ff9900] border-[#ff9900]/50'
                  : 'bg-[#20232b] text-[#a1a7b3] border-[#2f333d] hover:text-white'
              }`}
            >
              Limitar solapamiento
            </button>
          </>
        )}

        {config.type === 'loop_cut' && (
          <>
            {renderStepper('Cortes', config.params.cuts, 1, 8, (cuts) =>
              onUpdateConfig({
                type: 'loop_cut',
                params: { ...config.params, cuts },
              }),
            )}
            {renderNumberControl(
              'Posición',
              config.params.slide,
              -0.9,
              0.9,
              0.05,
              (slide) =>
                onUpdateConfig({
                  type: 'loop_cut',
                  params: { ...config.params, slide },
                }),
            )}
            <button
              type="button"
              onClick={() =>
                onUpdateConfig({
                  type: 'loop_cut',
                  params: { ...config.params, slide: 0 },
                })
              }
              className="h-8 px-2.5 rounded bg-[#20232b] hover:bg-[#2c313b] border border-[#2f333d] text-xs font-medium text-[#b4bac4] hover:text-white transition-colors"
            >
              Centrar
            </button>
          </>
        )}

        {config.type === 'merge' && (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] font-medium text-[#b4bac4] mr-1">
                Destino
              </span>
              {(
                [
                  { id: 'center', label: 'Al centro' },
                  { id: 'first', label: 'Al primero' },
                  { id: 'last', label: 'Al último' },
                  { id: 'cursor', label: 'Coordenada' },
                ] as { id: MergeMode; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    onUpdateConfig({
                      type: 'merge',
                      params: { ...config.params, mode: opt.id },
                    })
                  }
                  className={`h-8 px-2.5 rounded text-xs font-semibold border transition-colors ${
                    config.params.mode === opt.id
                      ? 'bg-[#2c313b] text-[#ff9900] border-[#ff9900]/50'
                      : 'bg-[#20232b] text-[#a1a7b3] border-[#2f333d] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {config.params.mode === 'cursor' && (
              <div className="flex items-center gap-2">
                {(['X', 'Y', 'Z'] as const).map((axisLabel, idx) => {
                  const pos = config.params.cursorPosition ?? [0, 0, 0];
                  return (
                    <label
                      key={axisLabel}
                      className="flex items-center gap-1 text-[11px] text-[#b4bac4]"
                    >
                      <span className="font-semibold">{axisLabel}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={Number(pos[idx].toFixed(3))}
                        onChange={(e) => {
                          const parsed = parseFloat(e.target.value);
                          if (Number.isNaN(parsed)) return;
                          const nextPos: Vec3 = [...pos] as Vec3;
                          nextPos[idx] = parsed;
                          onUpdateConfig({
                            type: 'merge',
                            params: {
                              ...config.params,
                              cursorPosition: nextPos,
                            },
                          });
                        }}
                        className="w-16 h-8 px-1.5 rounded bg-[#111317] border border-[#2f333d] text-xs font-mono-tabular text-[#f3f4f6] text-right focus:outline-none focus:border-[#ff9900]"
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
