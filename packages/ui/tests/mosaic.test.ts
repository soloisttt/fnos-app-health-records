import { describe, expect, it } from "vitest";
import { mosaicPixels } from "../src/utils/mosaic";
describe("mosaic pixels", () => {
  it("averages each block independently and handles partial edge blocks", () => {
    const source = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 240, 240, 240, 255]);
    const result = mosaicPixels(source, 3, 1, 2);
    expect([...result]).toEqual([50, 50, 50, 255, 50, 50, 50, 255, 240, 240, 240, 255]);
    expect(source[0]).toBe(0);
  });
  it("averages in both directions while preserving opaque alpha", () => {
    const source = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
    expect([...mosaicPixels(source, 2, 2, 2)]).toEqual(Array(4).fill([100, 100, 100, 255]).flat());
  });
});
