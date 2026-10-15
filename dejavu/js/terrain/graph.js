import { CONTOURS, CROSS_LINKS, VIDEO } from './contours.js';

const SAMPLE_STEP = 55;
const MAX_CROSS_DISTANCE = 260;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

function sampleCurve(points) {
  const samples = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const length = Math.hypot((p2[0] - p1[0]) * VIDEO.width, (p2[1] - p1[1]) * VIDEO.height);
    const count = Math.max(1, Math.round(length / SAMPLE_STEP));
    for (let k = 0; k < count; k++) samples.push(catmullRom(p0, p1, p2, p3, k / count));
  }
  samples.push(points[points.length - 1]);
  return samples;
}

const videoDistance = (a, b) =>
  Math.hypot((a.u - b.u) * VIDEO.width, (a.v - b.v) * VIDEO.height);

export function buildGraph() {
  const nodes = [];
  const edges = [];
  const byContour = CONTOURS.map((contour, ci) =>
    sampleCurve(contour.points).map(([u, v], index) => {
      const node = { id: nodes.length, u, v, contour: ci, index, depth: contour.depth, x: 0, y: 0, edges: [] };
      nodes.push(node);
      return node;
    })
  );

  function connect(a, b, kind, bend) {
    const edge = { id: edges.length, a, b, kind, bend, depth: (a.depth + b.depth) / 2, cx: 0, cy: 0, length: 0 };
    edges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
  }

  for (const chain of byContour) {
    for (let i = 0; i < chain.length - 1; i++) connect(chain[i], chain[i + 1], 'along', 0);
  }

  for (const [from, to] of CROSS_LINKS) {
    byContour[from].forEach((node, k) => {
      if (k % 3 !== 0 || (k * 7) % 5 === 0) return;
      let best = null;
      let bestDistance = Infinity;
      for (const candidate of byContour[to]) {
        const distance = videoDistance(node, candidate);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (best && bestDistance < MAX_CROSS_DISTANCE) connect(node, best, 'cross', ((k * 37) % 7 - 3) * 0.09);
    });
  }

  return { nodes, edges };
}

export function layoutGraph(graph, { width, height, focusX, focusY }) {
  const scale = Math.max(width / VIDEO.width, height / VIDEO.height);
  const offsetX = (width - VIDEO.width * scale) * focusX;
  const offsetY = (height - VIDEO.height * scale) * focusY;

  for (const node of graph.nodes) {
    node.x = node.u * VIDEO.width * scale + offsetX;
    node.y = node.v * VIDEO.height * scale + offsetY;
  }
  for (const edge of graph.edges) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    edge.length = Math.hypot(dx, dy);
    edge.cx = (edge.a.x + edge.b.x) / 2 - dy * edge.bend;
    edge.cy = (edge.a.y + edge.b.y) / 2 + dx * edge.bend;
  }
  return scale;
}

export function nearestNode(graph, x, y, maxDistance) {
  let best = null;
  let bestDistance = maxDistance;
  for (const node of graph.nodes) {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

export function shortestPath(graph, from, to) {
  const distance = new Map([[from.id, 0]]);
  const previous = new Map();
  const open = new Set([from.id]);
  while (open.size) {
    let currentId = null;
    for (const id of open) if (currentId === null || distance.get(id) < distance.get(currentId)) currentId = id;
    open.delete(currentId);
    if (currentId === to.id) break;
    const current = graph.nodes[currentId];
    for (const edge of current.edges) {
      const next = edge.a === current ? edge.b : edge.a;
      const candidate = distance.get(currentId) + edge.length;
      if (candidate < (distance.get(next.id) ?? Infinity)) {
        distance.set(next.id, candidate);
        previous.set(next.id, { node: current, edge });
        open.add(next.id);
      }
    }
  }
  if (!previous.has(to.id) && from !== to) return null;
  const path = [];
  let cursor = to.id;
  while (previous.has(cursor)) {
    const step = previous.get(cursor);
    path.unshift({ edge: step.edge, from: step.node, to: graph.nodes[cursor] });
    cursor = step.node.id;
  }
  return path;
}
