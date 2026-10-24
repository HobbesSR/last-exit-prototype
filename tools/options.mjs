/**
 * The maintained tools' strict `--name=value` options. Any other argument, a name outside
 * `names`, or with `unique` a repeated name, throws `invalid(argument)`; otherwise the last
 * value given for a name wins.
 */
export function options(argv, names, invalid, { unique = false } = {}) {
  const args = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !names.includes(match[1]) || (unique && args.has(match[1]))) throw new Error(invalid(argument));
    args.set(match[1], match[2]);
  }
  return args;
}
