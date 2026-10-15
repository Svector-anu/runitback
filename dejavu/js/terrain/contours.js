export const VIDEO = { width: 1920, height: 1080 };

const MOUND = [
  [0.05, 0.5], [0.15, 0.43], [0.25, 0.385], [0.35, 0.355], [0.45, 0.343],
  [0.55, 0.343], [0.65, 0.35], [0.75, 0.375], [0.85, 0.42], [0.95, 0.5],
];

const FOREGROUND = [
  [-0.05, 0.56], [0.0, 0.565], [0.1, 0.585], [0.2, 0.63], [0.3, 0.675], [0.4, 0.705],
  [0.5, 0.72], [0.6, 0.705], [0.7, 0.665], [0.8, 0.625], [0.9, 0.595], [1.0, 0.575], [1.05, 0.57],
];

const shift = (points, dv, flatten, pivot) =>
  points.map(([u, v]) => [u, v + (pivot - v) * flatten + dv]);

export const CONTOURS = [
  { points: MOUND, depth: 0.25 },
  { points: shift(MOUND, 0.06, 0.2, 0.46), depth: 0.35 },
  { points: shift(MOUND, 0.13, 0.45, 0.5), depth: 0.45 },
  { points: FOREGROUND, depth: 0.7 },
  { points: shift(FOREGROUND, 0.07, 0.15, 0.7), depth: 0.8 },
  { points: shift(FOREGROUND, 0.15, 0.3, 0.75), depth: 0.9 },
  { points: shift(FOREGROUND, 0.26, 0.4, 0.8), depth: 1 },
];

export const CROSS_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]];
