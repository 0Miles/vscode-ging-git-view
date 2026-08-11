/**
 * Pure (vscode-free) construction of the Branches side-view tree from the flat
 * branch list returned by `loadBranches`. Branch names are grouped into folders
 * by their "/" segments (e.g. `feature/login` → folder `feature` ⟩ leaf `login`).
 * Remote-tracking branches keep their original `remotes/<remote>/…` value (used
 * verbatim as the filter ref and for git operations) but display under the
 * remote name, with the `remotes/` prefix stripped.
 *
 * Kept free of any `vscode` import so it can be unit-tested in the fast backend
 * test project; the TreeItem rendering lives in `branchesView.ts`.
 */

import { displayRef, PRIMARY_BRANCHES, REMOTE_PREFIX } from "@/backend/utils/branchRef";

export type BranchTreeLeaf = {
  type: "leaf";
  /** The original ref string, e.g. `main` or `remotes/origin/main`. Used as the
   *  graph filter value and for git operations. */
  branch: string;
  /** The last path segment shown as the tree label, e.g. `login`. */
  name: string;
  /** True when this is the repo's checked-out branch (`head`). */
  isHead: boolean;
  /** True for a remote-tracking branch (`remotes/…`). */
  isRemote: boolean;
  /** True when already merged into the default branch. A fact: set even for
   *  branches that are never hidden. The view renders these with a badge. */
  isMerged: boolean;
  /** True when the last commit predates the inactivity threshold. Likewise a
   *  fact; the view renders these with an age label. */
  isInactive: boolean;
  /** True when one of the hide toggles would remove this branch — i.e. it is
   *  merged or inactive and not exempt. The view renders these dimmed, so the
   *  grey exactly predicts what pressing "hide" does (ADR-0003). */
  isHidable: boolean;
  /** Last commit time (unix seconds) when known, for the age label. */
  lastActivitySec?: number;
};

export type BranchTreeFolder = {
  type: "folder";
  /** The folder's own segment, shown as the tree label. */
  name: string;
  /** The full slash-joined path from the root, used for a stable tree id. */
  path: string;
  children: BranchTreeNode[];
};

/** A top-level "Remote" / "Local" heading. Only ever appears at the root, and
 *  only when both kinds of branch are in play; the localized label is resolved
 *  by the view (this module stays vscode-free). */
export type BranchTreeGroup = {
  type: "group";
  kind: "remote" | "local";
  children: BranchTreeNode[];
};

export type BranchTreeNode = BranchTreeLeaf | BranchTreeFolder | BranchTreeGroup;

function leafSortKey(name: string): [number, string] {
  const lower = name.toLowerCase();
  const primary = PRIMARY_BRANCHES.indexOf(lower);
  return primary === -1 ? [PRIMARY_BRANCHES.length, lower] : [primary, lower];
}

type MutableFolder = {
  leaves: BranchTreeLeaf[];
  folders: Map<string, MutableFolder>;
};

function newFolder(): MutableFolder {
  return { leaves: [], folders: new Map() };
}

/** The display path of a branch (remote prefix stripped) split into segments. */
function displaySegments(branch: string): string[] {
  return displayRef(branch).split("/");
}

/** Extra per-branch metadata used to mark leaves; omitted by callers that don't
 *  surface branch state (then every leaf is plain, with no age). The fields come
 *  as a set: an inactive leaf without its date would silently lose the age
 *  label. */
export type BranchTreeMeta = {
  /** Refs already merged into the default branch (rendered with a badge). */
  merged: ReadonlySet<string>;
  /** Refs whose last commit predates the threshold (rendered with an age). */
  inactive: ReadonlySet<string>;
  /** Refs a hide toggle would remove (rendered dimmed): the union of the two
   *  above, minus the exempt branches. */
  hidable: ReadonlySet<string>;
  /** ref → last commit time (unix seconds), for the age label. */
  dates: Readonly<Record<string, number>>;
};

export function buildBranchTree(
  branches: readonly string[],
  head: string | null,
  meta?: BranchTreeMeta
): BranchTreeNode[] {
  const root = newFolder();

  for (const branch of branches) {
    const isRemote = branch.startsWith(REMOTE_PREFIX);
    const segments = displaySegments(branch);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let child = node.folders.get(segments[i]);
      if (child === undefined) {
        child = newFolder();
        node.folders.set(segments[i], child);
      }
      node = child;
    }
    node.leaves.push({
      type: "leaf",
      branch,
      name: segments[segments.length - 1],
      isHead: branch === head,
      isRemote,
      isMerged: meta?.merged?.has(branch) ?? false,
      isInactive: meta?.inactive?.has(branch) ?? false,
      isHidable: meta?.hidable?.has(branch) ?? false,
      lastActivitySec: meta?.dates?.[branch]
    });
  }

  const render = (folder: MutableFolder, parentPath: string): BranchTreeNode[] => {
    const leaves = folder.leaves.toSorted((a, b) => {
      const [ra, la] = leafSortKey(a.name);
      const [rb, lb] = leafSortKey(b.name);
      return ra !== rb ? ra - rb : la.localeCompare(lb);
    });
    const folders = [...folder.folders.entries()].toSorted((a, b) =>
      a[0].toLowerCase().localeCompare(b[0].toLowerCase())
    );
    const nodes: BranchTreeNode[] = leaves;
    for (const [name, sub] of folders) {
      const path = parentPath === "" ? name : parentPath + "/" + name;
      nodes.push({ type: "folder", name, path, children: render(sub, path) });
    }
    return nodes;
  };

  return render(root, "");
}

/**
 * Root nodes for the side-view: when remote-tracking branches are present, two
 * top-level groups — remote first, then local. With no remotes (none fetched,
 * or "show remote branches" off) the flat local tree is returned unchanged,
 * since a lone "Local" heading would be noise.
 */
export function buildGroupedBranchRoots(
  branches: readonly string[],
  head: string | null,
  meta?: BranchTreeMeta
): BranchTreeNode[] {
  const remote = branches.filter((b) => b.startsWith(REMOTE_PREFIX));
  if (remote.length === 0) return buildBranchTree(branches, head, meta);
  const local = branches.filter((b) => !b.startsWith(REMOTE_PREFIX));
  return [
    { type: "group", kind: "remote", children: buildBranchTree(remote, head, meta) },
    { type: "group", kind: "local", children: buildBranchTree(local, head, meta) }
  ];
}
