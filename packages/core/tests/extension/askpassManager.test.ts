import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import * as esbuild from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AskpassManager } from "@ging/core/extension/askpass/askpassManager";
import type { Prompts } from "@ging/core/host/ports";

// The host half of GIT_ASKPASS: git's helper posts the prompt it was given to
// the manager's IPC handle and writes whatever comes back to git. Driven here
// the way `askpassMain` drives it, with the user's answer from a fake prompt.

type InputOptions = Parameters<Prompts["input"]>[0];

let manager: AskpassManager | undefined;
afterEach(() => manager?.dispose());

function ask(
  socketPath: string,
  body: { request: string; host: string; token?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/", method: "POST" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** What `choose` was asked: its message and options. */
interface Chosen {
  message: string;
  detail?: string;
  actions: readonly { label: string; value: unknown }[];
}

/** Notes what `choose` was asked, then answers with the action at `pick`
 *  (`undefined` for the host's Cancel), or rejects when `pick` is `"fail"`. */
function chooser(pick: number | undefined | "fail") {
  const chosen: Chosen[] = [];
  const choose: Prompts["choose"] = (message, options) => {
    chosen.push({ message, ...options });
    if (pick === "fail") return Promise.reject(new Error("no UI"));
    return Promise.resolve(pick === undefined ? undefined : options.actions[pick].value);
  };
  return { chosen, choose };
}

function start(
  answer: (options: InputOptions) => PromiseLike<string | undefined>,
  helpers = os.tmpdir(),
  choose: Prompts["choose"] = chooser(undefined).choose
) {
  const asked: InputOptions[] = [];
  manager = new AskpassManager(
    {
      input: (options) => {
        asked.push(options);
        return answer(options);
      },
      choose
    },
    helpers
  );
  return { asked, handle: manager.getEnv().NEO_GIT_GRAPH_ASKPASS_HANDLE! };
}

/** OpenSSH 9.2's host key confirmation, as ssh hands it to SSH_ASKPASS. */
const HOST_KEY_PROMPT =
  "The authenticity of host 'github.com (20.27.177.113)' can't be established.\n" +
  "ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n" +
  "This key is not known by any other names.\n" +
  "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";

describe("AskpassManager", () => {
  it("puts git's prompt to the user, masked for a password, and returns the answer", async () => {
    const { asked, handle } = start(async () => "s3cret");
    const res = await ask(handle, { request: "Password for 'https://me@host':", host: "host" });
    expect(asked).toEqual([
      { placeholder: "Password for 'https://me@host':", prompt: "GING: host", password: true }
    ]);
    expect(res).toEqual({ status: 200, body: JSON.stringify("s3cret") });
  });

  it("does not mask a username prompt", async () => {
    const { asked, handle } = start(async () => "me");
    await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(asked[0].password).toBe(false);
  });

  it("answers a cancelled prompt with an empty string", async () => {
    const { handle } = start(async () => undefined);
    const res = await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(res).toEqual({ status: 200, body: JSON.stringify("") });
  });

  it("answers a prompt that failed with an error status", async () => {
    const { handle } = start(() => Promise.reject(new Error("no UI")));
    const res = await ask(handle, { request: "Username for 'https://host':", host: "host" });
    expect(res.status).toBe(500);
  });

  // One server for the whole process, each git run asking whoever started it
  // (the desktop host's webview instances, #388): the route's env carries a
  // token that the helper sends back.
  it("puts a prompt to the route whose token it carries, not to the default", async () => {
    const { asked: toDefault, handle } = start(async () => "default");
    const toRoute: InputOptions[] = [];
    const route = manager!.route({
      input: async (options) => {
        toRoute.push(options);
        return "routed";
      },
      choose: chooser(undefined).choose
    });

    const res = await ask(handle, {
      request: "Username for 'https://host':",
      host: "host",
      token: route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });

    expect(res).toEqual({ status: 200, body: JSON.stringify("routed") });
    expect(toRoute).toHaveLength(1);
    expect(toDefault).toEqual([]);
    expect(route.env.NEO_GIT_GRAPH_ASKPASS_HANDLE).toBe(handle);
  });

  it("gives each route a token of its own", () => {
    start(async () => undefined);
    const tokens = [
      manager!.route({ input: async () => undefined, choose: chooser(undefined).choose }),
      manager!.route({ input: async () => undefined, choose: chooser(undefined).choose })
    ].map((route) => route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN);
    expect(new Set(tokens).size).toBe(2);
    expect(manager!.getEnv().NEO_GIT_GRAPH_ASKPASS_TOKEN).toBeUndefined();
  });

  it("answers a prompt for a route that is gone as cancelled, asking nobody", async () => {
    const { asked, handle } = start(async () => "default");
    const gone = manager!.route({
      input: async () => "routed",
      choose: chooser(undefined).choose
    });
    gone.dispose();

    const res = await ask(handle, {
      request: "Username for 'https://host':",
      host: "host",
      token: gone.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });

    expect(res).toEqual({ status: 200, body: JSON.stringify("") });
    expect(asked).toEqual([]);
  });

  // ssh's own prompts (#470): ssh reads SSH_ASKPASS, not GIT_ASKPASS, and
  // without a tty only calls it when SSH_ASKPASS_REQUIRE is `force`.
  it("points ssh at the same helper, forced, in its env and every route's", () => {
    start(async () => undefined);
    const env = manager!.getEnv();
    expect(env.SSH_ASKPASS).toBe(env.GIT_ASKPASS);
    expect(env.SSH_ASKPASS).toMatch(/askpass\.sh$/);
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");

    const route = manager!.route({
      input: async () => undefined,
      choose: chooser(undefined).choose
    });
    expect(route.env.SSH_ASKPASS).toBe(route.env.GIT_ASKPASS);
    expect(route.env.SSH_ASKPASS).toMatch(/askpass\.sh$/);
    expect(route.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN).toBeTruthy();
  });

  it("asks a host key confirmation as a choice, its fingerprint in the detail, and answers yes", async () => {
    const { chosen, choose } = chooser(0);
    const { asked, handle } = start(async () => "typed", os.tmpdir(), choose);
    const res = await ask(handle, {
      request: HOST_KEY_PROMPT,
      host: "github.com (20.27.177.113)' can"
    });

    expect(asked).toEqual([]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].message).toBe(
      "The authenticity of host 'github.com (20.27.177.113)' can't be established."
    );
    expect(chosen[0].detail).toBe(
      "ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n" +
        "This key is not known by any other names.\n" +
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
    );
    expect(chosen[0].actions).toHaveLength(1);
    expect(chosen[0].actions[0].value).toBe("yes");
    expect(res).toEqual({ status: 200, body: JSON.stringify("yes") });
  });

  it("asks an older ssh's (yes/no)? confirmation as a choice too", async () => {
    const { chosen, choose } = chooser(0);
    const { asked, handle } = start(async () => "typed", os.tmpdir(), choose);
    const prompt =
      "The authenticity of host 'example.com (192.0.2.1)' can't be established.\n" +
      "RSA key fingerprint is SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8.\n" +
      "Are you sure you want to continue connecting (yes/no)? ";
    const res = await ask(handle, { request: prompt, host: "" });

    expect(asked).toEqual([]);
    expect(chosen[0].message).toBe(
      "The authenticity of host 'example.com (192.0.2.1)' can't be established."
    );
    expect(chosen[0].detail).toContain("SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8.");
    expect(res).toEqual({ status: 200, body: JSON.stringify("yes") });
  });

  it("answers a cancelled host key confirmation with no", async () => {
    const { handle } = start(async () => "typed", os.tmpdir(), chooser(undefined).choose);
    const res = await ask(handle, { request: HOST_KEY_PROMPT, host: "" });
    expect(res).toEqual({ status: 200, body: JSON.stringify("no") });
  });

  it("answers a host key confirmation that failed with an error status", async () => {
    const { handle } = start(async () => "typed", os.tmpdir(), chooser("fail").choose);
    const res = await ask(handle, { request: HOST_KEY_PROMPT, host: "" });
    expect(res.status).toBe(500);
  });

  it("puts a host key confirmation to the route whose token it carries", async () => {
    const { chosen: toDefault, choose } = chooser(0);
    const { handle } = start(async () => undefined, os.tmpdir(), choose);
    const routed = chooser(0);
    const route = manager!.route({ input: async () => undefined, choose: routed.choose });
    const res = await ask(handle, {
      request: HOST_KEY_PROMPT,
      host: "",
      token: route.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });
    expect(res).toEqual({ status: 200, body: JSON.stringify("yes") });
    expect(routed.chosen).toHaveLength(1);
    expect(toDefault).toEqual([]);
  });

  it("asks for a key's passphrase masked", async () => {
    const { chosen, choose } = chooser(0);
    const { asked, handle } = start(async () => "hunter2", os.tmpdir(), choose);
    const prompt = "Enter passphrase for key '/home/u/.ssh/id_rsa': ";
    const res = await ask(handle, { request: prompt, host: "/home/u/.ssh/id_rsa" });
    expect(chosen).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ placeholder: prompt, password: true });
    expect(res).toEqual({ status: 200, body: JSON.stringify("hunter2") });
  });

  it("asks for a security key's or token's PIN masked", async () => {
    const { chosen, choose } = chooser(0);
    const { asked, handle } = start(async () => "1234", os.tmpdir(), choose);
    const prompts = [
      "Enter PIN for ED25519-SK key /home/u/.ssh/id_ed25519_sk: ",
      "Enter PIN for 'tok': "
    ];
    await Promise.all(prompts.map((prompt) => ask(handle, { request: prompt, host: "" })));
    expect(chosen).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(asked.map(({ placeholder, password }) => ({ placeholder, password }))).toEqual(
      expect.arrayContaining(prompts.map((placeholder) => ({ placeholder, password: true })))
    );
  });

  // ssh's other yes-or-no (`ask_permission`, ControlMaster ask): an empty
  // answer is a yes there, so a dismissed one must be a "no".
  it("asks whether to allow a shared connection as a choice, and answers a cancel with no", async () => {
    const { chosen, choose } = chooser(undefined);
    const { asked, handle } = start(async () => "", os.tmpdir(), choose);
    const res = await ask(handle, { request: "Allow shared connection to github.com? ", host: "" });
    expect(asked).toEqual([]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].actions.map(({ value }) => value)).toEqual(["yes"]);
    expect(res).toEqual({ status: 200, body: JSON.stringify("no") });
  });

  it("answers a shared connection question for a route that is gone with no", async () => {
    const { handle } = start(async () => "");
    const gone = manager!.route({ input: async () => "", choose: chooser(0).choose });
    gone.dispose();
    const res = await ask(handle, {
      request: "Allow shared connection to github.com? ",
      host: "",
      token: gone.env.NEO_GIT_GRAPH_ASKPASS_TOKEN
    });
    expect(res).toEqual({ status: 200, body: JSON.stringify("no") });
  });

  it("asks ssh's (yes/no): question on updated host keys as a choice", async () => {
    const { chosen, choose } = chooser(0);
    const { asked, handle } = start(async () => "typed", os.tmpdir(), choose);
    const res = await ask(handle, {
      request: "Learned new hostkey: ED25519 SHA256:abc\nAccept updated hostkeys? (yes/no): ",
      host: ""
    });
    expect(asked).toEqual([]);
    expect(chosen).toHaveLength(1);
    expect(res).toEqual({ status: 200, body: JSON.stringify("yes") });
  });

  it("points git at the helpers in the folder it was given", () => {
    start(async () => undefined);
    const env = manager!.getEnv();
    expect(env.GIT_ASKPASS).toMatch(/askpass\.sh$/);
    expect(env.GIT_ASKPASS!.startsWith(os.tmpdir())).toBe(true);
    expect(env.NEO_GIT_GRAPH_ASKPASS_MAIN!.startsWith(os.tmpdir())).toBe(true);
  });
});

