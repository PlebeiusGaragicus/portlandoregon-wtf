// Focused protocol tests for the optional client overview atlas.
//
//   npm run test:overview-atlas
import {
  parseOverviewAtlasManifest,
  selectOverviewAtlasLevel,
  type OverviewAtlasManifest,
  type OverviewAtlasWidth,
} from "../client/src/overview-atlas.js";

const HASH = "a".repeat(64);

function level(width: OverviewAtlasWidth): Record<string, unknown> {
  return {
    width,
    height: width / 2,
    ground: { file: `overview-ground-v1-${width}.png`, sha256: HASH },
    urban: { file: `overview-urban-v1-${width}.png`, sha256: HASH },
  };
}

function fixture(): Record<string, unknown> {
  return {
    version: 1,
    generator: "battle-juice-overview-atlas",
    map: { name: "test-city", sourceDate: "2026-08-06" },
    extent: {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 50,
      width: 100,
      height: 50,
      units: "meters",
    },
    hillshade: true,
    // Deliberately shuffled: parsing normalizes level order.
    levels: [level(2048), level(4096), level(1024)],
  };
}

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`  ${pass ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function rejects(name: string, value: unknown): void {
  let rejected = false;
  try {
    parseOverviewAtlasManifest(value);
  } catch {
    rejected = true;
  }
  check(name, rejected);
}

const manifest = parseOverviewAtlasManifest(fixture());
check("parses the versioned manifest", manifest.version === 1 && manifest.map.name === "test-city");
check("normalizes all three levels", manifest.levels.map(({ width }) => width).join(",") === "1024,2048,4096");

{
  const invalid = fixture();
  (invalid["extent"] as Record<string, unknown>)["height"] = 51;
  rejects("rejects inconsistent extents and level dimensions", invalid);
}
{
  const invalid = fixture();
  const levels = invalid["levels"] as Record<string, unknown>[];
  levels[0] = level(1024);
  rejects("rejects duplicate or missing levels", invalid);
}
{
  const invalid = fixture();
  const levels = invalid["levels"] as Record<string, unknown>[];
  (levels[0]!["ground"] as Record<string, unknown>)["file"] = "../wrong.png";
  rejects("rejects unexpected asset paths", invalid);
}

function selected(
  source: OverviewAtlasManifest,
  handheld: boolean,
  maxTextureSize: number,
): number | "error" {
  try {
    return selectOverviewAtlasLevel(source, { handheld, maxTextureSize }).width;
  } catch {
    return "error";
  }
}

check("handheld selects 1024", selected(manifest, true, 4096) === 1024);
check("desktop selects 4096", selected(manifest, false, 8192) === 4096);
check("WebGL limit steps desktop down to 2048", selected(manifest, false, 2048) === 2048);
check("WebGL limit steps desktop down to 1024", selected(manifest, false, 1024) === 1024);
check("rejects a GPU below the smallest level", selected(manifest, false, 512) === "error");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
