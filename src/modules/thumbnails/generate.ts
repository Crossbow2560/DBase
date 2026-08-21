import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const THUMBNAIL_MAX_DIMENSION = 320;
const EXEC_TIMEOUT_MS = 30_000;

/**
 * REQUIREMENTS.md §5.9: best-effort — a specific format/subtype/codec this can't handle is an
 * acceptable failure (the worker surfaces it as thumbnail_status='failed' after bounded retries,
 * DESIGN.md §3.13), not something this function needs to special-case. Throws on any failure.
 */
export async function generateThumbnailBuffer(mimeType: string, source: Buffer): Promise<Buffer> {
  if (mimeType.startsWith("image/")) {
    return resizeToThumbnail(source);
  }
  if (mimeType.startsWith("video/")) {
    return generateFromVideo(source);
  }
  if (mimeType === "application/pdf") {
    return generateFromPdf(source);
  }
  throw new Error(`Unsupported mime type for thumbnailing: ${mimeType}`);
}

async function resizeToThumbnail(source: Buffer): Promise<Buffer> {
  return sharp(source)
    .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dbase-thumb-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Shells out to ffmpeg/poppler-utils (installed in the runtime Docker image, Dockerfile) rather
// than a native npm binding — both are mature, widely-available CLI tools and this avoids
// pulling in heavier native bindings for what's a background, best-effort, low-stakes job.
async function generateFromVideo(source: Buffer): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, "input");
    const output = join(dir, "frame.jpg");
    await writeFile(input, source);
    // -ss before -i: fast (keyframe-seek) rather than frame-accurate — fine for a preview
    // thumbnail. A video shorter than 1s failing to produce a frame here is an acceptable
    // best-effort failure, not specially handled.
    await execFileAsync("ffmpeg", ["-y", "-ss", "1", "-i", input, "-frames:v", "1", "-q:v", "3", output], {
      timeout: EXEC_TIMEOUT_MS,
    });
    const frame = await readFile(output);
    return resizeToThumbnail(frame);
  });
}

async function generateFromPdf(source: Buffer): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, "input.pdf");
    const outputPrefix = join(dir, "page");
    await writeFile(input, source);
    // -singlefile: writes exactly {outputPrefix}.jpg, no page-number suffix to guess at.
    await execFileAsync(
      "pdftoppm",
      ["-jpeg", "-r", "100", "-f", "1", "-l", "1", "-singlefile", input, outputPrefix],
      { timeout: EXEC_TIMEOUT_MS },
    );
    const page = await readFile(`${outputPrefix}.jpg`);
    return resizeToThumbnail(page);
  });
}
