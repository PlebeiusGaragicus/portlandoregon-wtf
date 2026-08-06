import { TileScheduler } from "../client/src/render/tile-scheduler.js";

let failed = 0;
const check = (name: string, ok: boolean): void => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const scheduler = new TileScheduler();
scheduler.updateWanted("buildings", [30, 20, 10]);
scheduler.updateWanted("dressing", [300, 200]);
scheduler.updateWanted("terrain", [3]);
scheduler.updateWanted("props", [3000, 2000]);
const first = scheduler.claim(4);
check("first claim is fair across every active layer", new Set(first.map((job) => job.kind)).size === 4);
check(
  "each layer claims its nearest tile first",
  first.some((job) => job.kind === "buildings" && job.key === 30) &&
    first.some((job) => job.kind === "dressing" && job.key === 300) &&
    first.some((job) => job.kind === "terrain" && job.key === 3) &&
    first.some((job) => job.kind === "props" && job.key === 3000),
);

const building = first.find((job) => job.kind === "buildings")!;
check("valid work completes", scheduler.complete(building, 4096));
check("completed bytes are counted", scheduler.stats().completedBytes === 4096);
check("valid completed work is accepted", scheduler.accept(building));

const dressing = first.find((job) => job.kind === "dressing")!;
scheduler.updateWanted("dressing", [999]);
check("leaving the window cancels in-flight work", scheduler.stats().cancelled > 0);
check("cancelled result is rejected as stale", !scheduler.complete(dressing, 1));

scheduler.updateWanted("props", []);
scheduler.updateWanted("props", [3000]);
const revisited = scheduler.claim(20).find((job) => job.kind === "props" && job.key === 3000);
check("revisited work receives a new generation", !!revisited && revisited.generation > 1);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exitCode = failed ? 1 : 0;
