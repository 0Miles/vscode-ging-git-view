<div align="center">
  <img src="./resources/icon.png" height="128"/>
  <samp>
    <h1>GING</h1>
    <h3>A visual Git extension focused on Git sidebar integration and multi-repository workflows</h3>
  </samp>
</div>

> Independent MIT-licensed fork lineage. Not affiliated with, endorsed by, or maintained by the
> original Git Graph project, (neo) Git Graph, or Microsoft. See
> [Fork lineage and attribution](#fork-lineage-and-attribution).

[![](https://img.shields.io/github/license/0Miles/vscode-ging-git-view)](https://github.com/0Miles/vscode-ging-git-view?tab=MIT-1-ov-file)
[![GitHub release](https://img.shields.io/github/v/release/0Miles/vscode-ging-git-view)](https://github.com/0Miles/vscode-ging-git-view/releases)

## What GING is

GING is a Source Control extension for Visual Studio Code. Its focus is bringing the Git history
workflow into the **native Source Control sidebar** — including dedicated **Branches** and
**Remotes** side views — so you can inspect history and manage branches and remotes without leaving
the sidebar, with first-class support for **workspaces that contain many repositories**.

It also includes a commit-graph webview for visualizing history, but the design direction is
deliberately sidebar- and multi-repo-first, rather than centered on a single dedicated graph panel.

## Why this fork exists

This project is maintained as a separate fork rather than a direct pull request to `(neo) Git Graph`
because the changes are not limited to isolated fixes. The product direction differs in VS Code
integration model.

Git Graph-style extensions are primarily centered around operations inside a dedicated Webview
Panel. This extension focuses on exposing part of the Git history workflow through the VS Code Git
sidebar view and integrating with the native Git sidebar repository view, especially for
multi-repository workflows:

- **Sidebar-first.** Branches and Remotes live as side views in the Source Control container;
  history follows the repository selected in the Source Control view.
- **Multi-repository workflows.** Designed for workspaces with several repositories, with per-repo
  selection and grouping.
- **Localized UI.** English, Simplified Chinese, and Traditional Chinese.
- **Devcontainer / remote ready.** Works in remote and container environments.

This is a difference in product integration direction, not a criticism of the upstream project or
its maintenance. Keeping this work in a separate fork makes the product direction, compatibility
tradeoffs, and release process clearer.

## Features

- **Branches view**: A sidebar view with search, multi-select, remote/local grouping, and independent filters for inactive and already-merged branches
- **Merged-branch marking**: Branches already merged into the repo's default branch are badged in the sidebar and dimmed in the graph, so you can see what is safe to delete (ancestry only — squash and rebase merges are not detected)
- **Remotes view**: Add, edit, rename, and remove remotes from the sidebar
- **Source Control integration**: History follows the repository selected in the Source Control view
- **Multi-repo**: Work with multiple repositories in one workspace
- **Graph view**: See branches, tags, stashes, and uncommitted changes in one graph
- **Commit details**: Click a commit to see message, files, and diffs
- **Branch actions**: Create, checkout, rename, delete, merge, rebase, and push
- **Tag actions**: Create, delete, and push tags
- **Commit actions**: Checkout, cherry-pick, revert, and reset
- **Avatar support**: Optional avatars from GitHub, GitLab, or Gravatar
- **Devcontainer ready**: Works in remote and container environments

## Configuration

All settings live under the `ging-git-view.*` prefix. The easiest way to configure the extension is
the Settings UI — open Settings and search for **GING**.

A few commonly adjusted settings:

| Setting                                    | Default       | Description                                      |
| ------------------------------------------ | ------------- | ------------------------------------------------ |
| `ging-git-view.history.fetchAvatars`       | `false`       | Fetch avatars (sends email to external services) |
| `ging-git-view.dates.format`               | `Date & Time` | Date format shown in the date column             |
| `ging-git-view.dates.type`                 | `Author Date` | `Author Date` or `Commit Date`                   |
| `ging-git-view.graph.edgeStyle`            | `rounded`     | `rounded` or `angular`                           |
| `ging-git-view.history.initialCommitCount` | `300`         | Commits to load on open                          |
| `ging-git-view.repoSearchDepth`            | `0`           | Folder depth for repository search               |
| `ging-git-view.statusBarButton`            | `true`        | Show the status bar button                       |

See `contributes.configuration` in `package.json` for the full list of settings.

## Installation

- [GitHub Releases](https://github.com/0Miles/vscode-ging-git-view/releases) (`.vsix` manual install)

## Fork lineage and attribution

This project is an independent MIT-licensed fork lineage based on `(neo) Git Graph`, which is a
clean MIT fork of the original `Git Graph`. Its code lineage is, in order:

1. [Git Graph](https://github.com/mhutchie/vscode-git-graph) by Michael Hutchison — the original
   project. Everything up to and including
   [commit 4af8583](https://github.com/mhutchie/vscode-git-graph/commit/4af8583a42082b2c230d2c0187d4eaff4b69c665)
   was MIT-licensed; the project changed its license in May 2019, and nothing after that commit is used here.
2. [(neo) Git Graph](https://github.com/asispts/neo-git-graph) by Asis Pattisahusiwa — a clean MIT
   fork based on that last MIT commit.
3. **GING** — this project, forked from (neo) Git Graph.

Original copyright notices and license information are preserved. This section exists to **give
credit to the upstream authors** as the MIT license requires. The names "Git Graph" and
"(neo) Git Graph" refer to those separate projects and their authors; they do not indicate any
affiliation with, sponsorship by, or endorsement from them.

This project is independently maintained and is not affiliated with, endorsed by, or maintained by
the original `Git Graph` project, `(neo) Git Graph`, or Microsoft.

## License

MIT — see [LICENSE](LICENSE).

The webview's icon artwork is derived from [GitHub Octicons](https://github.com/primer/octicons)
(MIT, © GitHub Inc.). Its notice is reproduced under "Third-party notices" in
[LICENSE](LICENSE).

---

**Disclaimer:** GING is an independent, community-maintained project. It is not affiliated with,
endorsed by, or connected to the "Git Graph" extension by Michael Hutchison, the "(neo) Git Graph"
project, or Microsoft. All product names, trademarks, and registered trademarks are the property of
their respective owners and are used here only for identification and attribution.
