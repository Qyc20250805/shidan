// Synchronizes the complete existing workspace without changing its domain fields.
// Local caches are account-scoped; the anonymous "current" record is never removed.
const clone = (value) => structuredClone(value);
export const hasWorkspaceData = (value) =>
  ["rows", "batches", "orders", "bills", "customers"].some(
    (key) => Array.isArray(value?.[key]) && value[key].length > 0,
  );

export function validateWorkspace(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.batches) ||
    !value.settings ||
    value.rows.length > 2000 ||
    !Number.isFinite(value.settings.rate) ||
    value.settings.rate <= 0 ||
    !Number.isFinite(value.settings.discount) ||
    value.settings.discount <= 0 ||
    value.settings.discount > 1 ||
    typeof value.settings.merchant !== "string"
  ) {
    throw new Error("云端工作台格式不兼容，已保留本地数据");
  }
  const ids = new Set();
  for (const row of value.rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      ids.has(row.id) ||
      !Number.isInteger(row.quantity) ||
      row.quantity < 1 ||
      !["draft", "handoff", "ordered"].includes(row.status) ||
      !["customer", "name", "sku", "size", "color", "url"].every(
        (key) => typeof row[key] === "string",
      )
    ) {
      throw new Error("云端明细格式无效，已保留本地数据");
    }
    ids.add(row.id);
  }
  return clone(value);
}

export class WorkspaceSync {
  constructor({
    userId,
    api,
    storage,
    empty,
    onSnapshot,
    onStatus,
    canApply = () => true,
  }) {
    Object.assign(this, {
      userId,
      api,
      storage,
      empty,
      onSnapshot,
      onStatus,
      canApply,
    });
    this.key = `cloud-workspace:${userId}`;
    this.queue = Promise.resolve();
    this.generation = 0;
    this.ready = false;
    this.disposed = false;
    this.problem = null;
    this.entry = null;
    this.status = "正在读取云端…";
  }

  report(message) {
    this.status = message;
    if (!this.disposed) this.onStatus(message);
  }

  enqueue(fn) {
    const task = this.queue.then(() => (this.disposed ? undefined : fn()));
    this.queue = task.catch((error) => {
      this.report(error.message || "同步失败，本地数据已保留");
    });
    return task;
  }

  async store() {
    await this.storage.put(this.key, clone(this.entry));
  }

  async init(guest) {
    this.guest = clone(guest);
    return this.enqueue(async () => {
      const saved = await this.storage.get(this.key);
      this.entry = saved || {
        snapshot: clone(this.empty),
        baseRevision: null,
        dirty: false,
        migrationChecked: !hasWorkspaceData(guest),
      };
      validateWorkspace(this.entry.snapshot);
      if (this.disposed) return;
      this.onSnapshot(clone(this.entry.snapshot));
      this.ready = Boolean(saved?.migrationChecked);
      await this.refreshInner(true);
    });
  }

  async refreshInner(force = false) {
    if (this.disposed || this.problem === "conflict") return;
    if (globalThis.navigator?.onLine === false) {
      this.report("当前离线 · 已保存本地，联网后同步");
      return;
    }
    if (!force && !this.entry.dirty && !this.canApply()) return;
    const generation = this.generation;
    const remote = await this.api.read(this.userId);
    if (this.disposed) return;
    if (remote) {
      validateWorkspace(remote.payload);
      if (!Number.isSafeInteger(remote.revision) || remote.revision < 1) {
        throw new Error("云端版本无效，已保留本地数据");
      }
    }
    this.remote = remote;
    if (!this.entry.migrationChecked) {
      this.problem = "migration";
      this.report("请确认本地数据迁移 · 点击处理");
      return;
    }
    this.ready = true;
    if (this.entry.dirty) {
      // An earlier write may have succeeded although its response was lost.
      if (remote && same(remote.payload, this.entry.snapshot)) {
        this.entry.baseRevision = remote.revision;
        this.entry.dirty = false;
        await this.store();
      } else if ((remote?.revision ?? null) !== this.entry.baseRevision) {
        this.problem = "conflict";
        this.report("云端有其他修改 · 本地已保留，点击处理");
        return;
      } else {
        await this.push();
        return;
      }
    } else if ((remote?.revision ?? null) !== this.entry.baseRevision) {
      // Do not replace fields or dialogs while the user is entering a value.
      if (generation !== this.generation || (!force && !this.canApply())) {
        this.report("云端有更新 · 完成当前编辑后读取");
        return;
      }
      if (!remote) {
        this.problem = "conflict";
        this.report("云端记录已变化 · 本地已保留，点击处理");
        return;
      }
      this.entry.snapshot = validateWorkspace(remote.payload);
      this.entry.baseRevision = remote.revision;
      await this.store();
      if (!this.disposed) this.onSnapshot(clone(this.entry.snapshot));
    } else {
      await this.store();
    }
    this.problem = null;
    this.report(remote ? "已同步云端" : "已登录 · 修改后同步云端");
  }

