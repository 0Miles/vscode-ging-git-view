import path from "node:path";

/** What a launch asks the app to do: open `repo`, or nothing. `ignored` is
 *  every argument the app did not take, in the order given, for the log. */
export type LaunchRequest = { repo: string | null; ignored: string[] };

/**
 * A launch's command line as its own process saw it, and where it was started.
 *
 * A later launch hands its own to the running instance through the
 * single-instance lock's `additionalData`. The command line Electron forwards
 * beside it is no use: Chromium moves every switch ahead of the positional
 * arguments and adds its own, so `--repo <path>` arrives as
 * `--repo … <app> <path>` and a switch can no longer be told from the runtime's
 * (seen on Windows, Electron 45; #386).
 */
export type LaunchCommandLine = { argv: string[]; workingDirectory: string };

const REPO_SWITCH = "--repo";

/** One argument, or `--repo` with its path, and the repository it names. */
type Claim = { tokens: string[]; repo: string | null };

/**
 * Read a command line down to the one thing it may ask for: a repository, as
 * `--repo <path>` or a single positional argument. A relative path is taken
 * from the launch's own working directory.
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
  { argv, workingDirectory }: LaunchCommandLine,
  { defaultApp }: { defaultApp: boolean }
): LaunchRequest {
  let args = argv.slice(1);
  if (defaultApp) {
    // The runtime's switches, then the app's path, then the user's arguments.
    const appPath = args.findIndex((arg) => !isSwitch(arg));
    args = appPath === -1 ? [] : args.slice(appPath + 1);
  }

  // Each argument once, in order, with the repository it would open, if any.
  const claims: Claim[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === REPO_SWITCH && i + 1 < args.length && !isSwitch(args[i + 1])) {
      claims.push({ tokens: [arg, args[i + 1]], repo: args[i + 1] });
      i++;
    } else {
      claims.push({ tokens: [arg], repo: isSwitch(arg) ? null : arg });
    }
  }

  const naming = claims.filter((c): c is Claim & { repo: string } => c.repo !== null);
  const taken = naming.length === 1 ? naming[0] : null;
  return {
    repo: taken === null ? null : path.resolve(workingDirectory, taken.repo),
    ignored: claims.filter((c) => c !== taken).flatMap((c) => c.tokens)
  };
}

/** Read what a later launch forwarded; `null` when the data is not a
 *  {@link LaunchCommandLine} (a build that forwards nothing, or something else
 *  entirely). */
export function parseForwardedLaunch(
  data: unknown,
  options: { defaultApp: boolean }
): LaunchRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const { argv, workingDirectory } = data as Partial<Record<keyof LaunchCommandLine, unknown>>;
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) return null;
  if (typeof workingDirectory !== "string") return null;
  return parseLaunchArgs({ argv, workingDirectory }, options);
}

function isSwitch(arg: string): boolean {
  return arg.startsWith("-");
}
