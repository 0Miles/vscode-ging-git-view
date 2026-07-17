import type { SimpleGit } from "simple-git";

export type CreateArchiveInput = { ref: string; outputPath: string };

/** Write an archive of `ref` to `outputPath`. The archive format is inferred
 *  from the output file extension (.zip → zip, otherwise tar). */
export async function createArchive(git: SimpleGit, input: CreateArchiveInput): Promise<void> {
  const format = input.outputPath.toLowerCase().endsWith(".zip") ? "zip" : "tar";
  await git.raw(["archive", "--format", format, "-o", input.outputPath, input.ref]);
}
