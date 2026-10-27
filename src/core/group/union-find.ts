/** Disjoint-set over arbitrary string keys. */
export class UnionFind {
  private readonly parent = new Map<string, string>();

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  /** Sets of keys, in first-insertion order of their earliest member. */
  groups(): string[][] {
    const byRoot = new Map<string, string[]>();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      byRoot.set(r, [...(byRoot.get(r) ?? []), k]);
    }
    return [...byRoot.values()];
  }
}
