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

let callbackPromise;
export function initializeAuthCallback({
  location = globalThis.location,
  history = globalThis.history,
  getClient = getSupabase,
} = {}) {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const errorKeys = ["error", "error_code", "error_description"];
  const hashCallback = ["access_token", "refresh_token", ...errorKeys].some(
    (key) => hash.has(key),
  );
  const isCallback =
    url.searchParams.has("code") ||
    hashCallback ||
    errorKeys.some((key) => url.searchParams.has(key));
  if (!isCallback) return getClient();
  if (callbackPromise) return callbackPromise;
  callbackPromise = (async () => {
    let timer;
    try {
      if (errorKeys.some((key) => url.searchParams.has(key) || hash.has(key))) {
        throw Object.assign(new Error("callback rejected"), {
          code: "otp_expired",
        });
      }
      const client = await getClient();
      let request;
      if (url.searchParams.has("code")) {
        const code = url.searchParams.get("code");
        if (!code) throw new Error("missing callback code");
        request = client.auth.exchangeCodeForSession(code);
      } else {
        const access_token = hash.get("access_token");
        const refresh_token = hash.get("refresh_token");
        if (!access_token || !refresh_token)
          throw new Error("incomplete callback tokens");
        request = client.auth.setSession({ access_token, refresh_token });
      }
      const { data, error } = await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("callback timeout")),
            25000,
          );
        }),
      ]);
      if (error) throw error;
      if (!data?.session?.user?.id) throw new Error("callback has no session");
      return client;
    } catch {
      throw Object.assign(new Error("登录未完成，请重新发送登录邮件"), {
        code: "AUTH_CALLBACK_FAILED",
      });
    } finally {
      clearTimeout(timer);
      url.searchParams.delete("code");
      for (const key of errorKeys) url.searchParams.delete(key);
      if (hashCallback) url.hash = "";
      try {
        history.replaceState(
          history.state,
          "",
          url.pathname + url.search + url.hash,
        );
      } catch {
        // Embedded browsers can restrict history writes; never prevent rendering.
      }
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
