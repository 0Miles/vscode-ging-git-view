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

function main(argv: string[]): void {
  if (argv.length !== 5) return fatal("Wrong number of arguments");
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
  // argv[2] is the prompt git issues; argv[4] is "Host '<host>':" — strip the quotes.
  req.write(JSON.stringify({ request: argv[2], host: argv[4].substring(1, argv[4].length - 2) }));
  req.end();
}

main(process.argv);
