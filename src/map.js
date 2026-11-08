// Citation map: a force-directed graph of a project's papers, what they cite and what cites them.
// Edges point from the citing paper to the cited one. Rendering is plain SVG driven by d3-force.
import {forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY} from 'd3-force';
import {select} from 'd3-selection';
import {zoom, zoomIdentity} from 'd3-zoom';
import {drag} from 'd3-drag';

const NS = 'http://www.w3.org/2000/svg';
const radius = n => n.kind === 'library' ? 9 + Math.min(7, Math.log10((n.citedBy ?? 0) + 1) * 2) : 3.5 + Math.min(7, Math.log10((n.citedBy ?? 0) + 1) * 1.6);
// Project papers, shared papers and expanded ones carry a label, so they need extra room.
const labelled = n => n.kind === 'library' || n.degree >= 2 || n.expanded;
const short = n => `${(n.authors?.[0] || n.title || '?').split(' ').pop()}${n.year ? ' ' + n.year : ''}`;

export function createMap(svgEl, {onSelect, onHover} = {}) {
  const svg = select(svgEl);
  svg.selectAll('*').remove();
  const defs = svg.append('defs');
  for (const [id, color] of [['arrow', '#9fb3a4'], ['arrow-hot', '#2f584a']]) {
    defs.append('marker').attr('id', id).attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color);
  }
  const root = svg.append('g'), linkLayer = root.append('g').attr('class', 'links'), nodeLayer = root.append('g').attr('class', 'nodes');
  const zoomer = zoom().scaleExtent([0.15, 4]).on('zoom', e => root.attr('transform', e.transform));
  svg.call(zoomer).on('dblclick.zoom', null);

  let all = {nodes: new Map(), edges: new Map()}, filters = {refs: true, citing: true, shared: false, byYear: false};
  let sim = null, selected = null, visible = {nodes: [], edges: []};

  // Links to the project's papers decide what "shared" means and which external papers matter most.
  function libraryDegree() {
    const lib = new Set([...all.nodes.values()].filter(n => n.kind === 'library').map(n => n.id)), deg = new Map();
    for (const e of all.edges.values()) {
      if (lib.has(e.source)) deg.set(e.target, (deg.get(e.target) || 0) + 1);
      if (lib.has(e.target)) deg.set(e.source, (deg.get(e.source) || 0) + 1);
    }
    return deg;
  }
  function computeVisible() {
    const deg = libraryDegree();
    const show = n => n.kind === 'library' || n.expanded || n.fromExpand ||
      ((n.kind === 'reference' ? filters.refs : n.kind === 'citing' ? filters.citing : filters.refs || filters.citing) && (!filters.shared || (deg.get(n.id) || 0) >= 2));
    const nodes = [...all.nodes.values()].filter(show), ids = new Set(nodes.map(n => n.id));
    for (const n of nodes) n.degree = deg.get(n.id) || 0;
    return {nodes, edges: [...all.edges.values()].filter(e => ids.has(e.source.id ?? e.source) && ids.has(e.target.id ?? e.target)).map(e => ({...e, source: e.source.id ?? e.source, target: e.target.id ?? e.target}))};
  }

  // Years map to fixed x positions in "arrange by year" mode (papers without a year float freely).
  function yearScale(nodes) {
    const years = nodes.map(n => n.year).filter(Boolean);
    const lo = Math.min(...years), hi = Math.max(...years), w = Math.max(900, Math.min(2400, (hi - lo) * 60));
    const f = y => !y || !years.length ? null : hi === lo ? 0 : (y - lo) / (hi - lo) * w - w / 2;
    f.lo = lo; f.hi = hi; return f;
  }
  const axis = root.insert('g', ':first-child').attr('class', 'year-axis');
  function drawAxis(ys, nodes) {
    axis.selectAll('*').remove();
    if (!filters.byYear || !Number.isFinite(ys.lo)) return;
    const ext = nodes.reduce((a, n) => [Math.min(a[0], n.y ?? 0), Math.max(a[1], n.y ?? 0)], [Infinity, -Infinity]);
    const top = Math.min(-300, ext[0] - 60), bottom = Math.max(300, ext[1] + 60), step = ys.hi - ys.lo > 40 ? 10 : ys.hi - ys.lo > 12 ? 5 : ys.hi - ys.lo > 5 ? 2 : 1;
    for (let y = Math.ceil(ys.lo / step) * step; y <= ys.hi; y += step) {
      const x = ys(y);
      axis.append('line').attr('x1', x).attr('x2', x).attr('y1', top).attr('y2', bottom);
      axis.append('text').attr('x', x).attr('y', bottom + 18).text(y);
    }
  }

  function draw(reheat = 1) {
    visible = computeVisible();
    const ys = yearScale(visible.nodes);
    sim?.stop();
    sim = forceSimulation(visible.nodes)
      .force('link', forceLink(visible.edges).id(n => n.id).distance(e => (e.source.kind === 'library' && e.target.kind === 'library') ? 140 : 70).strength(filters.byYear ? 0.02 : 0.5))
      .force('charge', forceManyBody().strength(n => (n.kind === 'library' ? -420 : -70) * (filters.byYear ? 1.8 : 1)))
      .force('collide', forceCollide(n => radius(n) + 3 + (labelled(n) ? 16 : 0)).strength(0.9))
      .force('x', forceX(0).strength(filters.byYear ? 0 : 0.04))
      // Timeline lanes: cited works above, the project's papers in the middle, citing works below.
      .force('y', forceY(n => !filters.byYear ? 0 : n.kind === 'reference' ? -170 : n.kind === 'citing' ? 170 : 0).strength(filters.byYear ? 0.12 : 0.04))
      .alpha(reheat);
    // Timeline: pin x to the year; only vertical positions are laid out.
    for (const n of visible.nodes) n.fx = filters.byYear && n.year ? ys(n.year) : null;
    sim.on('end.axis', () => drawAxis(ys, visible.nodes));
    drawAxis(ys, visible.nodes);

    const links = linkLayer.selectAll('line').data(visible.edges, e => `${e.source.id ?? e.source}>${e.target.id ?? e.target}`);
    links.exit().remove();
    links.enter().append('line').attr('marker-end', 'url(#arrow)');

    const nodes = nodeLayer.selectAll('g.node').data(visible.nodes, n => n.id);
    nodes.exit().remove();
    const enter = nodes.enter().append('g').attr('class', n => `node ${n.kind}`).attr('tabindex', 0)
      .on('click', (e, n) => { e.stopPropagation(); setSelected(n); onSelect?.(n); })
      .on('keydown', (e, n) => { if (e.key === 'Enter') { setSelected(n); onSelect?.(n); } })
      .on('mouseenter', (e, n) => hover(n)).on('mouseleave', () => hover(null))
      .call(drag().on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.2).restart(); if (!(filters.byYear && n.year)) n.fx = n.x; n.fy = n.y; })
        .on('drag', (e, n) => { if (!(filters.byYear && n.year)) n.fx = e.x; n.fy = e.y; })
        .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = filters.byYear && n.year ? n.fx : null; n.fy = null; }));
    enter.append('circle');
    enter.append('text').attr('dy', n => -radius(n) - 4);
    enter.append('title');
    const merged = enter.merge(nodes);
    merged.attr('class', n => `node ${n.kind}${n.id === selected ? ' selected' : ''}${n.degree >= 2 && n.kind !== 'library' ? ' shared' : ''}`);
    merged.select('circle').attr('r', radius);
    merged.select('text').text(n => labelled(n) ? short(n) : '');
    merged.select('title').text(n => `${n.title || 'Untitled'}\n${[n.authors?.slice(0, 3).join(', '), n.year, n.venue].filter(Boolean).join(' · ')}${n.citedBy != null ? `\nCited by ${n.citedBy}` : ''}`);

    const lineSel = linkLayer.selectAll('line'), nodeSel = nodeLayer.selectAll('g.node');
    sim.on('tick', () => {
      lineSel.each(function (e) {
        const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.hypot(dx, dy) || 1, r = radius(e.target) + 2;
        this.setAttribute('x1', e.source.x); this.setAttribute('y1', e.source.y);
        this.setAttribute('x2', e.target.x - dx / d * r); this.setAttribute('y2', e.target.y - dy / d * r);
      });
      nodeSel.attr('transform', n => `translate(${n.x},${n.y})`);
    });
  }

  function hover(n) {
    const near = new Set(n ? [n.id] : []);
    if (n) for (const e of visible.edges) { if (e.source.id === n.id) near.add(e.target.id); if (e.target.id === n.id) near.add(e.source.id); }
    nodeLayer.selectAll('g.node').classed('dim', d => !!n && !near.has(d.id)).classed('hot', d => !!n && near.has(d.id));
    linkLayer.selectAll('line').classed('hot', e => !!n && (e.source.id === n.id || e.target.id === n.id)).attr('marker-end', e => n && (e.source.id === n.id || e.target.id === n.id) ? 'url(#arrow-hot)' : 'url(#arrow)');
    onHover?.(n);
  }
  function setSelected(n) {
    selected = n?.id ?? null;
    nodeLayer.selectAll('g.node').classed('selected', d => d.id === selected);
  }
  svg.on('click', () => { setSelected(null); onSelect?.(null); });

  // Fit the drawing into view once the layout has settled a little.
  function fit(ms = 600) {
    const box = nodeLayer.node().getBBox(), {width, height} = svgEl.getBoundingClientRect(); // papers only, not the year axis
    if (!box.width || !width) return;
    const k = Math.min(2, 0.9 / Math.max(box.width / width, box.height / height));
    const t = zoomIdentity.translate(width / 2 - k * (box.x + box.width / 2), height / 2 - k * (box.y + box.height / 2)).scale(k);
    svg.transition ? svg.transition().duration(ms).call(zoomer.transform, t) : svg.call(zoomer.transform, t);
  }

  return {
    // Replace the graph (keeps positions of nodes that stay).
    setData({nodes, edges}) {
      const old = all.nodes;
      all = {nodes: new Map(nodes.map(n => [n.id, Object.assign(old.get(n.id) || {}, n)])), edges: new Map(edges.map(e => [`${e.source}>${e.target}`, e]))};
      draw(1);
      setTimeout(() => fit(), 900);
    },
    // Add a paper's own references and citing works around it.
    expand(id, {refs = [], citing = []}) {
      const center = all.nodes.get(id); if (!center) return;
      center.expanded = true;
      const add = (rec, kind) => {
        let n = all.nodes.get(rec.openalexId);
        if (!n) { n = {...rec, id: rec.openalexId, kind, fromExpand: true, x: center.x + (Math.random() - 0.5) * 40, y: center.y + (Math.random() - 0.5) * 40}; all.nodes.set(n.id, n); }
        return n.id;
      };
      for (const r of refs) { const t = add(r, 'reference'); all.edges.set(`${id}>${t}`, {source: id, target: t}); }
      for (const c of citing) { const s = add(c, 'citing'); all.edges.set(`${s}>${id}`, {source: s, target: id}); }
      draw(0.6);
    },
    setFilters(f) { Object.assign(filters, f); draw(0.8); setTimeout(() => fit(), 900); },
    counts() { const c = {library: 0, reference: 0, citing: 0, both: 0, shared: 0}; for (const n of visible.nodes) { c[n.kind]++; if (n.kind !== 'library' && n.degree >= 2) c.shared++; } return {...c, edges: visible.edges.length}; },
    node: id => all.nodes.get(id),
    fit,
    destroy() { sim?.stop(); svg.on('.zoom', null); svg.selectAll('*').remove(); },
  };
}
