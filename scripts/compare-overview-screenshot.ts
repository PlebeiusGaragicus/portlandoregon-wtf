import { createCanvas, loadImage } from "@napi-rs/canvas";

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  throw new Error("usage: compare-overview-screenshot.ts <expected.png> <actual.png>");
}

function pixels(image: Awaited<ReturnType<typeof loadImage>>): Uint8ClampedArray {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
}

async function main(): Promise<void> {
  const [expectedImage, actualImage] = await Promise.all([
    loadImage(expectedPath!),
    loadImage(actualPath!),
  ]);
  if (
    expectedImage.width !== actualImage.width ||
    expectedImage.height !== actualImage.height
  ) {
    throw new Error(
      `overview dimensions changed: expected ${expectedImage.width}x${expectedImage.height}, ` +
      `got ${actualImage.width}x${actualImage.height}`,
    );
  }

  const expected = pixels(expectedImage);
  const actual = pixels(actualImage);
  let totalDelta = 0;
  let changed = 0;
  const pixelCount = expectedImage.width * expectedImage.height;
  for (let offset = 0; offset < expected.length; offset += 4) {
    const delta =
      Math.abs(expected[offset]! - actual[offset]!) +
      Math.abs(expected[offset + 1]! - actual[offset + 1]!) +
      Math.abs(expected[offset + 2]! - actual[offset + 2]!);
    totalDelta += delta / 3;
    if (delta / 3 > 32) changed++;
  }

  const meanDelta = totalDelta / pixelCount;
  const changedFraction = changed / pixelCount;
  const maxMeanDelta = Number(process.env["BJ_GOLDEN_MAX_MEAN_DELTA"] ?? 12);
  const maxChangedFraction = Number(process.env["BJ_GOLDEN_MAX_CHANGED_FRACTION"] ?? 0.15);
  console.log(
    `overview golden: mean delta ${meanDelta.toFixed(2)}, ` +
    `changed ${(changedFraction * 100).toFixed(2)}%`,
  );
  if (meanDelta > maxMeanDelta || changedFraction > maxChangedFraction) {
    throw new Error(
      `overview golden exceeded tolerance ` +
      `(mean <= ${maxMeanDelta}, changed <= ${(maxChangedFraction * 100).toFixed(1)}%)`,
    );
  }
}

void main();
