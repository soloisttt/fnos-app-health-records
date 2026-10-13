import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/utils/clipboard";

/*
 * 用户实际踩到的坑：NAS 上用 http 访问，浏览器禁用 navigator.clipboard，
 * 点「复制」只会失败。所以必须保证退回 execCommand 这条路可用。
 */
describe("复制到剪贴板", () => {
  it("没有剪贴板 API（http 页面）时退回 execCommand", async () => {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    expect(await copyTextToClipboard("就诊摘要")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    /* 临时 textarea 用完要清掉，别留在页面上 */
    expect(document.querySelectorAll("textarea").length).toBe(0);

    Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
  });

  it("剪贴板 API 可用时优先用它", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    expect(await copyTextToClipboard("就诊摘要")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("就诊摘要");
  });

  it("两条路都失败时返回 false（界面据此提示长按复制）", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error("not allowed");
    };
    expect(await copyTextToClipboard("就诊摘要")).toBe(false);
    expect(await copyTextToClipboard("")).toBe(false);
  });
});
