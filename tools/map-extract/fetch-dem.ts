// Elevation — USGS 3DEP 1/3 arc-second (~10 m) DEM -> game heightfield.
//
// One public-domain GeoTIFF tile (n46w123: 45-46N, 122-123W) covers the whole
// whole-metro play area. Downloaded once into data/raw/dem/ (gitignored),
// then resampled onto the map's local-meter frame at HEIGHT_CELL_M and
// quantized to HEIGHT_SCALE_M steps as Uint16.
//
// Output: data/maps/{profile}-heightmap.bin.gz — self-contained:
//   bytes 0-3   magic "BJH1"
//   bytes 4-7   uint32 LE cols   (vertices per row)
//   bytes 8-11  uint32 LE rows
//   bytes 12-15 float32 LE cell size, meters
//   bytes 16-19 float32 LE height scale, meters per unit
//   bytes 20-   uint16 LE heights, row-major, row 0 = south edge (y = 0)
//
// 3DEP is hydro-flattened: water surfaces are flat at their real elevation,
// so the terrain mesh renders rivers at the right level for free.
//
// Run: npm run fetch-dem -w tools/map-extract
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
// eslint-disable-next-line import/no-extraneous-dependencies
import { fromFile } from "geotiff";
import { DATA_DIR, MANIFEST_FILE, MAP_NAME, MAPS_ASSET_DIR, USER_AGENT } from "./config.js";
import { fromLocal, playArea } from "./lib/proj.js";

const TILE = "USGS_13_n46w123";
const TILE_URL = `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n46w123/${TILE}.tif`;
const DEM_DIR = join(DATA_DIR, "raw", "dem");
const DEM_FILE = join(DEM_DIR, `${TILE}.tif`);

const HEIGHT_CELL_M = 30; // heightfield vertex spacing
const HEIGHT_SCALE_M = 0.5; // quantization step
const NODATA_FLOOR = -1000; // 3DEP nodata is a large negative sentinel

async function download(): Promise<void> {
  if (existsSync(DEM_FILE)) {
    console.log(`DEM cached: ${DEM_FILE}`);
    return;
  }
  mkdirSync(DEM_DIR, { recursive: true });
  console.log(`downloading ${TILE_URL} (one-time, ~400 MB)…`);
  const res = await fetch(TILE_URL, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`DEM download failed: HTTP ${res.status}`);
  const tmp = `${DEM_FILE}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  const { renameSync } = await import("node:fs");
  renameSync(tmp, DEM_FILE);
  console.log(`  saved ${DEM_FILE}`);
}

async function main(): Promise<void> {
  await download();

  const tiff = await fromFile(DEM_FILE);
  const image = await tiff.getImage();
  const [west, south, east, north] = image.getBoundingBox() as [number, number, number, number];
  const W = image.getWidth();
  const H = image.getHeight();
  console.log(`DEM: ${W}x${H} px, bbox ${west},${south} .. ${east},${north}`);
  console.log("reading raster (this holds ~470 MB)…");
  const raster = (await image.readRasters({ interleave: true })) as unknown as Float32Array;

  // Bilinear sample of the geographic raster at lon/lat.
  const sample = (lon: number, lat: number): number => {
    const fx = ((lon - west) / (east - west)) * (W - 1);
    const fy = ((north - lat) / (north - south)) * (H - 1);
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const v00 = raster[y0 * W + x0]!;
    const v10 = raster[y0 * W + x0 + 1]!;
    const v01 = raster[(y0 + 1) * W + x0]!;
    const v11 = raster[(y0 + 1) * W + x0 + 1]!;
    if (v00 < NODATA_FLOOR || v10 < NODATA_FLOOR || v01 < NODATA_FLOOR || v11 < NODATA_FLOOR) return 0;
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  };

  const area = playArea();
  const cols = Math.floor(area.width / HEIGHT_CELL_M) + 1;
  const rows = Math.floor(area.height / HEIGHT_CELL_M) + 1;
  console.log(`resampling ${cols}x${rows} vertices at ${HEIGHT_CELL_M} m…`);

  const data = new Uint16Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < rows; r++) {
    const y = r * HEIGHT_CELL_M;
    for (let c = 0; c < cols; c++) {
      const [lon, lat] = fromLocal(c * HEIGHT_CELL_M, y);
      const h = Math.max(0, sample(lon, lat));
      min = Math.min(min, h);
      max = Math.max(max, h);
      data[r * cols + c] = Math.min(65535, Math.round(h / HEIGHT_SCALE_M));
    }
  }
  console.log(`  elevation range ${min.toFixed(1)}..${max.toFixed(1)} m`);

  const header = Buffer.alloc(20);
  header.write("BJH1", 0, "ascii");
  header.writeUInt32LE(cols, 4);
  header.writeUInt32LE(rows, 8);
  header.writeFloatLE(HEIGHT_CELL_M, 12);
  header.writeFloatLE(HEIGHT_SCALE_M, 16);
  const payload = Buffer.concat([header, Buffer.from(data.buffer)]);
  const gz = gzipSync(payload, { level: 9 });

  mkdirSync(MAPS_ASSET_DIR, { recursive: true });
  const outFile = join(MAPS_ASSET_DIR, `${MAP_NAME}-heightmap.bin.gz`);
  writeFileSync(outFile, gz);
  console.log(
    `wrote ${outFile} (${(payload.length / 1048576).toFixed(1)} MB raw, ${(gz.length / 1048576).toFixed(1)} MB gz)`,
  );

  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Record<string, unknown>;
  manifest["heightfield"] = {
    source: TILE_URL,
    cellSizeM: HEIGHT_CELL_M,
    scaleM: HEIGHT_SCALE_M,
    cols,
    rows,
    elevationRangeM: [Math.round(min * 10) / 10, Math.round(max * 10) / 10],
    file: `data/maps/${MAP_NAME}-heightmap.bin.gz`,
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
}

await main();
