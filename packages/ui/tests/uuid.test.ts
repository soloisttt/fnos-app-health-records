import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from '../src/utils/uuid';

afterEach(() => vi.unstubAllGlobals());
const format = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UUID compatibility', () => {
  it('prefers the native UUID method when available', () => {
    const uuid = '01234567-89ab-4def-8123-456789abcdef';
    const crypto = { randomUUID: vi.fn(function () { expect(this).toBe(crypto); return uuid; }), getRandomValues: vi.fn() };
    vi.stubGlobal('crypto', crypto);
    expect(createUuid()).toBe(uuid);
    expect(crypto.getRandomValues).not.toHaveBeenCalled();
  });
  for (const throws of [false, true]) {
    it(`generates UUID v4 when the native method ${throws ? 'throws' : 'is absent on HTTP'}`, () => {
      let calls = 0;
      const crypto = {
        ...(throws ? { randomUUID: () => { throw new Error('unavailable'); } } : {}),
        getRandomValues(bytes: Uint8Array) { expect(this).toBe(crypto); bytes.fill(++calls); return bytes; },
      };
      vi.stubGlobal('crypto', crypto);
      const first = createUuid(), second = createUuid();
      expect(first).toMatch(format);
      expect(second).toMatch(format);
      expect(first).not.toBe(second);
      // Existing note IDs require the compact 32-character form.
      expect(`note_${first.replaceAll('-', '')}`).toMatch(/^note_[a-f0-9]{32}$/);
    });
  }
  it('does not invent weak random IDs without a cryptographic random source', () => {
    vi.stubGlobal('crypto', undefined);
    expect(createUuid).toThrow('当前浏览器不支持安全随机数');
  });
});
