/** Render a single git argument for display in the Output Channel log. */
function renderArg(arg: string): string {
  if (arg.length === 0) return '""';
  // Long `--format=<template>` strings add noise to the log, so elide the body.
  if (arg.startsWith("--format=")) return "--format=<…>";
  // Wrap anything containing whitespace in quotes, escaping embedded quotes.
  if (/\s/.test(arg)) return '"' + arg.split('"').join('\\"') + '"';
  return arg;
}

/**
 * Turn a spawned git command's argument list into a single, readable line for
 * the Output Channel log.
 */
export function formatGitCommandArgs(args: string[]): string {
  return args.map(renderArg).join(" ");
}
