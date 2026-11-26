import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, PenTool, RotateCcw } from 'lucide-react';

interface SignaturePadProps {
  onChange: (dataUrl: string | null) => void;
  label?: string;
}

export function SignaturePad({
  onChange,
  label = 'Elektron imzo maydoni',
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const hasStrokesRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);

  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(Math.round(rect.width), 240);
    const height = Math.max(Math.round(rect.height), 160);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    initCanvas();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    let prevW = Math.round(canvas.getBoundingClientRect().width);
    const ro = new ResizeObserver(() => {
      const nextW = Math.round(canvas.getBoundingClientRect().width);
      if (nextW > 0 && Math.abs(nextW - prevW) > 8 && !hasStrokesRef.current) {
        prevW = nextW;
        initCanvas();
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [initCanvas]);

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const logicalW = canvas.width / dpr;
    const logicalH = canvas.height / dpr;
    const scaleX = rect.width > 0 ? logicalW / rect.width : 1;
    const scaleY = rect.height > 0 ? logicalH / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture is unsupported on some mobile webviews
    }
    isDrawingRef.current = true;
    const pt = getPoint(e);
    lastPointRef.current = pt;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
    }
    if (!hasStrokesRef.current) {
      hasStrokesRef.current = true;
      setHasStrokes(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !lastPointRef.current) return;

    const pt = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPointRef.current = pt;
  };

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPointRef.current = null;
    const canvas = canvasRef.current;
    if (canvas && e) {
      try {
        if (canvas.hasPointerCapture?.(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }
    }
    if (canvas && hasStrokesRef.current) {
      onChange(canvas.toDataURL('image/png'));
    }
  };

  const handleClear = () => {
    hasStrokesRef.current = false;
    initCanvas();
    setHasStrokes(false);
    onChange(null);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <PenTool className="w-4 h-4 text-blue-700" />
          <span>{label}</span>
        </label>
        <span className="text-xs text-slate-500">
          Sichqoncha yoki barmoq bilan chizing
        </span>
      </div>

      <div className="relative rounded-xl border border-slate-300 bg-white overflow-hidden">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerLeave={finishStroke}
          className="w-full h-44 cursor-crosshair block touch-none select-none"
          aria-label="Elektron imzo chizish maydoni"
        />
        {!hasStrokes && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-slate-400 text-sm px-4 text-center">
            <span>Shu yerga imzo qo‘ying</span>
            <span className="text-xs text-slate-400 mt-1">
              Sensorli ekran va sichqoncha qo‘llab-quvvatlanadi
            </span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-6 bottom-5 border-b border-dashed border-slate-200" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-slate-500">
          {hasStrokes ? 'Imzo kiritildi' : 'Imzo kiritilmagan'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Eraser className="w-3.5 h-3.5" />
            <span>Imzoni tozalash</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Qayta chizish</span>
          </button>
        </div>
      </div>
    </div>
  );
}
