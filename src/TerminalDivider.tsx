import { useEffect, useRef, useState } from "react";

const storageKey = "svetoch.terminal.width.v1";
/** Меняет ширину соседнего терминала; xterm подстраивается своим ResizeObserver. DOC-PREVIEW:/docs/architecture.md#terminal-divider */
export function TerminalDivider() {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const layout = useRef<{
    parent: HTMLElement;
    terminal: HTMLElement;
    main: HTMLElement;
    fallback: number;
  } | null>(null);
  const preferred = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 355, min: 280, max: 800 });
  const [dragging, setDragging] = useState(false);
  function sync(requested = preferred.current) {
    const nodes = layout.current;
    if (!nodes) return;
    const min = parseFloat(getComputedStyle(nodes.terminal).minWidth) || 280;
    const mainMin = parseFloat(getComputedStyle(nodes.main).minWidth) || 480;
    const max = Math.max(
      min,
      nodes.parent.clientWidth - mainMin - (element.current?.offsetWidth || 8),
    );
    const width = Math.round(
      Math.max(min, Math.min(max, requested ?? nodes.fallback)),
    );
    nodes.terminal.style.width = `${width}px`;
    setSize({ width, min, max: Math.floor(max) });
    return width;
  }
  function save() {
    try {
      if (preferred.current === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred.current));
    } catch {
      /* Недоступное хранилище не мешает изменять ширину в текущем окне. */
    }
  }
  useEffect(() => {
    const parent = element.current?.parentElement;
    const terminal = parent?.querySelector<HTMLElement>(".terminal-pane");
    const main = parent?.querySelector<HTMLElement>(".main-content");
    if (!parent || !terminal || !main) return;
    layout.current = {
      parent,
      terminal,
      main,
      fallback: terminal.getBoundingClientRect().width,
    };
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= 280 && saved <= 10000)
        preferred.current = saved;
    } catch {
      /* Используем исходную ширину из CSS. */
    }
    sync();
    const observer = new ResizeObserver(() => sync());
    observer.observe(parent);
    return () => {
      observer.disconnect();
      terminal.style.removeProperty("width");
      layout.current = null;
    };
  }, []);
  function stop() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    layout.current?.parent.classList.remove("is-resizing");
    save();
  }
  return (
    <div
      ref={element}
      className={`terminal-divider ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label="Ширина терминала"
      aria-orientation="vertical"
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={size.width}
      aria-valuetext={`${size.width} пикселей`}
      tabIndex={0}
      title="Перетащите границу · двойной щелчок — исходная ширина"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: size.width };
        setDragging(true);
        layout.current?.parent.classList.add("is-resizing");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        preferred.current =
          sync(drag.current.width + drag.current.x - e.clientX) ?? size.width;
      }}
      onPointerUp={(e) => {
        stop();
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => {
        preferred.current = null;
        sync();
        save();
      }}
      onKeyDown={(e) => {
        const widths: Record<string, number> = {
          ArrowLeft: size.width + 20,
          ArrowRight: size.width - 20,
          Home: size.min,
          End: size.max,
        };
        if (widths[e.key] === undefined) return;
        e.preventDefault();
        preferred.current = sync(widths[e.key]) ?? size.width;
        save();
      }}
    >
      <span />
    </div>
  );
}
