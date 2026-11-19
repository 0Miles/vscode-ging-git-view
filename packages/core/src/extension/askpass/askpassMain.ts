/*---------------------------------------------------------------------------------------------
 *  Based on the askpass-main implementation in the Microsoft Visual Studio Code Git Extension
 *  (https://github.com/microsoft/vscode/blob/main/extensions/git/src/askpass-main.ts), MIT licensed.
 *  Runs as a standalone process invoked by git via GIT_ASKPASS: it relays the
 *  prompt to the extension's IPC server and writes the answer back to git.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "node:fs";
import * as http from "node:http";

function fatal(err: unknown): void {
  process.stderr.write("Missing or invalid credentials.\n");
  process.stderr.write(String(err) + "\n");
  process.exit(1);
}

/** What git's prompt is about: the text between its first and last single
 *  quote (`Username for '<url>': `), or "" when it has no such pair. */
function hostOf(prompt: string): string {
  const first = prompt.indexOf("'");
  const last = prompt.lastIndexOf("'");
  return last > first && first !== -1 ? prompt.substring(first + 1, last) : "";
}

function main(argv: string[]): void {
  if (!process.env["NEO_GIT_GRAPH_ASKPASS_HANDLE"]) return fatal("Missing handle");
  if (!process.env["NEO_GIT_GRAPH_ASKPASS_PIPE"]) return fatal("Missing pipe");

  const output = process.env["NEO_GIT_GRAPH_ASKPASS_PIPE"]!;
  const socketPath = process.env["NEO_GIT_GRAPH_ASKPASS_HANDLE"]!;

  const req = http.request({ socketPath, path: "/", method: "POST" }, (res) => {
    if (res.statusCode !== 200) return fatal("Bad status code: " + res.statusCode);

    let resData = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (resData += d));
    res.on("end", () => {
      try {
        const response = JSON.parse(resData);
        fs.writeFileSync(output, response + "\n");
      } catch {
        return fatal("Error parsing response");
      }
      setTimeout(() => process.exit(0), 0);
    });
  });

  req.on("error", () => fatal("Error in request"));
  // git hands its prompt over as one argument (askpass.sh passes it on with
  // "$@"); should it ever come in several, they are joined back with spaces.
  // The token, when git was run with one, says whose prompt this is.
  const request = argv.slice(2).join(" ");
  req.write(
    JSON.stringify({
      request,
      host: hostOf(request),
      token: process.env["NEO_GIT_GRAPH_ASKPASS_TOKEN"]
    })
  );
  req.end();
}

main(process.argv);
