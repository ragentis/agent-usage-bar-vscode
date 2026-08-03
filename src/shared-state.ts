import {
  isRecord,
  MAX_RETRY_WAIT_MS,
  validLabel,
  validUsedPercent,
  type ProviderId,
  type ProviderView,
  type SnapshotSource,
  type UsageSnapshot,
  type UsageWindow,
  type WindowKind,
} from "./usage";

/** The version rides in the key, so a differing shape is simply not found rather than misread. */
const KEY_PREFIX = "sharedUsage.v1.";

/**
 * The slice of `vscode.Memento` this needs, named here rather than imported: the rules below are
 * worth testing, and a store the test can stand up is all they ever ask for.
 */
export interface SharedStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** What one window last learned about a provider, and when it set out to learn it. */
export interface SharedEntry {
  /** When the read was started, not when it answered: the lease every window measures against. */
  readAt: number;
  /**
   * When the result was written. What the other windows compare against, rather than the age of
   * the reading inside it: "not signed in" carries no reading at all, and is still news.
   */
  publishedAt: number;
  /** Which window read last. Only ever compared for equality against our own id. */
  owner: string;
  retryAt: Date | null;
  view: ProviderView;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A wait reaching further ahead than this extension will ever sit out is not a wait it recognizes,
 * so it is dropped like any other unreadable field rather than honoured. Every version that writes
 * one caps it first; this is the guard for the stretch of an update where the other window is a
 * version this one has never seen, and it matters because an unbounded wait here is one no window
 * can outlive — each would keep renewing it from the entry for as long as the entry stands.
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
  return { kind, usedPercent, resetsAt: resetsAt === null ? null : new Date(resetsAt) };
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
  return windows.length === 0
    ? null
    : {
        windows,
        plan: validLabel(value.plan),
        blocked: validLabel(value.blocked),
        credits: validLabel(value.credits),
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
    view: { snapshot: parseSnapshot(value.snapshot), message: validLabel(value.message) },
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
    snapshot: snapshot && {
      windows: snapshot.windows.map((window) => ({
        kind: window.kind,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt?.getTime() ?? null,
      })),
      plan: snapshot.plan,
      blocked: snapshot.blocked,
      credits: snapshot.credits,
      fetchedAt: snapshot.fetchedAt.getTime(),
      source: snapshot.source,
    },
  };
}

/**
 * The last reading, shared by every window of this profile. VS Code keeps each extension host's
 * copy of global state current when another window writes a key it has read, which makes this both
 * the place the numbers travel and the lease deciding who reads: an entry is a statement that some
 * window set out to read at that moment, so the others need not.
 *
 * Nothing read back is trusted. During an update two windows briefly run different versions, and
 * the stored shape is whatever the other one wrote; anything unrecognized is dropped rather than
 * shown. Dates cross as epoch milliseconds, because a `Date` does not survive the round trip.
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

  /** Moves the lease without disturbing the reading, for a read that never reached publishing. */
  rewind(provider: ProviderId, readAt: number): PromiseLike<void> {
    return this.write(provider, { readAt });
  }

  /**
   * Every write is a change to part of an entry, so each states only the part it changes and the
   * rest carries over. What is left is what an absent entry starts as, which matters for exactly
   * one field: a `readAt` of now, because an entry claiming to have been read at the beginning of
   * time is one every window reads over at once.
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
