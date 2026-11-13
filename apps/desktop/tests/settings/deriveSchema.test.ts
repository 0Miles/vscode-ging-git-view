import { describe, expect, it } from "vitest";

import {
  deriveSettingsSchema,
  EXCLUDED_SETTINGS,
  RESOURCE_SETTINGS_AS_GLOBAL,
  type ManifestNls
} from "@ging/desktop/settings/deriveSchema";

import { readManifest } from "./manifest";

/** A manifest with the given settings, as apps/vscode/package.json has them. */
const manifest = (properties: Record<string, unknown>) => ({
  contributes: { configuration: { type: "object", title: "%config.title%", properties } }
});

/** The three locales' strings; zh-cn lacks what is not given for it. */
const nls = (en: Record<string, string>, zhTw: Record<string, string> = {}): ManifestNls => ({
  en,
  "zh-cn": {},
  "zh-tw": zhTw
});

describe("deriving the desktop's settings schema", () => {
  it("carries a setting's type, default, enum and range, its title made from its key", () => {
    const schema = deriveSettingsSchema(
      manifest({
        "ging-git-view.graph.edgeStyle": {
          type: "string",
          enum: ["rounded", "angular"],
          enumDescriptions: ["%config.graphStyle.rounded%", "%config.graphStyle.angular%"],
          default: "rounded",
          description: "%config.graphStyle%"
        },
        "ging-git-view.autoFetch.intervalMinutes": {
          type: "number",
          default: 10,
          minimum: 1,
          maximum: 60,
          description: "%config.autoFetchInterval%"
        }
      }),
      nls(
        {
          "config.graphStyle": "Graph style.",
          "config.graphStyle.rounded": "Rounded.",
          "config.graphStyle.angular": "Angular.",
          "config.autoFetchInterval": "How often."
        },
        { "config.graphStyle": "圖形樣式。" }
      )
    );

    expect(schema.settings).toEqual([
      {
        key: "ging-git-view.graph.edgeStyle",
        title: "Graph: Edge Style",
        type: "string",
        enum: ["rounded", "angular"],
        enumDescriptions: [
          { en: "Rounded.", "zh-cn": "Rounded.", "zh-tw": "Rounded." },
          { en: "Angular.", "zh-cn": "Angular.", "zh-tw": "Angular." }
        ],
        default: "rounded",
        description: { en: "Graph style.", "zh-cn": "Graph style.", "zh-tw": "圖形樣式。" },
        descriptionFormat: "plain"
      },
      {
        key: "ging-git-view.autoFetch.intervalMinutes",
        title: "Auto Fetch: Interval Minutes",
        type: "number",
        default: 10,
        minimum: 1,
        maximum: 60,
        description: { en: "How often.", "zh-cn": "How often.", "zh-tw": "How often." },
        descriptionFormat: "plain"
      }
    ]);
  });

  it("localizes the descriptions nested in an array's items", () => {
    const schema = deriveSettingsSchema(
      manifest({
        "ging-git-view.customBranchGlobs": {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string", description: "%config.glob.name%" } },
            required: ["name"],
            additionalProperties: false
          },
          default: [],
          description: "%config.glob%"
        }
      }),
      nls(
        { "config.glob": "Globs.", "config.glob.name": "Its name." },
        { "config.glob.name": "名稱" }
      )
    );

    expect(schema.settings[0]).toMatchObject({
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: { en: "Its name.", "zh-cn": "Its name.", "zh-tw": "名稱" }
          }
        },
        required: ["name"],
        additionalProperties: false
      }
    });
  });

  it("leaves out every setting on the exclusion list", () => {
    const schema = deriveSettingsSchema(
      manifest({
        "ging-git-view.keepWebviewAlive": {
          type: "boolean",
          default: true,
          description: "%config.keep%"
        },
        "ging-git-view.show.tags": { type: "boolean", default: true, description: "%config.tags%" }
      }),
      nls({ "config.keep": "Keep.", "config.tags": "Tags." })
    );
    expect(schema.settings.map((s) => s.key)).toEqual(["ging-git-view.show.tags"]);
  });

  it("takes a resource-scoped setting on the list as a global one", () => {
    const schema = deriveSettingsSchema(
      manifest({
        "ging-git-view.defaultFileEncoding": {
          type: "string",
          default: "utf8",
          scope: "resource",
          description: "%config.enc%"
        }
      }),
      nls({ "config.enc": "Encoding." })
    );
    expect(schema.settings[0]).not.toHaveProperty("scope");
    expect(schema.settings[0]).toMatchObject({ key: "ging-git-view.defaultFileEncoding" });
  });

  it("refuses a resource-scoped setting nobody has decided about", () => {
    expect(() =>
      deriveSettingsSchema(
        manifest({
          "ging-git-view.newPerFolder": {
            type: "boolean",
            default: true,
            scope: "resource",
            description: "%config.x%"
          }
        }),
        nls({ "config.x": "X." })
      )
    ).toThrow(/ging-git-view\.newPerFolder.*resource/);
  });

  it("refuses a schema keyword it does not know how to carry", () => {
    expect(() =>
      deriveSettingsSchema(
        manifest({
          "ging-git-view.x": {
            type: "boolean",
            default: true,
            description: "%config.x%",
            deprecationMessage: "%config.x.deprecated%"
          }
        }),
        nls({ "config.x": "X." })
      )
    ).toThrow(/deprecationMessage/);
  });

  it("refuses a string the English strings lack", () => {
    expect(() =>
      deriveSettingsSchema(
        manifest({ "ging-git-view.x": { type: "boolean", default: true, description: "%nope%" } }),
        nls({})
      )
    ).toThrow(/nope/);
  });
});

