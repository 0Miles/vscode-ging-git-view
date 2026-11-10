import { describe, expect, it } from "vitest";

import { blameSource } from "@ging/core/backend/queries/blameFile";

const utf8 = (text: string) => Buffer.from(text, "utf8");
const BOM = "﻿";

describe("blameSource", () => {
  describe("an editor without unsaved edits", () => {
    // VS Code makes a file's mixed line endings one kind when it opens it, so
    // handing that text over would mark the other kind's lines uncommitted.
    it("blames the file on disk when it holds the same text, whatever its line endings", () => {
      expect(blameSource("a\r\nb\r\nc\r\n", utf8("a\r\nb\nc\r\n"), true)).toEqual({
        from: "disk"
      });
      expect(blameSource("a\nb\n", utf8("a\r\nb\r\n"), true)).toEqual({ from: "disk" });
    });

    it("blames the file on disk when only the BOM VS Code strips tells them apart", () => {
      expect(blameSource("a\n", utf8(BOM + "a\n"), true)).toEqual({ from: "disk" });
    });

    // A checkout changed the file and VS Code hasn't reloaded it yet: the lines
    // on screen are the editor's.
    it("blames the editor's text when the file on disk has moved on", () => {
      expect(blameSource("one\ntwo\n", utf8("zero\none\n"), true)).toEqual({
        from: "contents",
        text: "one\ntwo\n"
      });
    });

    it("blames the file on disk when it isn't UTF-8, rather than nothing", () => {
      expect(blameSource("café\n", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), true)).toEqual({
        from: "disk"
      });
    });
  });

  describe("an editor with unsaved edits", () => {
    it("always blames the editor's text", () => {
      expect(blameSource("a\nb\n", utf8("a\nb\n"), false)).toEqual({
        from: "contents",
        text: "a\nb\n"
      });
    });

    it("puts back the UTF-8 BOM VS Code strips from the text", () => {
      expect(blameSource("a\nb\n", utf8(BOM + "a\n"), false)).toEqual({
        from: "contents",
        text: BOM + "a\nb\n"
      });
    });

    it("blames nothing when the saved file isn't UTF-8", () => {
      expect(blameSource("café\nmore\n", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), false)).toBe(
        null
      );
    });
  });

  it("blames the editor's text when nothing is saved on disk", () => {
    expect(blameSource("a\n", null, true)).toEqual({ from: "contents", text: "a\n" });
    expect(blameSource("a\n", null, false)).toEqual({ from: "contents", text: "a\n" });
  });
});
