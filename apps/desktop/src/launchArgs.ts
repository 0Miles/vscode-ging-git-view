import path from "node:path";

/** What a launch asks the app to do: open `repo`, or nothing. `ignored` is
 *  every argument the app did not take, in the order given, for the log. */
export type LaunchRequest = { repo: string | null; ignored: string[] };

const REPO_SWITCH = "--repo";

/**
 * Read a command line — this process's own, or a later launch's own as it
 * forwarded it ({@link parseForwardedLaunch}) — down to the one thing it may ask for: a
 * repository, as `--repo <path>`, `--repo=<path>`, or a single positional
 * argument. A relative path is taken from `workingDirectory`, which for a
 * forwarded command line is the second instance's.
 *
 * Anything else is ignored and reported, and so is a command line naming more
 * than one repository: that is not a user being ambiguous but something else
 * launching the app. With the RunAsNode fuse off, git running the askpass or
 * sequence editor helper starts the app itself, with the helper's script and
 * the prompt (`Username for '…'`) or the todo file as arguments (#386). Whether
 * the path is a repository is not decided here (#388).
 *
 * `defaultApp` is Electron's `process.defaultApp`: an unpackaged build, run as
 * `electron [switches] <app> [args]`. There the runtime's switches and the
 * app's path come first and are not the user's, so they are skipped without
 * being reported. A packaged build's arguments start right after the
 * executable.
 */
export function parseLaunchArgs(
  argv: readonly string[],
  { defaultApp, workingDirectory }: { defaultApp: boolean; workingDirectory: string }
): LaunchRequest {
  let args = argv.slice(1);
  if (defaultApp) args = args.slice(args.findIndex((arg) => !isSwitch(arg)) + 1 || args.length);

  // Each argument once, in order, marked with the repository it names, if any.
  const read: { tokens: string[]; repo: string | null }[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === REPO_SWITCH && i + 1 < args.length && !isSwitch(args[i + 1])) {
      read.push({ tokens: [arg, args[i + 1]], repo: args[i + 1] });
      i++;
    } else if (arg.startsWith(`${REPO_SWITCH}=`) && arg.length > REPO_SWITCH.length + 1) {
      read.push({ tokens: [arg], repo: arg.slice(REPO_SWITCH.length + 1) });
    } else {
      read.push({ tokens: [arg], repo: isSwitch(arg) ? null : arg });
    }
  }

  const named = read.filter((r) => r.repo !== null);
  const taken = named.length === 1 ? named[0] : null;
  return {
    repo: taken === null ? null : path.resolve(workingDirectory, taken.repo!),
    ignored: read.filter((r) => r !== taken).flatMap((r) => r.tokens)
  };
}

/**
 * What a later launch hands the running instance through the single-instance
 * lock's `additionalData`: its own command line, untouched, and where it was
 * started. The command line Electron forwards beside it is no use: Chromium
 * moves every switch ahead of the positional arguments and adds its own, so
 * `--repo <path>` arrives as `--repo … <app> <path>` and a switch can no longer
 * be told from the runtime's (seen on Windows, Electron 45; #386).
 */
export type ForwardedLaunch = { argv: string[]; workingDirectory: string };

/** Read a later launch's {@link ForwardedLaunch}; `null` when the data is not
 *  one (a build that forwards nothing, or something else entirely). */
export function parseForwardedLaunch(
  data: unknown,
  { defaultApp }: { defaultApp: boolean }
): LaunchRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const { argv, workingDirectory } = data as Partial<Record<keyof ForwardedLaunch, unknown>>;
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) return null;
  if (typeof workingDirectory !== "string") return null;
  return parseLaunchArgs(argv, { defaultApp, workingDirectory });
}

function isSwitch(arg: string): boolean {
  return arg.startsWith("-");
}
