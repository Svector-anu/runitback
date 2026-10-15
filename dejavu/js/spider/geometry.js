export function rectOf(el) {
  const parts = el.querySelectorAll('.line-inner');
  if (parts.length === 0) return el.getBoundingClientRect();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const part of parts) {
    const rect = part.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
