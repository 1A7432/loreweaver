// The text forms of `model`, `imagegen` and `key` in both languages, and what each role may
// run. The room-level behaviour (pinning, disconnects, secrets) is in `room_admin.test.ts`.
import { describe, expect, test } from "bun:test";

import { ADA, ADMIN, bench, code, ENV_KEY, EVE, ok } from "./bench.ts";

describe("text forms", () => {
  const cases: readonly [string, { readonly id: string; readonly args: Record<string, unknown> }][] = [
    [".model", { id: "model", args: { op: "show" } }],
    [".模型 查看", { id: "model", args: { op: "show" } }],
    [".model list", { id: "model", args: { op: "list" } }],
    [".model 列表 deepseek lane=fold", { id: "model", args: { op: "list", provider: "deepseek", lane: "memory" } }],
    [".model use mylab m1 base_url=http://10.0.0.5:8000/v1 wire=openai-responses effort=high context=128000 cache=off", { id: "model", args: { op: "set", provider: "mylab", model: "m1", baseUrl: "http://10.0.0.5:8000/v1", wire: "openai-responses", effort: "high", contextWindow: 128000, promptCacheKey: false } }],
    [".模型 切换 deepseek", { id: "model", args: { op: "set", provider: "deepseek" } }],
    [".model 密钥 sk-AbC-0123456789xyz", { id: "model", args: { op: "key", key: "sk-AbC-0123456789xyz" } }],
    [".model reset scribe", { id: "model", args: { op: "reset", lane: "scribe" } }],
    [".model 重置", { id: "model", args: { op: "reset" } }],
    [".imagegen", { id: "imagegen", args: { op: "show" } }],
    [".图片生成 关闭", { id: "imagegen", args: { op: "off" } }],
    [".imagegen set xai grok-imagine base_url=https://images.example/v1 key=xk-0123456789abcdef", { id: "imagegen", args: { op: "set", provider: "xai", model: "grok-imagine", baseUrl: "https://images.example/v1", key: "xk-0123456789abcdef" } }],
    [".key", { id: "key", args: { op: "list" } }],
    [".钥匙 新建 观察者 小明 同学", { id: "key", args: { op: "mint", role: "observer", name: "小明 同学" } }],
    [".key mint Cleo the Bold", { id: "key", args: { op: "mint", role: "player", name: "Cleo the Bold" } }],
    [".key rename k:0123456789ab Cleo", { id: "key", args: { op: "rename", id: "k:0123456789ab", name: "Cleo" } }],
    [".鑰匙 角色 k:0123456789ab 管理员", { id: "key", args: { op: "role", id: "k:0123456789ab", role: "admin" } }],
    [".key 吊销 k:0123456789ab", { id: "key", args: { op: "revoke", id: "k:0123456789ab" } }],
  ];
  for (const [line, expected] of cases) {
    test(line, () => {
      const b = bench({ admin: true });
      expect(b.registry.textCommand(b.context(ADMIN, { newTurn: false }), line, "en")).toEqual(expected);
    });
  }

  test("malformed lines are refused with the usage line and never echo their arguments", () => {
    const b = bench({ admin: true });
    for (const line of [".model key", ".model key sk-SECRET-0123456789 extra", ".model set", ".model set openai gpt x y", ".model set openai gpt nonsense=1", ".model reset nowhere", ".key role k:0123456789ab wizard", ".key mint", ".imagegen set"]) {
      const parsed = b.registry.textCommand(b.context(ADMIN, { newTurn: false }), line, "en");
      expect([line, parsed !== null && "code" in parsed ? parsed.code : parsed]).toEqual([line, "usage"]);
      expect(JSON.stringify(parsed)).not.toContain("SECRET");
    }
  });
});

describe("who may", () => {
  test("anyone sees the provider catalog; the rest is the admin's; an observer too may read the catalog", async () => {
    const b = bench({ admin: true });
    expect(ok(await b.run(ADA, "model", { op: "list" })).data).toEqual({ providers: ["openai", "anthropic", "deepseek", "openrouter", "moonshot"] });
    expect(ok(await b.run(EVE, "model", { op: "list" })).text).toContain("deepseek");
    for (const args of [{ op: "show" }, { op: "list", provider: "openai" }, { op: "list", lane: "scribe" }, { op: "key", key: "sk-0123456789abcdefgh" }, { op: "reset" }]) {
      expect(code(await b.run(ADA, "model", args))).toBe("forbidden");
    }
    expect(code(await b.run(ADA, "imagegen", { op: "show" }))).toBe("forbidden");
    expect(code(await b.run(ADA, "key", { op: "list" }))).toBe("forbidden");
  });

  test("the admin's show masks every key; set and key answer masked; refusals name no secret", async () => {
    const b = bench({ admin: true });
    const shown = ok(await b.run(ADMIN, "model", { op: "show" }));
    expect(JSON.stringify(shown)).not.toContain(ENV_KEY);
    expect(shown.text).toContain("sk-e...6789");
    const set = ok(await b.run(ADMIN, "model", { op: "set", provider: "deepseek", model: "deepseek-v4-pro", key: "sk-SECRET-deepseek-0123456789" }));
    expect(JSON.stringify(set)).not.toContain("sk-SECRET-deepseek-0123456789");
    expect(set.events).toEqual([]);
    const refused = await b.run(ADMIN, "model", { op: "set", provider: "nonesuch", model: "m", key: "sk-SECRET-other-0123456789" });
    expect(code(refused)).toBe("unknown_provider");
    expect(JSON.stringify(refused)).not.toContain("SECRET");
    expect(b.models?.describeLane("keeper").provider).toBe("deepseek");
  });

  test("without model settings or keys on the server, the commands say so", async () => {
    const b = bench();
    expect(code(await b.run(ADMIN, "model", { op: "show" }))).toBe("settings_unavailable");
    expect(code(await b.run(ADMIN, "key", { op: "list" }))).toBe("settings_unavailable");
    const listed = await b.registry.view(b.context(ADMIN), "en");
    expect(listed.commands.find((entry) => entry.id === "key")).toMatchObject({ available: false, reason: "settings_unavailable" });
  });
});
