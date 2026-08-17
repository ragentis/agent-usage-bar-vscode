import {
  isRecord,
  MAX_RETRY_WAIT_MS,
  validLabel,
  validMessage,
  validUsedPercent,
  validWindowMinutes,
  type ProviderId,
  type ProviderView,
  type SnapshotSource,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";

/**
 * The version lives in the key so incompatible shapes are ignored instead of misread. Bump it when
 * a field is renamed or changes unit or meaning, but not for an optional additive field. During a
 * version transition each shape uses its own lease, so unnecessary bumps briefly duplicate reads.
 * Wire-format tests make compatible changes explicit.
 */
const KEY_PREFIX = "sharedUsage.v1.";

export interface SharedStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SharedEntry {
  /** When the read was started, not when it answered: the lease every window measures against. */
  readAt: number;
  /**
   * When the result was written. What the other windows compare against, rather than the age of
   * the reading inside it: "not signed in" carries no reading at all, and is still news.
   */
  publishedAt: number;
  owner: string;
  retryAt: Date | null;
  view: ProviderView;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reject waits beyond this version's cap. A newer or malformed entry must not renew an unbounded
 * delay in every window.
 */
function retryMillis(value: unknown): number | null {
  const retryAt = millis(value);
  return retryAt !== null && retryAt <= Date.now() + MAX_RETRY_WAIT_MS ? retryAt : null;
}

function windowKind(value: unknown): WindowKind | null {
  return value === "session" || value === "weekly" ? value : null;
}

function snapshotSource(value: unknown): SnapshotSource | null {
  return value === "claude-account-api" || value === "codex-app-server" ? value : null;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = windowKind(value.kind);
  const usedPercent = validUsedPercent(value.usedPercent);
  if (!kind || usedPercent === null) {
    return null;
  }
  const resetsAt = millis(value.resetsAt);
  return {
    kind,
    usedPercent,
    resetsAt: resetsAt === null ? null : new Date(resetsAt),
    windowMinutes: validWindowMinutes(value.windowMinutes),
    label: validLabel(value.label),
  };
}

function parseSnapshot(value: unknown): UsageSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.windows)) {
    return null;
  }
  const fetchedAt = millis(value.fetchedAt);
  const source = snapshotSource(value.source);
  if (fetchedAt === null || !source) {
    return null;
  }
  const windows = value.windows.map(parseWindow).filter((window) => window !== null);
  const creditsExpireAt = millis(value.creditsExpireAt);
  return windows.length === 0
    ? null
    : {
        windows,
        plan: validLabel(value.plan),
        blocked: validLabel(value.blocked),
        credits: validLabel(value.credits),
        creditsExpireAt: creditsExpireAt === null ? null : new Date(creditsExpireAt),
        fetchedAt: new Date(fetchedAt),
        source,
      };
}

function parseEntry(value: unknown): SharedEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const readAt = millis(value.readAt);
  if (readAt === null) {
    return null;
  }
  const retryAt = retryMillis(value.retryAt);
  return {
    readAt,
    publishedAt: millis(value.publishedAt) ?? 0,
    owner: validLabel(value.owner) ?? "",
    retryAt: retryAt === null ? null : new Date(retryAt),
    view: {
      snapshot: parseSnapshot(value.snapshot),
      message: validMessage(value.message),
      verbatim: value.verbatim === true,
    },
  };
}

function serialize(entry: SharedEntry): Record<string, unknown> {
  const { snapshot } = entry.view;
  return {
    readAt: entry.readAt,
    publishedAt: entry.publishedAt,
    owner: entry.owner,
    retryAt: entry.retryAt?.getTime() ?? null,
    message: entry.view.message,
    verbatim: entry.view.verbatim ?? false,
    snapshot: snapshot && {
      windows: snapshot.windows.map((window) => ({
        kind: window.kind,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt?.getTime() ?? null,
        windowMinutes: window.windowMinutes ?? null,
        label: window.label ?? null,
      })),
      plan: snapshot.plan,
      blocked: snapshot.blocked,
      credits: snapshot.credits,
      creditsExpireAt: snapshot.creditsExpireAt?.getTime() ?? null,
      fetchedAt: snapshot.fetchedAt.getTime(),
      source: snapshot.source,
    },
  };
}

/**
 * Global state transports readings and the lease between extension hosts. Stored values are fully
 * validated because another window may briefly run a different version; dates cross as epoch
 * milliseconds because `Date` does not survive storage.
 */
export class SharedUsageState {
  constructor(private readonly store: SharedStore) {}

  read(provider: ProviderId): SharedEntry | null {
    return parseEntry(this.store.get(`${KEY_PREFIX}${provider}`));
  }

  /** Stamped before the read rather than after, so a slow read still holds the other windows off. */
  claim(provider: ProviderId, owner: string): PromiseLike<void> {
    return this.write(provider, { readAt: Date.now(), owner });
  }

  publish(
    provider: ProviderId,
    update: { owner: string; view: ProviderView; retryAt: Date | null },
  ): PromiseLike<void> {
    return this.write(provider, { publishedAt: Date.now(), ...update });
  }

  rewind(provider: ProviderId, readAt: number): PromiseLike<void> {
    return this.write(provider, { readAt });
  }

  /**
   * Writes preserve the rest of the entry. A missing entry starts with `readAt` now so simultaneous
   * windows do not all treat it as an ancient lease.
   */
  private write(provider: ProviderId, change: Partial<SharedEntry>): PromiseLike<void> {
    const entry: SharedEntry = {
      readAt: Date.now(),
      publishedAt: 0,
      owner: "",
      retryAt: null,
      view: { snapshot: null, message: null },
      ...this.read(provider),
      ...change,
    };
    return this.store.update(`${KEY_PREFIX}${provider}`, serialize(entry));
  }
}
