/** A script's `--key=value` arguments as a map; a bare `--flag` maps to '1'. */
export const cliArgs = (argv = process.argv.slice(2)) =>
  new Map(argv.map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
