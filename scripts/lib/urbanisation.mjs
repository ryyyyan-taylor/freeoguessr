// The GHSL "Degree of Urbanisation" grid (GHS-SMOD R2023A, epoch 2025,
// 1 km cells, CC BY 4.0, European Commission JRC), downloaded once into
// scripts/.cache. Every land cell has one of these classes:
//
//   30 urban centre        23 dense urban cluster   22 semi-dense urban cluster
//   21 suburban/peri-urban 13 rural cluster (village)
//   12 low-density rural   11 very low-density rural 10 water
//
// The generator groups them into the game's three tiers (see tierOf).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fromFile } from "geotiff";

const NAME = "GHS_SMOD_E2025_GLOBE_R2023A_54009_1000_V2_0";
const URL_ZIP = `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_SMOD_GLOBE_R2023A/GHS_SMOD_E2025_GLOBE_R2023A_54009_1000/V2-0/${NAME}.zip`;
const DIR = new URL("../.cache/ghsl/", import.meta.url);
const TIF = new URL(`${NAME}.tif`, DIR);

// Mollweide (ESRI:54009) on a sphere of the WGS 84 semi-major axis, as the
// grid is published.
const R = 6378137;
const SQRT2 = Math.SQRT2;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function project(lat, lng) {
  const phi = toRad(lat);
  let theta = phi;
  if (Math.abs(lat) < 90) {
    const target = Math.PI * Math.sin(phi);
    for (let i = 0; i < 30; i++) {
      const delta = (2 * theta + Math.sin(2 * theta) - target) / (2 + 2 * Math.cos(2 * theta));
      theta -= delta;
      if (Math.abs(delta) < 1e-12) break;
    }
  }
  return { x: ((2 * SQRT2) / Math.PI) * R * toRad(lng) * Math.cos(theta), y: SQRT2 * R * Math.sin(theta) };
}

export function unproject(x, y) {
  const theta = Math.asin(Math.max(-1, Math.min(1, y / (SQRT2 * R))));
  const lat = toDeg(Math.asin((2 * theta + Math.sin(2 * theta)) / Math.PI));
  const lng = toDeg((Math.PI * x) / (2 * SQRT2 * R * Math.cos(theta)));
  return { lat, lng };
}

export const TIERS = ["city", "town", "rural"];

// city: urban centres and dense clusters (downtowns, big-city streets).
// town: semi-dense clusters, suburbs and villages, anywhere with buildings.
// rural: everything else, the open-country roads.
export function tierOf(cls) {
  if (cls >= 23) return "city";
  if (cls >= 13) return "town";
  return "rural";
}

async function ensureDownloaded() {
  if (existsSync(TIF)) return;
  mkdirSync(DIR, { recursive: true });
  console.log("Downloading the GHSL Degree of Urbanisation grid (~30 MB)…");
  const res = await fetch(URL_ZIP);
  if (!res.ok) throw new Error(`Urbanisation grid download failed: HTTP ${res.status}`);
  const zip = new URL(`${NAME}.zip`, DIR);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip.pathname, `${NAME}.tif`, "-d", DIR.pathname]);
}

export async function loadUrbanisation() {
  await ensureDownloaded();
  const image = await (await fromFile(TIF.pathname)).getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [originX, originY] = image.getOrigin();
  const [size] = image.getResolution();
  const tileW = image.getTileWidth();
  const tileH = image.getTileHeight();
  const tiles = new Map();

  async function tile(tx, ty) {
    const key = ty * 1000 + tx;
    if (!tiles.has(key)) {
      const window = [tx * tileW, ty * tileH, Math.min(width, (tx + 1) * tileW), Math.min(height, (ty + 1) * tileH)];
      const [data] = await image.readRasters({ window });
      tiles.set(key, { data, w: window[2] - window[0] });
    }
    return tiles.get(key);
  }

  async function classAtCell(col, row) {
    if (col < 0 || row < 0 || col >= width || row >= height) return 10;
    const t = await tile(Math.floor(col / tileW), Math.floor(row / tileH));
    const v = t.data[(row % tileH) * t.w + (col % tileW)];
    return v < 10 ? 10 : v; // no-data (-200) counts as water
  }

  const cellOf = (lat, lng) => {
    const { x, y } = project(lat, lng);
    return { col: Math.floor((x - originX) / size), row: Math.floor((originY - y) / size) };
  };

  return {
    width,
    height,
    async classAt(lat, lng) {
      const { col, row } = cellOf(lat, lng);
      return classAtCell(col, row);
    },
    // A uniformly random point inside the cell.
    randomPointIn(col, row) {
      return unproject(originX + (col + Math.random()) * size, originY - (row + Math.random()) * size);
    },
    // Every city and town cell, bucketed by whole degree of its centre's
    // latitude/longitude so a country's cells can be found from its bounding
    // box. The full-grid scan takes about a minute, so the result is cached.
    async builtUpCells() {
      let packed;
      if (existsSync(CELLS)) {
        const buf = readFileSync(CELLS);
        packed = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      } else {
        console.log("Indexing city and town cells (about a minute, once)…");
        const out = [];
        for (let y0 = 0; y0 < height; y0 += tileH) {
          const [data] = await image.readRasters({ window: [0, y0, width, Math.min(height, y0 + tileH)] });
          for (let i = 0; i < data.length; i++) {
            if (data[i] >= 13) out.push(i % width, y0 + Math.floor(i / width), data[i]);
          }
        }
        packed = Int32Array.from(out);
        writeFileSync(CELLS, Buffer.from(packed.buffer));
      }
      const buckets = new Map();
      for (let i = 0; i < packed.length; i += 3) {
        const col = packed[i];
        const row = packed[i + 1];
        const { lat, lng } = unproject(originX + (col + 0.5) * size, originY - (row + 0.5) * size);
        const key = bucketKey(lat, lng);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ col, row, lat, lng, tier: tierOf(packed[i + 2]) });
      }
      return {
        // Cells of this tier whose centre is inside the box.
        inBox({ w, e, s, n }, tier) {
          const found = [];
          for (let la = Math.floor(s); la <= Math.floor(n); la++)
            for (let lo = Math.floor(w); lo <= Math.floor(e); lo++)
              for (const c of buckets.get(`${la},${lo}`) ?? [])
                if (c.tier === tier && c.lat >= s && c.lat <= n && c.lng >= w && c.lng <= e) found.push(c);
          return found;
        },
      };
    },
  };
}

const CELLS = new URL(`${NAME}.built-up.bin`, DIR);
const bucketKey = (lat, lng) => `${Math.floor(lat)},${Math.floor(lng)}`;
