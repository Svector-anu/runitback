function pull(point, from, length) {
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const dist = Math.hypot(dx, dy) || 1e-6;
  point.x = from.x + (dx / dist) * length;
  point.y = from.y + (dy / dist) * length;
}

export function solveFabrik(joints, lengths, anchor, target, iterations = 3) {
  const last = joints.length - 1;
  const reach = lengths.reduce((sum, length) => sum + length, 0);
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const dist = Math.hypot(dx, dy);

  joints[0].x = anchor.x;
  joints[0].y = anchor.y;

  if (dist >= reach) {
    let travelled = 0;
    for (let i = 1; i <= last; i++) {
      travelled += lengths[i - 1];
      joints[i].x = anchor.x + (dx / dist) * travelled;
      joints[i].y = anchor.y + (dy / dist) * travelled;
    }
    return;
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    joints[last].x = target.x;
    joints[last].y = target.y;
    for (let i = last - 1; i >= 0; i--) pull(joints[i], joints[i + 1], lengths[i]);

    joints[0].x = anchor.x;
    joints[0].y = anchor.y;
    for (let i = 1; i <= last; i++) pull(joints[i], joints[i - 1], lengths[i - 1]);
  }
}
