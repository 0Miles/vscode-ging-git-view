/*---------------------------------------------------------------------------------------------
 *  Standalone helper git runs as GIT_SEQUENCE_EDITOR, following the same
 *  node-behind-a-shell-script shape as the askpass helper next door.
 *  It replaces the todo git generated for an interactive rebase with the one
 *  the extension staged.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "node:fs";

/**
 * Copy the staged todo over git's, then delete the staged file.
 *
 * The delete is the contract, not tidiness. GIT_SEQUENCE_EDITOR is set for
 * every git child the extension spawns, so the staged file is the only thing
 * that says "this particular rebase wants a todo of its own": present means
 * replace, absent means leave git's alone. Removing it on use makes the file's
 * survival a fact the caller can test — a staged todo still sitting there after
 * git returned means this helper never ran, and the caller reports that rather
 * than letting a rebase that silently kept every commit pass for success.
 */
function main(argv: string[]): void {
  const todoPath = argv[2];
  if (todoPath === undefined) {
    process.stderr.write("No todo path was passed to the sequence editor.\n");
    process.exit(1);
  }
  const staged = process.env["GING_REBASE_TODO"];
  // Nothing staged: an interactive rebase this extension did not prepare, so
  // git's own todo stands.
  if (staged === undefined || staged === "" || !fs.existsSync(staged)) return;
  try {
    fs.copyFileSync(staged, todoPath);
    fs.unlinkSync(staged);
  } catch (e: unknown) {
    process.stderr.write("Could not apply the prepared rebase todo.\n");
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  }
}

main(process.argv);
