/* The desktop `Opener` (`@ging/core/host/ports`) for now (#388): opening
 * files, diffs, terminals and links is #391's. Until then each request is
 * logged and answered as the port's contract answers a failure, so the graph
 * reports that nothing opened rather than waiting on it. */

import type { HostLogger, Opener } from "@ging/core/host/ports";

export function createInterimOpener(logger: Pick<HostLogger, "logError">): Opener {
  const notYet = (method: string, about: string) =>
    logger.logError(`Opener.${method} is not available yet (#391): ${about}`);
  return {
    openFile: async (file) => {
      notYet("openFile", file);
      throw new Error("not available yet");
    },
    openFileAtRevision: async (file) => {
      notYet("openFileAtRevision", `${file.filePath} at ${file.commit}`);
      throw new Error("not available yet");
    },
    diffWithWorking: async (_left, workingPath) => {
      notYet("diffWithWorking", workingPath);
      throw new Error("not available yet");
    },
    openCommitDiff: async (request) => {
      notYet("openCommitDiff", `${request.newFilePath} at ${request.commitHash}`);
      return false;
    },
    openMergeEditor: (_repo, filePath) => notYet("openMergeEditor", filePath),
    openTerminal: (cwd) => notYet("openTerminal", cwd),
    openExternalUrl: (url) => notYet("openExternalUrl", url)
  };
}
