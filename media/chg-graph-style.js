// ── Cytoscape.js style for the CHG visual editor ──────────────────────────────
// Edit this file to change how nodes, edges, and connections look in the graph.
// Colors are read from the CSS custom properties defined in chg-editor.css.
// Sizes, shapes, opacities, and font settings are configured directly below.

/* global cytoscape */

/**
 * Returns the Cytoscape style array used to initialise the graph.
 * Called once on startup; re-call and pass to cy.style() to hot-reload styles.
 */
function buildCyStyle() { // eslint-disable-line no-unused-vars
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const fg        = cssVar('--chg-fg')         || '#cccccc';
  const nodeFill  = cssVar('--chg-node-fill')  || '#0e639c';
  const edgeFill  = cssVar('--chg-edge-fill')  || '#c97f47';
  const selColor  = cssVar('--chg-sel-color')  || '#007fd4';
  const connColor = cssVar('--chg-conn-color') || '#555555';
  const simColor  = cssVar('--chg-sim-color')  || '#ffcc00';

  return [

    // ── CHG nodes (ellipses) ────────────────────────────────────────────────
    {
      selector: 'node[type="chg-node"]',
      style: {
        'shape':              'ellipse',
        'background-color':   nodeFill,
        'background-opacity': 0.85,
        'border-width':       2,
        'border-color':       nodeFill,
        'border-opacity':     0.9,
        'label':              'data(label)',
        'color':              fg,
        'text-valign':        'center',
        'text-halign':        'center',
        'font-size':          '11px',
        'text-wrap':          'ellipsis',
        'text-max-width':     '72px',
        'width':              64,
        'height':             40,
      },
    },

    // ── CHG hyperedge nodes (rounded rectangles) ────────────────────────────
    // Labels are hidden in display mode; shown when the node has .label-visible
    {
      selector: 'node[type="chg-edge"]',
      style: {
        'shape':              'round-rectangle',
        'background-color':   edgeFill,
        'background-opacity': 0.5,
        'border-width':       1,
        'border-color':       edgeFill,
        'border-opacity':     0.55,
        'label':              '',
        'color':              fg,
        'text-valign':        'center',
        'text-halign':        'center',
        'font-size':          '10px',
        'text-wrap':          'ellipsis',
        'text-max-width':     '72px',
        'width':              36,
        'height':             24,
        'opacity':            0.65,
      },
    },

    // ── Bipartite connections ───────────────────────────────────────────────
    {
      selector: 'edge',
      style: {
        'line-color':         connColor,
        'target-arrow-color': connColor,
        'target-arrow-shape': 'triangle',
        'curve-style':        'bezier',
        'opacity':            0.5,
        'width':              1.5,
        'arrow-scale':        0.8,
      },
    },

    // ── Selected element ────────────────────────────────────────────────────
    {
      selector: '.selected',
      style: {
        'border-width':       3,
        'border-color':       selColor,
        'border-opacity':     1,
        'background-opacity': 1,
        'opacity':            1,
      },
    },

    // ── Dimmed (unfocused) elements in focused mode ─────────────────────────
    {
      selector: '.dimmed',
      style: { 'opacity': 0.1 },
    },

    // ── Hyperedge nodes shown with label in focused mode ────────────────────
    {
      selector: 'node.label-visible[type="chg-edge"]',
      style: {
        'label':              'data(label)',
        'opacity':            1,
        'background-opacity': 0.9,
      },
    },

    // ── Simulated path highlight ─────────────────────────────────────────────
    {
      selector: 'node.sim-path',
      style: {
        'border-width':   4,
        'border-color':   simColor,
        'border-opacity': 1,
        'opacity':        1,
      },
    },
    {
      selector: 'edge.sim-path',
      style: {
        'line-color':         simColor,
        'target-arrow-color': simColor,
        'opacity':            1,
        'width':              2.5,
      },
    },

  ];
}
