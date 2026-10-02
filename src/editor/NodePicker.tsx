import { useState } from "react";
import { useEditor } from "./store";
import { CATEGORY_ORDER, NODE_DEFS } from "./nodeDefs";
import { NODE_ICON } from "./nodes/icons";
import { CATEGORY_ACCENT } from "./nodeDefs";
import type { NodeType } from "../lib/types";

/** The node library, opened from the toolbar so it never overlaps the settings drawer. */
export function NodePicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const addNode = useEditor((s) => s.addNode);

  const q = query.trim().toLowerCase();
  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    defs: Object.values(NODE_DEFS).filter(
      (d) =>
        d.addable &&
        d.category === cat &&
        (!q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) || d.category.toLowerCase().includes(q)),
    ),
  })).filter((g) => g.defs.length > 0);

  return (
    <div className="picker">
      <button className="btn btn-outline" onClick={() => { setOpen((o) => !o); setQuery(""); }}>
        + Add step
      </button>
      {open && (
        <>
          <div className="picker-scrim" onClick={() => setOpen(false)} />
          <div className="picker-menu">
            <input
              className="input"
              autoFocus
              placeholder="Search steps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            {groups.length === 0 && <div className="picker-empty">No steps match.</div>}
            {groups.map((g) => (
              <div key={g.cat} className="picker-group">
                <div className="picker-cat">{g.cat}</div>
                {g.defs.map((d) => (
                  <button
                    key={d.type}
                    className="picker-item"
                    onClick={() => { addNode(d.type as NodeType); setOpen(false); }}
                  >
                    <span className="picker-ic" style={{ background: `${CATEGORY_ACCENT[d.category]}1e` }}>
                      {NODE_ICON[d.type]}
                    </span>
                    <span className="picker-text">
                      <span className="picker-name">{d.name}</span>
                      <span className="picker-desc">{d.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
