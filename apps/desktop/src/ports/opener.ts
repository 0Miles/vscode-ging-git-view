/* The desktop `Opener` (`@ging/core/host/ports`) for now (#388): opening
 * files, diffs, terminals and links is #391's. Until then each request is
 * logged and answered as the port's contract answers a failure, so the graph
 * reports that nothing opened rather than waiting on it. */

import type { HostLogger, Opener } from "@ging/core/host/ports";

export function createInterimOpener(logger: Pick<HostLogger, "logError">): Opener {
  /** Log that `method` was asked for `about`: the whole answer of a method
   *  that answers nothing. */
  const say = (method: string, about: string) =>
    logger.logError(`Opener.${method} is not available yet (#391): ${about}`);
  /** Log it and fail: a rejection, from the methods that answer a promise. */
  const fail = (method: string, about: string): never => {
    say(method, about);
    throw new Error(`Opener.${method} is not available yet`);
  };
  return {
    openFile: async (file) => fail("openFile", file),
    openFileAtRevision: async (file) =>
      fail("openFileAtRevision", `${file.filePath} at ${file.commit}`),
    diffWithWorking: async (_left, workingPath) => fail("diffWithWorking", workingPath),
    openCommitDiff: async (request) => {
      say("openCommitDiff", `${request.newFilePath} at ${request.commitHash}`);
      return false;
    },
    openMergeEditor: (_repo, filePath) => say("openMergeEditor", filePath),
    openTerminal: (cwd) => say("openTerminal", cwd),
    openExternalUrl: (url) => say("openExternalUrl", url)
  };
}
