import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

/*
 * 登录页原先把用户名和密码都写死预填成 admin/admin（第一次打开就摆着一组默认密码），
 * 而会话只有 12 小时，隔天必然要重登。
 * 现在：只记住上次登录的用户名（密码不落盘），并可选「记住我（30 天）」。
 */

const mocked = vi.hoisted(() => ({ request: vi.fn(), logins: [] as Array<Record<string, unknown>> }));
vi.mock("../src/utils/api", () => ({
  request: mocked.request,
  ApiRequestError: class extends Error { status = 0; },
}));

const LAST_USERNAME_KEY = "health-records:last-username";
const account = { id: "user-a", authMode: "local", authenticated: false, mustChangePassword: false, isAdmin: false, setupRequired: false };
const member = { id: "member-1", displayName: "张铭浩", hidden: false, permission: "manager" };
const prefs = { selfMemberId: null, selfProfileChoice: "skipped", defaultMemberId: null };

beforeEach(() => {
  vi.resetModules();
  mocked.request.mockReset();
  mocked.logins.length = 0;
  localStorage.clear();
});

async function mountLogin() {
  mocked.request.mockImplementation(async (path: string, options?: { body?: string }) => {
    if (path === "auth/login") {
      mocked.logins.push(JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>);
      return { authenticated: true };
    }
    if (path === "session") return account;
    if (path === "members") return [member];
    if (path === "account/preferences") return prefs;
    if (path.startsWith("reminders") || path.startsWith("notifications")) return [];
    return [];
  });
  const { useAppContext } = await import("../src/composables/useAppContext");
  const app = useAppContext();
  await app.load();

  const LoginView = (await import("../src/pages/LoginView.vue")).default;
  const wrapper = mount(LoginView);
  await nextTick();
  return wrapper;
}

const valueOf = (input: { element: Element }) => (input.element as HTMLInputElement).value;

describe("登录页：不预填密码、记住上次用户名、可选「记住我」", () => {
  it("首次打开不再预填 admin/admin", async () => {
    const wrapper = await mountLogin();
    const inputs = wrapper.findAll("input");
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(valueOf(inputs[0]!)).toBe("");
    expect(valueOf(inputs[1]!)).toBe("");
    expect(wrapper.text()).toContain("首次登录使用 admin / admin");
    wrapper.unmount();
  });

  it("预填上次登录的用户名，密码留空；登录成功后记住用户名", async () => {
    localStorage.setItem(LAST_USERNAME_KEY, "zhangsan");
    const wrapper = await mountLogin();
    const inputs = wrapper.findAll("input");
    expect(valueOf(inputs[0]!)).toBe("zhangsan");
    expect(valueOf(inputs[1]!)).toBe("");
    /* 已经记住了用户名，就不再提示默认账号 */
    expect(wrapper.text()).not.toContain("首次登录使用 admin / admin");

    await inputs[1]!.setValue("secret-pass");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(mocked.logins.at(-1)).toMatchObject({ username: "zhangsan" });
    expect(localStorage.getItem(LAST_USERNAME_KEY)).toBe("zhangsan");
    wrapper.unmount();
  });

  it("勾了「记住我」会把 remember 一起提交", async () => {
    const wrapper = await mountLogin();
    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("admin");
    await inputs[1]!.setValue("secret-pass");
    await inputs[2]!.setValue(true);
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(mocked.logins.at(-1)).toMatchObject({ username: "admin", remember: true });
    wrapper.unmount();
  });

  it("默认不勾「记住我」（不长期免登）", async () => {
    const wrapper = await mountLogin();
    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("admin");
    await inputs[1]!.setValue("secret-pass");
    await wrapper.find("form").trigger("submit");
    await nextTick();
    expect(mocked.logins.at(-1)).toMatchObject({ remember: false });
    wrapper.unmount();
  });
});
