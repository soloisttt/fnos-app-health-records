type Rect = { left: number; top: number; right: number; bottom: number };

/** Join only short, aligned name continuations supported by a unique result band. */
export function wrappedTableNameGroups<T>(
  pieces: T[],
  rect: (piece: T) => Rect,
  text: (piece: T) => string,
  canJoin: (first: string, second: string) => boolean,
  accepts: (group: T[]) => boolean,
): T[][] {
  const follows = (first: T, second: T) => {
    const a = rect(first), b = rect(second);
    const height = Math.min(a.bottom - a.top, b.bottom - b.top);
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return first !== second && height > 0 && b.top >= a.bottom - height * .2
      && b.top - a.bottom <= height * .7 && Math.abs(a.left - b.left) <= height * .6
      && overlap >= Math.min(a.right - a.left, b.right - b.left) * .7;
  };
  const candidates: T[][] = [];
  for (const first of pieces) {
    if (!/\p{L}/u.test(text(first))) continue;
    const group = [first];
    let name = text(first);
    while (group.length < 4) {
      const next = pieces.filter(piece => follows(group.at(-1)!, piece));
      if (next.length !== 1 || group.includes(next[0]) || !canJoin(name, text(next[0]))) break;
      group.push(next[0]);
      name += text(next[0]);
      if (accepts(group)) candidates.push([...group]);
    }
  }
  // A full three/four-line name supersedes its valid two-line subsets.
  const maximal = candidates.filter(group => !candidates.some(other => other.length > group.length && group.every(piece => other.includes(piece))));
  return maximal.filter(group => maximal.every(other => other === group || !group.some(piece => other.includes(piece))));
}
