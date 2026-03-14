import { NextResponse } from "next/server";

import { getCachePrecomputeJob } from "@/lib/admin/cache-precompute-jobs";

export const runtime = "nodejs";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeSseEvent(
  encoder: TextEncoder,
  event: string,
  payload: unknown,
): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const existing = getCachePrecomputeJob(jobId);
  if (!existing) {
    console.warn("[cache-admin-api] job stream miss", { jobId });
    return NextResponse.json(
      { error: `Unknown precompute job '${jobId}'.` },
      { status: 404 },
    );
  }
  console.info("[cache-admin-api] job stream open", {
    jobId,
    status: existing.status,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const onAbort = () => {
        console.info("[cache-admin-api] job stream abort", { jobId });
        close();
      };
      request.signal.addEventListener("abort", onAbort);

      void (async () => {
        let lastRevision = -1;
        controller.enqueue(encoder.encode("retry: 1500\n\n"));

        while (!closed) {
          const job = getCachePrecomputeJob(jobId);
          if (!job) {
            console.warn("[cache-admin-api] job stream lost job", { jobId });
            controller.enqueue(
              encodeSseEvent(encoder, "error", {
                error: "Job disappeared (probably server restart).",
              }),
            );
            close();
            break;
          }

          if (job.revision !== lastRevision) {
            lastRevision = job.revision;
            controller.enqueue(encodeSseEvent(encoder, "job", job));
          } else {
            controller.enqueue(
              encodeSseEvent(encoder, "heartbeat", {
                jobId,
                ts: new Date().toISOString(),
              }),
            );
          }

          if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled" ||
            job.status === "interrupted"
          ) {
            console.info("[cache-admin-api] job stream done", {
              jobId,
              status: job.status,
            });
            controller.enqueue(
              encodeSseEvent(encoder, "done", {
                jobId,
                status: job.status,
              }),
            );
            close();
            break;
          }

          await sleep(1000);
        }
      })().catch((error) => {
        if (!closed) {
          console.error("[cache-admin-api] job stream error", {
            jobId,
            error: error instanceof Error ? error.message : "Unknown stream error",
          });
          controller.enqueue(
            encodeSseEvent(encoder, "error", {
              error: error instanceof Error ? error.message : "Unknown stream error",
            }),
          );
          close();
        }
      });
    },
    cancel() {
      // Client closed the stream.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
