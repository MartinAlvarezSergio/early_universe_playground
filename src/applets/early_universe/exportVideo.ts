import { RecorderFormat } from "../../core/canvasRecorder";
import { exportOfflineVideo, OfflineExportResult } from "../../core/offlineVideoExport";
import { STORY_DURATION } from "./clock";
import { renderScene, SceneOptions } from "./render";
import { createEarlyUniverseSim } from "./sim";
import type { SimSettings } from "./types";

export type ExportOptions = {
  settings: SimSettings;
  scene: SceneOptions;
  width: number;
  height: number;
  fps: number;
  /** Film seconds per video second: 0.5 makes a video twice as long, in slow motion. */
  speed?: number;
  /** Story-time range to export (default: the whole film). */
  from?: number;
  to?: number;
  format?: RecorderFormat;
  onProgress: (done: number, total: number, preview: HTMLCanvasElement) => void;
  isCancelled: () => boolean;
};

export type ExportResult = OfflineExportResult;

/** Offline render: a fresh simulation with the same settings is stepped frame by frame. */
export async function exportFilm(opts: ExportOptions): Promise<ExportResult> {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(STORY_DURATION, opts.to ?? STORY_DURATION);
  const speed = opts.speed ?? 1;
  const sim = createEarlyUniverseSim(opts.settings);
  return exportOfflineVideo({
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    totalFrames: ((to - from) * opts.fps) / speed,
    filenameStem: "early_universe",
    format: opts.format,
    onProgress: opts.onProgress,
    isCancelled: opts.isCancelled,
    renderFrame: (ctx, i) => {
      sim.seek(from + (i * speed) / opts.fps);
      renderScene(ctx, { state: sim.state(), field: sim.field, settings: opts.settings }, opts.scene);
    }
  });
}
