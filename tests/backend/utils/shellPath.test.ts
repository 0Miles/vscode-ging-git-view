import { describe, expect, it } from "vitest";

import { shellCommandPath } from "@/backend/utils/shellPath";

describe("shellCommandPath", () => {
  it("turns a Windows path into something a POSIX shell can run", () => {
    // Raw, the shell reads every backslash as an escape and the command vanishes
    // into "D:codeappouthelper.sh" — which is how this was first found.
    expect(shellCommandPath("D:\\code\\app\\out\\helper.sh")).toBe('"D:/code/app/out/helper.sh"');
  });

  it("quotes so a path with spaces stays one argument", () => {
    expect(shellCommandPath("C:\\Program Files\\app\\h.sh")).toBe('"C:/Program Files/app/h.sh"');
  });

  it("leaves a POSIX path alone apart from the quotes", () => {
    expect(shellCommandPath("/usr/local/lib/h.sh")).toBe('"/usr/local/lib/h.sh"');
  });
});
