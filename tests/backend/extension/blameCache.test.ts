import { describe, expect, it } from "vitest";

import { createBlameCache } from "@/extension/blameCache";

describe("createBlameCache", () => {
  it("hands back a blame for the same document version in the same repository", () => {
    const cache = createBlameCache<string>();
    cache.set("file:///a.ts", { version: 3, repo: "/work/app" }, "blame");
    expect(cache.get("file:///a.ts", { version: 3, repo: "/work/app" })).toBe("blame");
  });

  it("misses once the document has moved on to another version", () => {
    const cache = createBlameCache<string>();
    cache.set("file:///a.ts", { version: 3, repo: "/work/app" }, "blame");
    expect(cache.get("file:///a.ts", { version: 4, repo: "/work/app" })).toBeUndefined();
  });

  // A submodule found after its file was opened: the parent repository's empty
  // result must not stand in for the submodule's own blame.
  it("misses when the file now belongs to another repository", () => {
    const cache = createBlameCache<string | null>();
    cache.set("file:///app/sub/b.ts", { version: 1, repo: "/app" }, null);
    expect(cache.get("file:///app/sub/b.ts", { version: 1, repo: "/app/sub" })).toBeUndefined();
  });

  it("forgets a deleted document", () => {
    const cache = createBlameCache<string>();
    cache.set("file:///a.ts", { version: 3, repo: "/work/app" }, "blame");
    cache.delete("file:///a.ts");
    expect(cache.get("file:///a.ts", { version: 3, repo: "/work/app" })).toBeUndefined();
  });
});
