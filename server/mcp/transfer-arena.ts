import { ApiError } from "./transport.js";
const MiB = 1024 * 1024;
export const TRANSFER_OWNED_LIMIT = 80 * MiB;
export const TRANSFER_AUTH_SCRATCH = 6 * MiB;
export class TransferLane {
  private active: string | undefined;
  private waiter:
    | {
        id: string;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        signal: AbortSignal;
        abort: () => void;
      }
    | undefined;
  stats() {
    return {
      active: this.active !== undefined,
      waiting: this.waiter !== undefined,
    };
  }
  acquire(id: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.active) {
      this.active = id;
      return Promise.resolve(this.release(id));
    }
    if (this.waiter)
      throw new ApiError(
        429,
        "TRANSFER_BUSY",
        "전송 작업이 사용 중입니다. 현재 작업을 먼저 확인하세요.",
      );
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.waiter?.id === id) {
          this.waiter = undefined;
          reject(
            new ApiError(
              410,
              "TRANSFER_CANCELED",
              "전송 대기가 취소되었습니다.",
            ),
          );
        }
      };
      this.waiter = { id, resolve, reject, signal, abort };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private release(id: string) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active !== id) return;
      this.active = undefined;
      const next = this.waiter;
      this.waiter = undefined;
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted)
          next.reject(
            new ApiError(
              410,
              "TRANSFER_CANCELED",
              "전송 대기가 취소되었습니다.",
            ),
          );
        else {
          this.active = next.id;
          next.resolve(this.release(next.id));
        }
      }
    };
  }
}
/** Process-wide mechanical budget; private managers retain all actor/handle data. */
export class TransferArena {
  private handles = 0;
  private reserved = 0;
  private owned = 2 * MiB;
  private highWater = 2 * MiB;
  private receipts = 0;
  readonly finalize = new TransferLane();
  readonly acquireDownload = new TransferLane();
  constructor(
    private readonly observe?: (
      stats: ReturnType<TransferArena["stats"]>,
    ) => void,
  ) {}
  stats() {
    return {
      liveHandles: this.handles,
      reservedRawBytes: this.reserved,
      ownedAllocationBytes: this.owned,
      ownedHighWaterBytes: this.highWater,
      completedReceipts: this.receipts,
      finalizeWaiting: this.finalize.stats().waiting,
      downloadWaiting: this.acquireDownload.stats().waiting,
    };
  }
  private changed() {
    this.highWater = Math.max(this.highWater, this.owned);
    this.observe?.(this.stats());
  }
  handle(size: number) {
    if (this.handles >= 2 || this.reserved + size > 40 * MiB)
      throw new ApiError(
        429,
        "TRANSFER_CAPACITY",
        "파일 전송은 한 번에 두 개까지 처리합니다. 기존 전송을 먼저 완료하거나 취소하세요.",
      );
    this.handles++;
    this.reserved += size;
    this.changed();
    let done = false,
      current = size;
    return {
      resize: (size: number) => {
        if (
          done ||
          size < 0 ||
          size > 20 * MiB ||
          this.reserved - current + size > 40 * MiB
        )
          throw new ApiError(
            429,
            "TRANSFER_CAPACITY",
            "파일 전송 용량이 사용 중입니다.",
          );
        this.reserved += size - current;
        current = size;
        this.changed();
      },
      release: () => {
        if (done) return;
        done = true;
        this.handles--;
        this.reserved -= current;
        this.changed();
      },
    };
  }
  allocation(bytes: number) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.owned + bytes > TRANSFER_OWNED_LIMIT
    )
      throw new ApiError(
        429,
        "TRANSFER_MEMORY_BUSY",
        "파일 전송 메모리가 사용 중입니다. 기존 작업을 먼저 확인하세요.",
      );
    this.owned += bytes;
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.owned -= bytes;
      this.changed();
    };
  }
  receipt() {
    if (this.receipts >= 32) return undefined;
    this.receipts++;
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.receipts--;
      this.changed();
    };
  }
}
export const processTransferArena = new TransferArena();
