import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createArchive } from "@/backend/actions/archive";

import { makeRepo } from "@tests/backend/helpers";

let repo: string;
let outDir: string;

beforeAll(() => {
  repo = makeRepo();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-archive-"));
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("createArchive", () => {
  it("creates a zip archive of a ref (inferred from .zip extension)", async () => {
    const out = path.join(outDir, "main.zip");
    await createArchive(simpleGit(repo), { ref: "main", outputPath: out });
    expect(fs.existsSync(out)).toBe(true);
    const buf = fs.readFileSync(out);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString("ascii")).toBe("PK"); // zip magic
  });

  it("creates a tar archive when the extension is not .zip", async () => {
    const out = path.join(outDir, "main.tar");
    await createArchive(simpleGit(repo), { ref: "main", outputPath: out });
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("throws for an invalid ref", async () => {
    await expect(
      createArchive(simpleGit(repo), {
        ref: "no-such-ref",
        outputPath: path.join(outDir, "bad.zip")
      })
    ).rejects.toThrow();
  });
});
