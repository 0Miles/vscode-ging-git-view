import * as vscode from "vscode";

import { getPathFromStr } from "./backend/utils/path";

/** Reads a file's contents at a commit, decoded per the `fileEncoding` setting. */
export type DiffFileReader = (repo: string, commit: string, filePath: string) => Promise<string>;

export class DiffDocProvider implements vscode.TextDocumentContentProvider {
  public static scheme = "ging-git-view";
  private readFile: DiffFileReader;
  private onDidChangeEventEmitter = new vscode.EventEmitter<vscode.Uri>();
  private docs = new Map<string, DiffDocument>();
  private subscriptions: vscode.Disposable;

  constructor(readFile: DiffFileReader) {
    this.readFile = readFile;
    this.subscriptions = vscode.workspace.onDidCloseTextDocument((doc) =>
      this.docs.delete(doc.uri.toString())
    );
  }

  public dispose() {
    this.subscriptions.dispose();
    this.docs.clear();
    this.onDidChangeEventEmitter.dispose();
  }

  get onDidChange() {
    return this.onDidChangeEventEmitter.event;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    let document = this.docs.get(uri.toString());
    if (document) return document.value;

    let request = decodeDiffDocUri(uri);
    return this.readFile(request.repo, request.commit, request.filePath).then((data) => {
      let doc = new DiffDocument(data);
      this.docs.set(uri.toString(), doc);
      return doc.value;
    });
  }
}

class DiffDocument {
  private body: string;

  constructor(body: string) {
    this.body = body;
  }

  get value() {
    return this.body;
  }
}

export function encodeDiffDocUri(repo: string, path: string, commit: string): vscode.Uri {
  const filePath = getPathFromStr(path);
  // Use a generic "file<ext>" path (keeping the extension for syntax
  // highlighting) and carry the real data base64-encoded in the query. This
  // stops VS Code treating the doc as the actual file and requesting it in the
  // background — e.g. fetching package.json when a README diff is opened.
  const extIndex = filePath.indexOf(".", filePath.lastIndexOf("/") + 1);
  const extension = extIndex > -1 ? filePath.substring(extIndex) : "";
  return vscode.Uri.parse(
    DiffDocProvider.scheme +
      ":file" +
      extension +
      "?" +
      Buffer.from(JSON.stringify({ filePath, commit, repo })).toString("base64")
  );
}

export function decodeDiffDocUri(uri: vscode.Uri): {
  filePath: string;
  commit: string;
  repo: string;
} {
  return JSON.parse(Buffer.from(uri.query, "base64").toString());
}