// The helper half, as git runs it (#445): git execs `askpass.sh` with its
// prompt as one argument, the script starts `askpassMain` under Node, and
// `askpassMain` posts the prompt to the manager and writes the answer to the
// file the script then prints to git. Built and run for real here, from the
// sources the apps ship.

/** The helper folder an app ships: `askpass.sh` beside a bundled
 *  `askpassMain.js`, with `stub.js` standing in for the latter where a test
 *  wants to see what the script handed over. */
let helperDir: string;

beforeAll(async () => {
  helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "ging-askpass-"));
  const askpassMain = path.resolve(__dirname, "../../src/extension/askpass/askpassMain.ts");
  await esbuild.build({
    entryPoints: [askpassMain],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    outfile: path.join(helperDir, "askpassMain.js"),
    logLevel: "silent"
  });
  fs.copyFileSync(
    path.join(path.dirname(askpassMain), "askpass.sh"),
    path.join(helperDir, "askpass.sh")
  );
  // Writes the arguments it was given where askpassMain writes git's answer.
  fs.writeFileSync(
    path.join(helperDir, "stub.js"),
    'require("fs").writeFileSync(process.env.NEO_GIT_GRAPH_ASKPASS_PIPE, JSON.stringify(process.argv.slice(2)));'
  );
}, 60_000);

