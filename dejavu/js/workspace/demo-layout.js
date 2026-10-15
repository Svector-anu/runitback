export const VIEW = { width: 1000, height: 640 };

const POSITIONS = {
  'demo:wallet:w7': [500, 360],
  'demo:wallet:w2': [280, 200],
  'demo:wallet:w3': [720, 190],
  'demo:wallet:w5': [220, 450],
  'demo:contract:c1': [780, 450],
  'demo:token:t1': [500, 570],
  'demo:wallet:w11': [500, 90],
  'demo:wallet:w9': [500, 235],
  'demo:wallet:w14': [110, 110],
  'demo:wallet:w15': [100, 310],
  'demo:web_page:p1': [890, 80],
  'demo:wallet:w8': [900, 340],
  'demo:token:t2': [880, 560],
};

export function knownPosition(entityId) {
  const known = POSITIONS[entityId];
  return known ? { x: known[0], y: known[1] } : null;
}
