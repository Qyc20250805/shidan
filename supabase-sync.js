// Browser CDN adapter. Account ownership is also enforced by Supabase RLS.
// Before enabling sync, create shidan_workspaces with user_id (UUID primary key),
// payload (JSONB), revision (integer), and enforce owner-only SELECT/INSERT/UPDATE
// RLS policies using auth.uid() = user_id. Do not enable without these policies.
// Existing workspace data is stored verbatim; pricing/domain rules stay unchanged.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

let clientPromise;
async function loadClientLibrary() {
  let timer;
  try {
    return await Promise.race([
      import("https://esm.sh/@supabase/supabase-js@2"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("登录服务加载超时，请联网后重试")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

export async function getSupabase() {
  if (!isSupabaseConfigured()) throw new Error("尚未配置 Supabase");
  if (!SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) {
    throw new Error("请配置 Supabase Publishable key，不能使用私钥");
  }
  const url = new URL(SUPABASE_URL);
  if (url.protocol !== "https:") throw new Error("Supabase URL 必须使用 HTTPS");
  if (!clientPromise) {
    clientPromise = loadClientLibrary()
      .then(({ createClient }) =>
        createClient(url.origin, SUPABASE_PUBLISHABLE_KEY, {
          global: {
            fetch: (url, options = {}) =>
              fetch(url, {
                ...options,
                signal: options.signal || AbortSignal.timeout(20000),
              }),
          },
          auth: {
            flowType: "implicit",
            persistSession: true,
            autoRefreshToken: true,
            // Callback consumption is explicit, before the app reads the session.
            // Avoid racing SDK auto-detection with exchangeCodeForSession.
            detectSessionInUrl: false,
          },
        }),
      )
      .catch((error) => {
        clientPromise = undefined;
        throw error;
      });
  }
  return clientPromise;
}

// Diagnostics never retain URL values or raw server messages.
const safeErrors = {
  otp_expired: "邮件链接已失效或已使用",
  access_denied: "认证请求被拒绝",
  bad_code_verifier: "此浏览器缺少匹配的登录验证信息",
  flow_state_not_found: "登录流程已失效或浏览器不匹配",
  flow_state_expired: "登录流程已过期",
  invalid_credentials: "登录凭据无效",
  bad_jwt: "登录凭据无效",
  session_not_found: "未找到登录会话",
  refresh_token_not_found: "未找到续期凭据",
  refresh_token_already_used: "续期凭据已失效",
  validation_failed: "登录参数校验失败",
  unexpected_failure: "认证服务内部错误",
  missing_callback_code: "链接缺少登录代码",
  incomplete_callback_tokens: "链接缺少完整登录凭据",
  token_hash_unsupported: "收到 token_hash，此页面尚未实现该验证方式",
  callback_timeout: "建立登录会话超时",
  callback_has_no_session: "认证未返回有效登录会话",
};
export function safeAuthError(error) {
  const code = Object.hasOwn(safeErrors, error?.code) ? error.code :
    error?.name === "AbortError" || error?.name === "TimeoutError" ? "network_timeout" :
    error?.name === "AuthRetryableFetchError" || error?.name === "TypeError" ? "network_error" : "auth_error";
  return { code, message: safeErrors[code] || ({network_timeout:"认证请求超时",network_error:"认证服务或脚本无法连接",auth_error:"认证失败，原始信息已隐藏以保护登录凭据"})[code] };
}
export function authReturnType(location = globalThis.location) {
  const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1));
  if (url.searchParams.has("code")) return "code";
  if (url.searchParams.has("token_hash") || hash.has("token_hash")) return "token_hash";
  if (hash.has("access_token") || hash.has("refresh_token")) return "access_token（implicit）";
  return "无登录参数";
}
let callbackPromise;
export function initializeAuthCallback({
  location = globalThis.location,
  getClient = getSupabase,
  onDiagnostic = () => {},
} = {}) {
  onDiagnostic("解析链接");
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const errorKeys = ["error", "error_code", "error_description"];
  const type = authReturnType(location);
  const isCallback = type !== "无登录参数" || errorKeys.some(key => url.searchParams.has(key) || hash.has(key));
  if (!isCallback) return getClient();
  if (callbackPromise) return callbackPromise;
  callbackPromise = (async () => {
    let timer;
    try {
      if (errorKeys.some(key => url.searchParams.has(key) || hash.has(key))) {
        const code = url.searchParams.get("error_code") || hash.get("error_code") || url.searchParams.get("error") || hash.get("error");
        throw { code };
      }
      if (type === "token_hash") throw { code: "token_hash_unsupported" };
      const client = await getClient();
      onDiagnostic("交换 session");
      let request;
      if (type === "code") {
        const code = url.searchParams.get("code");
        if (!code) throw { code: "missing_callback_code" };
        request = client.auth.exchangeCodeForSession(code);
      } else {
        const access_token = hash.get("access_token"), refresh_token = hash.get("refresh_token");
        if (!access_token || !refresh_token) throw { code: "incomplete_callback_tokens" };
        request = client.auth.setSession({ access_token, refresh_token });
      }
      const { data, error } = await Promise.race([
        request,
        new Promise((_, reject) => { timer = setTimeout(() => reject({ code: "callback_timeout" }), 25000); }),
      ]);
      if (error) throw error;
      if (!data?.session?.user?.id) throw { code: "callback_has_no_session" };
      return client;
    } catch (error) {
      const diagnostic = safeAuthError(error);
      throw Object.assign(new Error(diagnostic.message), { code: "AUTH_CALLBACK_FAILED", diagnostic });
    } finally {
      clearTimeout(timer);
      // The application cleans callback parameters only after session reading finishes.
    }
  })();
  return callbackPromise;
}

// Email template must include {{ .Token }} to use the code-entry flow.
export async function sendEmailCode(email) {
  const client = await getSupabase();
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: new URL("./", import.meta.url).href },
  });
  if (error) throw error;
}