describe("a markdown description", () => {
  const derive = (en: string, zhTw?: string, extra: Record<string, unknown> = {}) =>
    deriveSettingsSchema(
      manifest({
        "ging-git-view.dates.format": { type: "string", default: "", description: "%format%" },
        "ging-git-view.dates.customFormat": {
          type: "string",
          default: "",
          markdownDescription: "%custom%"
        },
        ...extra
      }),
      nls(
        { format: "Format.", custom: en, keep: "Keep." },
        zhTw === undefined ? {} : { custom: zhTw }
      )
    ).settings.find((s) => s.key === "ging-git-view.dates.customFormat")!;

  it("is marked as markdown, a plain one as plain", () => {
    expect(derive("Pattern.").descriptionFormat).toBe("markdown");
  });

  it("turns a link to another setting into a link to its anchor, titled as that setting", () => {
    expect(derive("Used when `#ging-git-view.dates.format#` is set.").description.en).toBe(
      "Used when [`Dates: Format`](#ging-git-view.dates.format) is set."
    );
  });

  it("turns the links in every locale", () => {
    const setting = derive(
      "When `#ging-git-view.dates.format#`.",
      "當 `#ging-git-view.dates.format#` 時"
    );
    expect(setting.description["zh-tw"]).toBe(
      "當 [`Dates: Format`](#ging-git-view.dates.format) 時"
    );
    expect(setting.description["zh-cn"]).toBe(
      "When [`Dates: Format`](#ging-git-view.dates.format)."
    );
  });

  it("names a setting the desktop leaves out without linking to it", () => {
    const setting = derive("Unless `#ging-git-view.keepWebviewAlive#` is on.", undefined, {
      "ging-git-view.keepWebviewAlive": { type: "boolean", default: true, description: "%keep%" }
    });
    expect(setting.description.en).toBe("Unless `Keep Webview Alive` is on.");
  });

  it("keeps its other markdown as written", () => {
    expect(derive("A [token](https://example.com) with `read_user`.").description.en).toBe(
      "A [token](https://example.com) with `read_user`."
    );
  });

  it("leaves a plain description's text alone, links and all", () => {
    const schema = deriveSettingsSchema(
      manifest({
        "ging-git-view.dates.format": {
          type: "string",
          default: "",
          description: "%plain%"
        }
      }),
      nls({ plain: "See `#ging-git-view.dates.format#`." })
    );
    expect(schema.settings[0].description.en).toBe("See `#ging-git-view.dates.format#`.");
  });
});

describe("the exclusion lists", () => {
  it("name only settings VS Code still has", () => {
    const keys = Object.keys(readManifest().manifest.contributes.configuration.properties);
    expect(keys).toEqual(expect.arrayContaining(Object.keys(EXCLUDED_SETTINGS)));
    expect(keys).toEqual(expect.arrayContaining([...RESOURCE_SETTINGS_AS_GLOBAL]));
  });
});
