/**
 * DOCX image sizing (#2753). package.json overrides image-size to 2.x, which
 * fixes GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr for the lockfile, but
 * html-to-docx 1.8.0 runs a bundled image-size 1.x copy the override cannot
 * reach. The golden document.xml was captured before the override, so any
 * change to the Word output shows up as a diff here. The orchestrator only
 * hands html-to-docx images whose bytes are PNG, JPEG, GIF, WebP or SVG, so
 * the bundled ICNS parser's infinite loop never runs.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { docxSafeImage } from "../src/image-size";
import { generate } from "../src/orchestrator";

const FIXTURES = path.join(import.meta.dir, "fixtures", "docx-images");
const EMU_PER_PX = 9525;
const IMAGES = [
  { file: "wide.png", ext: "png", width: 120, height: 48 },
  { file: "tall.jpg", ext: "jpeg", width: 30, height: 90 },
  { file: "square.gif", ext: "gif", width: 64, height: 64 },
];

/** GHSA-w3rx-r6r6-pgpr: valid ICNS magic and a zero-length entry. */
function icnsLoop(): Buffer {
  const buf = Buffer.alloc(24);
  buf.write("icns", 0);
  buf.writeUInt32BE(24, 4);
  buf.write("ic08", 8);
  return buf;
}

function unzip(args: string[]): Buffer {
  return execFileSync("unzip", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

describe("make-pdf --to docx image sizing", () => {
  test("embeds every image at its pixel size, matching the image-size 1.x output", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-docx-images-"));
    try {
      const out = path.join(workDir, "out.docx");
      await generate({ input: path.join(FIXTURES, "doc.md"), output: out, to: "docx", quiet: true });

      const xml = unzip(["-p", out, "word/document.xml"]).toString("utf8");
      const extents = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(m => [Number(m[1]), Number(m[2])]);
      expect(extents).toEqual(IMAGES.map(img => [img.width * EMU_PER_PX, img.height * EMU_PER_PX]));

      const media = unzip(["-Z1", out]).toString("utf8").split("\n").filter(name => /^word\/media\/.+/.test(name));
      expect(media).toHaveLength(IMAGES.length);
      for (const [i, img] of IMAGES.entries()) {
        expect(media[i].endsWith(`.${img.ext}`)).toBe(true);
        expect(unzip(["-p", out, media[i]]).equals(fs.readFileSync(path.join(FIXTURES, img.file)))).toBe(true);
      }

      const normalized = xml.replace(/image-[A-Za-z0-9_-]{21}\.(png|jpeg|gif)/g, "image-ID.$1");
      expect(normalized.trimEnd()).toBe(fs.readFileSync(path.join(FIXTURES, "document.golden.xml"), "utf8").trimEnd());
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("only PNG, JPEG, GIF, WebP and SVG markup reach html-to-docx's bundled sizer", () => {
    for (const img of IMAGES) expect(docxSafeImage(fs.readFileSync(path.join(FIXTURES, img.file)))).toBe(true);
    expect(docxSafeImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
    expect(docxSafeImage(icnsLoop())).toBe(false);
    expect(docxSafeImage(Buffer.concat([icnsLoop(), Buffer.from('<svg width="1" height="1">')]))).toBe(false);
    expect(docxSafeImage(Buffer.from("BM not an image at all"))).toBe(false);
  });

  test("an ICNS file named .png is dropped with a warning instead of hanging the conversion", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-docx-icns-"));
    try {
      fs.writeFileSync(path.join(workDir, "evil.png"), icnsLoop());
      fs.writeFileSync(path.join(workDir, "doc.md"), "# ICNS\n\n![evil](evil.png)\n\n![inline](data:image/png;base64," + icnsLoop().toString("base64") + ")\n");
      const out = path.join(workDir, "out.docx");
      const script = `import { generate } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "orchestrator.ts"))};
await generate({ input: ${JSON.stringify(path.join(workDir, "doc.md"))}, output: ${JSON.stringify(out)}, to: "docx" });`;
      const run = Bun.spawnSync([process.execPath, "-e", script], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
      const stderr = run.stderr.toString();
      expect(run.exitCode).toBe(0);
      expect(stderr.match(/docx: dropped an image that is not PNG, JPEG, GIF, WebP or SVG/g)).toHaveLength(2);
      expect(unzip(["-p", out, "word/document.xml"]).toString("utf8")).not.toContain("<w:drawing>");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
