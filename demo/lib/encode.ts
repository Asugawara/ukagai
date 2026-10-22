// Calls to the encoders: img2webp (animated WebP), ffmpeg (MP4, preview), magick (contact sheet).
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEBP_MAX_BYTES = 9_500_000;
export const MP4_MAX_BYTES = 10_000_000;

export function have(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

// Frame durations that add up exactly: 24 fps gives 42 / 42 / 41 ms
export function frameDurations(frames: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) out.push(Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps));
  return out;
}

// img2webp reads its arguments from a file when it gets one argument; run in the frames dir so the paths stay short
export function encodeWebp(framesDir: string, frames: number, fps: number, out: string): void {
  const durs = frameDurations(frames, fps);
  const args = ["-loop", "0", "-sharp_yuv", "-lossy", "-q", "70", "-m", "4"];
  for (let i = 0; i < frames; i++) args.push("-d", String(durs[i]), `f${String(i).padStart(5, "0")}.png`);
  args.push("-o", out);
  const argFile = join(framesDir, "img2webp.args");
  writeFileSync(argFile, args.join("\n") + "\n");
  execFileSync("img2webp", [argFile], { cwd: framesDir, stdio: ["ignore", "ignore", "inherit"] });
}

export function encodeMp4(framesDir: string, fps: number, out: string): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(framesDir, "f%05d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

export function encodePreview(framesDir: string, fps: number, out: string): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(framesDir, "f%05d.png"), "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

const FONT = "/System/Library/Fonts/Helvetica.ttc";

function fontFile(): string {
  if (process.platform === "darwin") return FONT;
  try {
    return execFileSync("fc-match", ["-f", "%{file}", "sans"], { encoding: "utf8" }).trim();
  } catch {
    return FONT;
  }
}

// files are named like 05.65-explain.png; the label is the name without the extension
export function contactSheet(files: string[], out: string): void {
  execFileSync("magick", ["montage", "-font", fontFile(), "-background", "#111", "-fill", "white", "-label", "%t", ...files, "-tile", "6x", "-geometry", "320x180+4+4", out], { stdio: ["ignore", "ignore", "inherit"] });
}
