import type { SimpleGit } from "simple-git";

import type { QueryResult } from "@/backend/types";

const sep = "XX7Nal-YARtTpjCikii9nJxER19D6diSyk-TagDt";

type TagDetailsInput = { tagName: string };

/** Read the tagger details and message of an annotated tag. Returns null for
 *  lightweight tags (which have no tagger/message) or if the tag is missing. */
export async function tagDetails(
  git: SimpleGit,
  input: TagDetailsInput
): Promise<QueryResult<"tagDetails">> {
  try {
    const format = [
      "%(objecttype)",
      "%(objectname)", // the annotated tag object's hash
      "%(*objectname)", // the commit the tag dereferences to
      "%(taggername)",
      "%(taggeremail)",
      "%(taggerdate:unix)"
    ].join(sep);
    const stdout = await git.raw([
      "for-each-ref",
      `--format=${format}${sep}%(contents)`,
      "refs/tags/" + input.tagName
    ]);
    const parts = stdout.split(sep);
    // A lightweight tag points directly at a commit (objecttype "commit") and
    // has no tagger; only annotated tags ("tag") carry details.
    if (parts.length < 7 || parts[0].trim() !== "tag") return { details: null };
    const dateNum = parseInt(parts[5]);
    // `git tag -v` exits 0 only when the tag carries a verifiable, good
    // signature; treat any failure (unsigned or unverifiable) as no signature.
    // This runs only when a tag's details are opened, so the cost is fine.
    let signatureStatus = "";
    try {
      await git.raw(["tag", "-v", input.tagName]);
      signatureStatus = "G";
    } catch {
      signatureStatus = "";
    }
    return {
      details: {
        tagHash: parts[1].trim(),
        commitHash: parts[2].trim(),
        name: parts[3],
        email: parts[4].replace(/^</, "").replace(/>$/, ""),
        date: Number.isNaN(dateNum) ? null : dateNum,
        signatureStatus,
        message: parts.slice(6).join(sep).trim()
      }
    };
  } catch {
    return { details: null };
  }
}
