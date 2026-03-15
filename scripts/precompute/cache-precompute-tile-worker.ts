import { computeSunlightTileArtifact } from "../../src/lib/precompute/sunlight-tile-service";
import {
  loadPrecomputedSunlightTile,
  writePrecomputedSunlightTile,
  type RegionTileSpec,
} from "../../src/lib/precompute/sunlight-cache";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import type { ShadowCalibration } from "../../src/lib/sun/shadow-calibration";

type WorkerTask = {
  taskId: string;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: ShadowCalibration;
  skipExisting: boolean;
};

type WorkerRunMessage = {
  type: "run";
  task: WorkerTask;
};

type WorkerCancelMessage = {
  type: "cancel";
};

type WorkerInboundMessage = WorkerRunMessage | WorkerCancelMessage;

type WorkerProgressMessage = {
  type: "progress";
  taskId: string;
  stage: "prepare-points" | "evaluate-frames";
  completed: number;
  total: number;
  pointCountTotal: number;
  pointCountOutdoor: number;
  frameCountTotal: number;
  frameIndex: number | null;
};

type WorkerDoneMessage = {
  type: "done";
  taskId: string;
  state: "computed" | "skipped" | "failed" | "cancelled";
  pointCountTotal: number | null;
  pointCountOutdoor: number | null;
  frameCountTotal: number | null;
  error?: string;
};

let activeAbortController: AbortController | null = null;
let activeTaskId: string | null = null;

function postMessage(message: WorkerProgressMessage | WorkerDoneMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

async function runTask(task: WorkerTask): Promise<void> {
  const abortController = new AbortController();
  activeAbortController = abortController;
  activeTaskId = task.taskId;
  let lastProgressSentAt = 0;
  let lastProgressStage: WorkerProgressMessage["stage"] | null = null;

  try {
    if (task.skipExisting) {
      const existing = await loadPrecomputedSunlightTile({
        region: task.region,
        modelVersionHash: task.modelVersionHash,
        date: task.date,
        gridStepMeters: task.gridStepMeters,
        sampleEveryMinutes: task.sampleEveryMinutes,
        startLocalTime: task.startLocalTime,
        endLocalTime: task.endLocalTime,
        tileId: task.tile.tileId,
      });
      if (existing) {
        postMessage({
          type: "done",
          taskId: task.taskId,
          state: "skipped",
          pointCountTotal: existing.stats.gridPointCount,
          pointCountOutdoor: existing.stats.pointCount,
          frameCountTotal: existing.frames.length,
        });
        return;
      }
    }

    const artifact = await computeSunlightTileArtifact({
      region: task.region,
      modelVersionHash: task.modelVersionHash,
      algorithmVersion: task.algorithmVersion,
      date: task.date,
      timezone: task.timezone,
      sampleEveryMinutes: task.sampleEveryMinutes,
      gridStepMeters: task.gridStepMeters,
      startLocalTime: task.startLocalTime,
      endLocalTime: task.endLocalTime,
      tile: task.tile,
      shadowCalibration: task.shadowCalibration,
      cooperativeYieldEveryPoints: 50,
      signal: abortController.signal,
      onProgress: (progress) => {
        const now = Date.now();
        const shouldEmit =
          progress.completed === progress.total ||
          progress.stage !== lastProgressStage ||
          now - lastProgressSentAt >= 250;
        if (!shouldEmit) {
          return;
        }
        lastProgressSentAt = now;
        lastProgressStage = progress.stage;
        postMessage({
          type: "progress",
          taskId: task.taskId,
          stage: progress.stage,
          completed: progress.completed,
          total: progress.total,
          pointCountTotal: progress.pointCountTotal,
          pointCountOutdoor: progress.pointCountOutdoor,
          frameCountTotal: progress.frameCountTotal,
          frameIndex: progress.frameIndex,
        });
      },
    });

    await writePrecomputedSunlightTile(artifact);
    postMessage({
      type: "done",
      taskId: task.taskId,
      state: "computed",
      pointCountTotal: artifact.stats.gridPointCount,
      pointCountOutdoor: artifact.stats.pointCount,
      frameCountTotal: artifact.frames.length,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      postMessage({
        type: "done",
        taskId: task.taskId,
        state: "cancelled",
        pointCountTotal: null,
        pointCountOutdoor: null,
        frameCountTotal: null,
        error: "Precompute aborted.",
      });
      return;
    }
    postMessage({
      type: "done",
      taskId: task.taskId,
      state: "failed",
      pointCountTotal: null,
      pointCountOutdoor: null,
      frameCountTotal: null,
      error: error instanceof Error ? error.message : "Unknown worker error.",
    });
  } finally {
    if (activeTaskId === task.taskId) {
      activeAbortController = null;
      activeTaskId = null;
    }
  }
}

process.on("message", (message: WorkerInboundMessage) => {
  if (message.type === "cancel") {
    activeAbortController?.abort();
    return;
  }
  if (message.type === "run") {
    void runTask(message.task);
  }
});