  refresh(force = false) {
    return this.enqueue(() => this.refreshInner(force));
  }

  save(snapshot) {
    if (!this.ready || this.disposed)
      return Promise.reject(new Error("请先完成云端数据读取或迁移确认"));
    const value = clone(snapshot);
    this.generation++;
    return this.enqueue(async () => {
      this.entry.snapshot = value;
      this.entry.dirty = true;
      await this.store(); // Durable offline copy must precede any network write.
      this.report("已保存本地 · 等待同步");
    });
  }

  async push() {
    if (this.disposed || !this.entry.dirty || this.problem === "conflict")
      return;
    this.report("已保存本地 · 正在同步…");
    try {
      this.entry.baseRevision = await this.api.save(
        clone(this.entry.snapshot),
        this.entry.baseRevision,
        { confirmLocalMigration: true, expectedUserId: this.userId },
      );
      this.entry.dirty = false;
      await this.store();
      this.report("已同步云端");
    } catch (error) {
      if (error.code === "SYNC_CONFLICT") {
        this.problem = "conflict";
        this.report("云端有其他修改 · 本地已保留，点击处理");
      } else {
        this.report("同步未完成 · 本地已保留，点击重试");
        throw error;
      }
    }
  }

  chooseMigration(uploadLocal) {
    return this.enqueue(async () => {
      const remote = await this.api.read(this.userId);
      if (this.disposed) return;
      if (uploadLocal && remote) {
        this.remote = remote;
        this.report("云端已有数据 · 请重新确认迁移选择");
        throw new Error("云端已有数据，不会覆盖；可使用云端并保留本地原件");
      }
      this.entry = {
        snapshot: uploadLocal
          ? clone(this.guest)
          : remote
            ? validateWorkspace(remote.payload)
            : clone(this.empty),
        baseRevision: remote?.revision ?? null,
        dirty: uploadLocal,
        migrationChecked: true,
      };
      await this.store();
      this.ready = true;
      this.problem = null;
      this.onSnapshot(clone(this.entry.snapshot));
      if (uploadLocal) await this.push();
      else this.report(remote ? "已同步云端" : "已登录 · 修改后同步云端");
    });
  }

  useCloudAfterConflict() {
    return this.enqueue(async () => {
      const remote = await this.api.read(this.userId);
      if (this.disposed) return;
      if (!remote) throw new Error("云端记录不存在，请保留本地备份，稍后重试");
      const snapshot = validateWorkspace(remote.payload);
      // Keep the displaced local copy, including offline edits, for recovery.
      await this.storage.put(
        `${this.key}:before-conflict:${Date.now()}`,
        clone(this.entry),
      );
      this.entry = {
        snapshot,
        baseRevision: remote.revision,
        dirty: false,
        migrationChecked: true,
      };
      await this.store();
      this.problem = null;
      this.ready = true;
      this.onSnapshot(clone(snapshot));
      this.report("已读取云端 · 原本地数据已备份");
    });
  }

  dispose() {
    this.disposed = true;
  }
}

function same(a, b) {
  // jsonb canonicalizes object key order. Compare data, not serialization order.
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