export async function verifyEmailCode(email, token) {
  const client = await getSupabase();
  const { data, error } = await client.auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: "email",
  });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const client = await getSupabase();
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
}

async function authenticatedClient(expectedUserId) {
  if (globalThis.navigator?.onLine === false) {
    throw new Error("当前离线，本地数据尚未同步");
  }
  const client = await getSupabase();
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("请先登录邮箱账号");
  if (expectedUserId && data.user.id !== expectedUserId) {
    throw new Error("账号已切换，请重新读取当前账号的数据");
  }
  return { client, userId: data.user.id };
}

export async function readCloudWorkspace(expectedUserId) {
  const { client, userId } = await authenticatedClient(expectedUserId);
  const { data, error } = await client
    .from("shidan_workspaces")
    .select("payload,revision")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// expectedRevision comes from readCloudWorkspace; null means no cloud record.
// First local migration requires explicit confirmation by the caller.
export async function saveCloudWorkspace(
  payload,
  expectedRevision,
  options = {},
) {
  if (expectedRevision === null && options.confirmLocalMigration !== true) {
    throw new Error("请先确认是否迁移本地数据到当前账号");
  }
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  ) {
    throw new Error("云端版本无效，请重新读取");
  }
  const { client, userId } = await authenticatedClient(options.expectedUserId);
  const table = client.from("shidan_workspaces");
  const revision = expectedRevision === null ? 1 : expectedRevision + 1;
  const request =
    expectedRevision === null
      ? table.insert({ user_id: userId, payload, revision })
      : table
          .update({ payload, revision })
          .eq("user_id", userId)
          .eq("revision", expectedRevision);
  const { data, error } = await request.select("revision").maybeSingle();
  if (error?.code === "23505" || (!error && !data)) {
    const conflict = new Error(
      "云端数据已变化，请保留本地数据并重新核对后同步",
    );
    conflict.code = "SYNC_CONFLICT";
    throw conflict;
  }
  if (error) throw error;
  return data.revision;
}