afterAll(() => fs.rmSync(helperDir, { recursive: true, force: true }));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = helperDir
): Promise<Run> {
  return new Promise((resolve, reject) => {
    // An `undefined` in `env` takes that variable away from the child.
    const merged = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined)
    );
    const child = cp.spawn(command, args, { cwd, env: merged });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** `sh askpass.sh '<prompt>'`, as git runs GIT_ASKPASS. */
function runScript(prompt: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<Run> {
  const script = path.join(helperDir, "askpass.sh").split("\\").join("/");
  return run("sh", [script, prompt], env, cwd);
}

describe("askpass helper", () => {
  it("hands git's prompt to askpassMain as one argument, spaces and glob characters untouched", async () => {
    // Files the prompt's `*` and `?.txt` would match, were the shell to expand them.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ging-askpass-glob-"));
    fs.writeFileSync(path.join(cwd, "a.txt"), "");
    fs.writeFileSync(path.join(cwd, "b.txt"), "");
    const prompt = "Password for 'cert:///C:/Users/John  Doe/ * ?.txt my.p12': ";
    try {
      const res = await runScript(
        prompt,
        {
          NEO_GIT_GRAPH_ASKPASS_NODE: process.execPath,
          NEO_GIT_GRAPH_ASKPASS_MAIN: path.join(helperDir, "stub.js")
        },
        cwd
      );
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual([prompt]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prints and removes its answer file when the temp folder's path has a space", async () => {
    // mktemp makes the file under TMPDIR; forward slashes, as sh takes them.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ging askpass tmp "));
    const prompt = "Username for 'https://example.com': ";
    try {
      const res = await runScript(prompt, {
        TMPDIR: tmp.split("\\").join("/"),
        NEO_GIT_GRAPH_ASKPASS_NODE: process.execPath,
        NEO_GIT_GRAPH_ASKPASS_MAIN: path.join(helperDir, "stub.js")
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(JSON.stringify([prompt]));
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("asks with git's whole prompt and the URL in its quotes, masked for a certificate password", async () => {
    const { asked } = start(async () => "s3cret", helperDir);
    const prompt = "Certificate Password for 'cert:///C:/Users/John Doe/my cert.p12': ";
    const res = await runScript(prompt, manager!.getEnv());
    expect(res).toMatchObject({ code: 0, stdout: "s3cret\n" });
    expect(asked).toEqual([
      {
        placeholder: prompt,
        prompt: "GING: cert:///C:/Users/John Doe/my cert.p12",
        password: true
      }
    ]);
  });

  it("asks a username prompt whole and unmasked, the URL as its title", async () => {
    const { asked } = start(async () => "alice", helperDir);
    const prompt = "Username for 'https://example.com': ";
    const res = await runScript(prompt, manager!.getEnv());
    expect(res).toMatchObject({ code: 0, stdout: "alice\n" });
    expect(asked).toEqual([
      { placeholder: prompt, prompt: "GING: https://example.com", password: false }
    ]);
  });
});

describe("askpassMain", () => {
  let pipe: string;
  beforeEach(() => {
    pipe = path.join(helperDir, `answer-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => fs.rmSync(pipe, { force: true }));

  /** What the bundled askpassMain, run with `args`, posts to the IPC handle —
   *  read off a server of the test's own — and what it leaves for git. */
  async function posted(args: string[]): Promise<{ body: unknown; res: Run; answer: string }> {
    const id = Math.random().toString(36).slice(2);
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\ging-askpass-test-${id}`
        : path.join(helperDir, `ipc-${id}.sock`);
    let body: unknown;
    const server = http.createServer((req, res) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        body = JSON.parse(data);
        res.writeHead(200);
        res.end(JSON.stringify("the answer"));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const res = await run(process.execPath, [path.join(helperDir, "askpassMain.js"), ...args], {
        NEO_GIT_GRAPH_ASKPASS_HANDLE: socketPath,
        NEO_GIT_GRAPH_ASKPASS_PIPE: pipe,
        NEO_GIT_GRAPH_ASKPASS_TOKEN: undefined
      });
      const answer = fs.existsSync(pipe) ? fs.readFileSync(pipe, "utf8") : "";
      return { body, res, answer };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("posts a prompt with spaces whole, with the URL inside its quotes as the host", async () => {
    const prompt = "Certificate Password for 'cert:///C:/Users/John Doe/my cert.p12': ";
    const { body, res, answer } = await posted([prompt]);
    expect(body).toEqual({ request: prompt, host: "cert:///C:/Users/John Doe/my cert.p12" });
    expect(res.code).toBe(0);
    expect(answer).toBe("the answer\n");
  });

  it("posts a username prompt whole, with its URL as the host", async () => {
    const prompt = "Username for 'https://example.com': ";
    const { body, res, answer } = await posted([prompt]);
    expect(body).toEqual({ request: prompt, host: "https://example.com" });
    expect(res.code).toBe(0);
    expect(answer).toBe("the answer\n");
  });

  it("posts a URL with a single quote of its own whole as the host", async () => {
    const prompt = "Password for 'https://o'brien@example.com': ";
    const { body, res } = await posted([prompt]);
    expect(body).toEqual({ request: prompt, host: "https://o'brien@example.com" });
    expect(res.code).toBe(0);
  });

  it("posts a prompt without a quoted part, with an empty host", async () => {
    const { body, res, answer } = await posted(["Password: "]);
    expect(body).toEqual({ request: "Password: ", host: "" });
    expect(res.code).toBe(0);
    expect(answer).toBe("the answer\n");
  });

  it("posts a prompt with a lone single quote, with an empty host", async () => {
    const { body, res } = await posted(["Enter passphrase for key 'id_rsa: "]);
    expect(body).toEqual({ request: "Enter passphrase for key 'id_rsa: ", host: "" });
    expect(res.code).toBe(0);
  });

  it("joins a prompt handed over in several arguments with single spaces", async () => {
    const { body } = await posted(["Username", "for", "'https://example.com':"]);
    expect(body).toEqual({
      request: "Username for 'https://example.com':",
      host: "https://example.com"
    });
  });

  it("posts an empty prompt when given none, rather than failing", async () => {
    const { body, res } = await posted([]);
    expect(body).toEqual({ request: "", host: "" });
    expect(res.code).toBe(0);
  });
});
