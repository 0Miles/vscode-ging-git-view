import { describe, expect, it } from "vitest";

import { deriveSettingsSchema } from "@ging/desktop/settings/deriveSchema";

import { readManifest } from "./manifest";

// The desktop app reads its settings schema from schema.generated.json, never
// from apps/vscode. This is what writes it and what holds it to the
// extension's settings: when they change, this fails until it is rerun with
// `-u` (`pnpm vitest run --project backend apps/desktop/tests/settings -u`),
// and the regenerated file's diff is what desktop users will see.

describe("the desktop app's settings schema", () => {
  it("is what the extension's settings and their strings derive to", async () => {
    const { manifest, nls } = readManifest();
    const schema = deriveSettingsSchema(manifest, nls);
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      "../../src/settings/schema.generated.json"
    );
  });
});
