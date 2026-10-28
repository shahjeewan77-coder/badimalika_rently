import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// env.ts 在导入时就 required() 了一批变量,所以每个用例前把它们补齐,
// 再用 vi.resetModules 拿一份新的。
const PLATFORM = {
  DATABASE_URL: "postgresql://u:p@h/db",
  JWT_SECRET: "j",
  APP_SLUG: "demo",
};

async function loadEnv() {
  const mod = await import("./env");
  return mod.env;
}

describe("user-supplied configuration and secrets", () => {
  beforeEach(() => {
    Object.assign(process.env, PLATFORM);
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.SUPPORT_EMAIL;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("returns a configured value", async () => {
    process.env.SUPPORT_EMAIL = "help@example.com";
    const env = await loadEnv();
    expect(env.config("SUPPORT_EMAIL")).toBe("help@example.com");
  });

  it("falls back when a config is absent", async () => {
    const env = await loadEnv();
    expect(env.config("SUPPORT_EMAIL", "default@example.com"))
      .toBe("default@example.com");
  });

  it("treats an empty-string config the same as absent — falls back when given one", async () => {
    process.env.SUPPORT_EMAIL = "";
    const env = await loadEnv();
    expect(env.config("SUPPORT_EMAIL", "default@example.com"))
      .toBe("default@example.com");
  });

  it("treats an empty-string config the same as absent — throws with no fallback", async () => {
    process.env.SUPPORT_EMAIL = "";
    const env = await loadEnv();
    expect(() => env.config("SUPPORT_EMAIL")).toThrow(/SUPPORT_EMAIL/);
  });

  it("throws for a missing config with no fallback, naming where to set it", async () => {
    const env = await loadEnv();
    // 报错是整条链路的最后一环,也是用户唯一会看到的那一环 —— agent 读不到
    // 值也填不了值,所以这句话必须说清楚去哪填。
    expect(() => env.config("SUPPORT_EMAIL")).toThrow(/Settings/);
    expect(() => env.config("SUPPORT_EMAIL")).toThrow(/SUPPORT_EMAIL/);
  });

  it("throws for a missing secret — no fallback parameter exists", async () => {
    const env = await loadEnv();
    expect(() => env.secret("STRIPE_SECRET_KEY")).toThrow(/Settings/);
  });

  it("names the SCOPE the value is missing from, dev and prod alike", async () => {
    // dev 和 prod 对同一个 key 存的是两份值,所以只说「去设置里填」会把用户
    // 指向他已经填过的那一列。spec §7.1 的例子就带着 (prod)。
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      vi.resetModules();
      const prodEnv = await loadEnv();
      expect(() => prodEnv.secret("STRIPE_SECRET_KEY")).toThrow(/\(prod\)/);

      process.env.NODE_ENV = "development";
      vi.resetModules();
      const devEnv = await loadEnv();
      expect(() => devEnv.secret("STRIPE_SECRET_KEY")).toThrow(/\(dev\)/);
      expect(() => devEnv.config("SUPPORT_EMAIL")).toThrow(/\(dev\)/);
    } finally {
      // NODE_ENV 决定 isProd,而 isProd 是模块级常量 —— 漏还原会让这个文件
      // 后面每一条用例都跑在一个它没选过的环境里。
      process.env.NODE_ENV = savedNodeEnv;
      vi.resetModules();
    }
  });

  it("refuses to read a platform variable through the user accessors", async () => {
    const env = await loadEnv();
    expect(() => env.config("DATABASE_URL")).toThrow(/platform/i);
    expect(() => env.secret("JWT_SECRET")).toThrow(/platform/i);
  });
});

describe("dotenv precedence (the ground this design stands on)", () => {
  it("lets a later line win over an earlier one for the same key", async () => {
    // 平台变量排在 .env 的最后就永远赢 —— 即使写入层的保留名单漏了一个,
    // 用户也覆盖不掉 DATABASE_URL。依赖钉在 dotenv 17.4.2;bump 的人不该
    // 靠读设计文档才知道不能碰这个行为。
    const dotenv = await import("dotenv");
    const parsed = dotenv.parse("K=first\nK=second\n");
    expect(parsed.K).toBe("second");
  });
});

// 同一块路标,给 bump 依赖的人看的第二条:平台写 .env 的那三处
// (scaffold.build_env_file / deploy_provider 的两处)用的是下面这套引号规则。
// 它不是风格,是正确性 —— 未加引号时 dotenv 在第一个 # 处截断值,一个密码
// 带 # 的第三方 key 会在预览和 DaytonaPark 生产上悄悄变短,而 Cloud Run 走
// 的是真环境变量、拿到的是完整值。同一个密钥两个值,没有任何报错。
//
// 规则(与 backend/core/webapp_builder/scaffold.py::quote_env_value 一致):
// 值里没有 ' → 用 ';否则没有 ` → 用 `;否则没有 " 也没有 \ → 用 "。
// 都不满足则那个值根本没法写进 .env,写入层直接拒。
function quoteEnvValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return "`" + value + "`";
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new Error("unquotable");
}

describe("dotenv value fidelity (what the platform writes is what the app reads)", () => {
  const cases = [
    "abc#def",                      // 这一条是全部理由:裸写会被截成 "abc"
    "postgres://user:p#ss@host/db", // 平台自己的 DSN 也走同一条线
    "plain",
    "with space",
    "#leading",
    "trailing#",
    'has"double',
    "has'single",
    "has`backtick",
    "back\\slash",                  // 双引号里 \n 会被反转义,所以不能用双引号
    "C:\\new",
    "a'b`c",
    "$dollar{brace}",
    "",
  ];

  it.each(cases)("round-trips %j through dotenv unchanged", async (value) => {
    const dotenv = await import("dotenv");
    // 后面跟一行哨兵:被截断的值会把剩下的半行当注释吃掉,只断言 K 看不出来。
    const parsed = dotenv.parse(`K=${quoteEnvValue(value)}\nNEXT=sentinel\n`);
    expect(parsed.K).toBe(value);
    expect(parsed.NEXT).toBe("sentinel");
  });

  it("shows what the bare form this replaced actually did", async () => {
    // 回归的证据本身。有人把引号拿掉时,上面那组会红,这一条会绿 —— 两边
    // 合起来说明白了「为什么当初要加引号」。
    const dotenv = await import("dotenv");
    expect(dotenv.parse("K=abc#def\n").K).toBe("abc");
    expect(dotenv.parse('K="quoted"\n').K).toBe("quoted");
  });
});
