const cache = new Map<string, RegExp>();

/**
 * Minimal glob to RegExp: `**`, `*`, `?`, `{a,b}`. A glob without a slash matches the
 * basename at any depth (gitignore style), so `*.tf` matches `infra/main.tf`.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  const src = glob.includes('/') ? glob.replace(/^\.?\//, '') : `**/${glob}`;
  let re = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      depth++;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/[{}]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchGlob(glob: string | readonly string[], path: string): boolean {
  const globs = typeof glob === 'string' ? [glob] : glob;
  return globs.some((g) => globToRegExp(g).test(path));
}
