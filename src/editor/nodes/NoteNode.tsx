import { type NodeProps } from "@xyflow/react";
import { useEditor } from "../store";
import type { NoteNodeData } from "../adapter";

type Color = "yellow" | "green" | "blue" | "pink";

// Keys kept for backward-compat with saved notes; values remapped to the
// white / gray / orange / black palette (orange, amber, gray, plain).
const COLORS: Record<Color, { bg: string; border: string }> = {
  yellow: { bg: "#f8e9d6", border: "#e6c48f" },
  green: { bg: "#f1eee9", border: "#d8d0c4" },
  blue: { bg: "#ffffff", border: "#e7e2da" },
  pink: { bg: "#ffe7e2", border: "#f6b3a5" },
};

/**
 * A sticky-note annotation on the canvas. Editor-only: it lives in graph.notes, has no handles,
 * and the execution engine never reads it. Drag it by the body; type in the note without moving it
 * (the textarea carries React Flow's `nodrag`).
 */
export function NoteNode({ id, data, selected }: NodeProps) {
  const d = data as NoteNodeData;
  const updateNote = useEditor((s) => s.updateNote);
  const color = (d.color ?? "yellow") as Color;
  const c = COLORS[color];

  return (
    <div
      className="note-node"
      style={{ background: c.bg, borderColor: selected ? "var(--signal)" : c.border }}
    >
      <div className="note-node-bar nodrag">
        {(Object.keys(COLORS) as Color[]).map((col) => (
          <button
            key={col}
            className={`note-dot ${col === color ? "on" : ""}`}
            style={{ background: COLORS[col].bg, borderColor: COLORS[col].border }}
            title={col}
            onClick={() => updateNote(id, { color: col })}
            aria-label={`Colour ${col}`}
          />
        ))}
      </div>
      <textarea
        className="note-node-text nodrag nowheel"
        value={d.text}
        placeholder="Write a note…"
        onChange={(e) => updateNote(id, { text: e.target.value })}
      />
    </div>
  );
}
