import { normalizeFileName, detectFileMime } from "../file-storage.js";
import {
  attachmentOperationLookupSchema,
  attachmentOperationStatusSchema,
} from "../contracts/file-transfers.js";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { z } from "zod";
import { ApiError, type createStickerTransport } from "./transport.js";
import {
  TransferArena,
  processTransferArena,
  TRANSFER_AUTH_SCRATCH,
} from "./transfer-arena.js";
import {
  beginUploadSchema,
  beginFileReadSchema,
  uploadChunkSchema,
  finishUploadSchema,
  fileReadChunkSchema,
  fileIdentitySchema,
  fileCommitReceiptSchema,
  attachmentFileMetadataSchema,
  MAX_TRANSFER_CHUNK_BYTES,
} from "../contracts/file-transfers.js";
import { resourceVersionSchema } from "../contracts/resources.js";
type Upload = z.infer<typeof beginUploadSchema>;
type ReadInput = z.infer<typeof beginFileReadSchema>;
type Receipt = z.infer<typeof fileCommitReceiptSchema>;
type Metadata = z.infer<typeof fileIdentitySchema>;
type Handle = {
  id: string;
  direction: "upload" | "download";
  state: string;
  created: number;
  last: number;
  identity?: string;
  upload?: Upload;
  read?: ReadInput;
  metadata?: Metadata;
  size: number;
  offset: number;
  hash: Hash;
  buffer?: Buffer<ArrayBuffer>;
  bufferRelease?: () => void;
  slot: ReturnType<TransferArena["handle"]>;
  controller: AbortController;
  active: number;
  busy: boolean;
  cancelAuth: boolean;
  invalid?: string;
  released: boolean;
  dispatched: boolean;
  projectId?: string;
  commitState: "not_dispatched" | "not_committed" | "uncertain" | "committed";
  etag?: string;
  receipt?: Receipt;
  receiptRelease?: () => void;
  finalPromise?: Promise<Receipt>;
  joiners: number;
};
const sliding = 600000,
  absolute = 1800000;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const e = encodeURIComponent;
function failure(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
function uploadAuth(input: Upload) {
  const target = input.target;
  return target.kind === "issue_attachment"
    ? `/api/issues/${e(target.issueId)}/attachments`
    : target.kind === "resource_file"
      ? `/api/projects/${e(target.projectId)}/resources/files`
      : `/api/resources/${e(target.resourceId)}/files`;
}
function filePath(input: ReadInput) {
  return input.target.kind === "attachment"
    ? `/api/attachments/${e(input.target.attachmentId)}/file`
    : `/api/resources/${e(input.target.resourceId)}/versions/${String(input.target.resourceVersion)}/file`;
}
/** Private handles; all persistent authority stays in fixed authenticated HTTP routes. */
export class TransferManager {
  private readonly handles = new Map<string, Handle>();
  private readonly completed = new Map<string, Handle>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly lifetime = new AbortController();
  private disposing: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly arena: TransferArena;
  constructor(
    private readonly transport: ReturnType<typeof createStickerTransport>,
    options: { clock?: () => number; arena?: TransferArena } = {},
  ) {
    this.now = options.clock ?? (() => performance.now());
    this.arena = options.arena ?? processTransferArena;
  }
  private deadline(h: Handle) {
    return Math.min(h.created + absolute, h.last + sliding);
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const deadlines = [...this.handles.values(), ...this.completed.values()]
      .filter((h) => !h.invalid)
      .map((h) => this.deadline(h));
    if (deadlines.length) {
      this.timer = setTimeout(
        () => {
          this.sweep();
        },
        Math.max(1, Math.min(...deadlines) - this.now()),
      );
      this.timer.unref();
    }
  }
  private sweep() {
    const now = this.now();
    for (const h of this.handles.values())
      if (!h.invalid && this.deadline(h) <= now) this.invalidate(h, "expired");
    for (const h of this.completed.values())
      if (this.deadline(h) <= now) this.dropReceipt(h);
    this.schedule();
  }
  private check(h: Handle) {
    if (this.closed || h.invalid || this.deadline(h) <= this.now()) {
      if (!h.invalid) this.invalidate(h, "expired");
      failure(410, "TRANSFER_CANCELED", "전송이 취소되었거나 만료되었습니다.");
    }
  }
  private invalidate(h: Handle, reason: string) {
    if (!h.invalid) {
      h.invalid = reason;
      h.state = reason === "expired" ? "expired" : "canceling";
      h.controller.abort();
    }
    if (h.released) this.dropReceipt(h);
    else this.release(h);
  }
  private dropReceipt(h: Handle) {
    this.completed.delete(h.id);
    h.receiptRelease?.();
    h.receiptRelease = undefined;
  }
  private release(h: Handle) {
    if (h.active || h.released || (!h.invalid && h.state !== "completed"))
      return;
    h.released = true;
    h.buffer?.fill(0);
    h.buffer = undefined;
    h.bufferRelease?.();
    h.bufferRelease = undefined;
    h.finalPromise = undefined;
    h.slot.release();
    this.handles.delete(h.id);
    if (h.receipt && !h.invalid && !this.closed) {
      const release = this.arena.receipt();
      if (release) {
        h.receiptRelease = release;
        this.completed.set(h.id, h);
      }
    }
    this.schedule();
  }
  private create(direction: Handle["direction"], size: number) {
    this.sweep();
    if (this.closed)
      failure(503, "TRANSFER_DISPOSED", "파일 전송 연결이 종료되었습니다.");
    const slot = this.arena.handle(size),
      now = this.now();
    const h: Handle = {
      id: randomUUID(),
      direction,
      state: "authorizing",
      created: now,
      last: now,
      size,
      offset: 0,
      hash: createHash("sha256"),
      slot,
      controller: new AbortController(),
      active: 0,
      busy: false,
      cancelAuth: false,
      released: false,
      dispatched: false,
      commitState: "not_dispatched",
      joiners: 0,
    };
    this.handles.set(h.id, h);
    this.schedule();
    return h;
  }
  private find(
    id: string,
    direction: Handle["direction"],
    includeCompleted = false,
  ) {
    this.sweep();
    if (this.closed)
      failure(503, "TRANSFER_DISPOSED", "파일 전송 연결이 종료되었습니다.");
    const h =
      this.handles.get(id) ??
      (includeCompleted ? this.completed.get(id) : undefined);
    if (!h || h.direction !== direction)
      failure(404, "TRANSFER_NOT_FOUND", "전송을 찾을 수 없습니다.");
    return h;
  }
  private track<T>(
    h: Handle,
    run: () => Promise<T>,
    exclusive = true,
  ): Promise<T> {
    if (exclusive && h.busy)
      failure(429, "TRANSFER_BUSY", "이 전송의 작업이 진행 중입니다.");
    if (exclusive) h.busy = true;
    h.active++;
    const promise = (async () => {
      try {
        return await run();
      } finally {
        h.active--;
        if (exclusive) h.busy = false;
        this.release(h);
      }
    })();
    this.pending.add(promise);
    void promise.then(
      () => {
        this.pending.delete(promise);
      },
      () => {
        this.pending.delete(promise);
      },
    );
    return promise;
  }
  private touch(h: Handle) {
    h.last = this.now();
    this.schedule();
  }
  private async authenticate(h: Handle, target = true, allowInvalid = false) {
    const release = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
    try {
      const actor = await this.transport.verifiedActor({
        signal: allowInvalid ? undefined : h.controller.signal,
      });
      if (!allowInvalid) this.check(h);
      const identity = `${this.transport.mode}:${actor.role}:${actor.id}`;
      if (h.identity && h.identity !== identity) {
        this.invalidate(h, "revoked");
        failure(
          401,
          "TRANSFER_IDENTITY_CHANGED",
          "전송을 시작한 인증 주체가 아닙니다.",
        );
      }
      h.identity = identity;
      if (target) {
        const path = h.upload
          ? uploadAuth(h.upload)
          : h.read
            ? filePath(h.read)
            : failure(400, "TRANSFER_TARGET", "전송 대상을 확인하세요.");
        const response = await this.transport.request(path, "HEAD", undefined, {
          signal: h.controller.signal,
        });
        this.check(h);
        if (h.upload && response.status !== 204)
          failure(
            502,
            "api_response_invalid",
            "파일 쓰기 권한 응답을 확인하지 못했습니다.",
          );
        if (h.upload) {
          const header = response.headers.get("x-sticker-project-id");
          let project: string;
          try {
            if (!header || header.length > 1024) throw new Error();
            project = decodeURIComponent(header);
            if (!project.length || project.length > 128) throw new Error();
          } catch {
            failure(
              502,
              "api_response_invalid",
              "파일 프로젝트 응답을 확인하지 못했습니다.",
            );
          }
          if (h.projectId && h.projectId !== project) {
            this.invalidate(h, "changed");
            failure(
              409,
              "TRANSFER_TARGET_CHANGED",
              "전송 대상 프로젝트가 변경되었습니다.",
            );
          }
          h.projectId = project;
        }
        if (h.read) {
          const length = response.headers.get("content-length"),
            etag = response.headers.get("etag");
          if (
            h.metadata &&
            length !== null &&
            (!/^\d+$/.test(length) || Number(length) !== h.size)
          ) {
            this.invalidate(h, "changed");
            failure(409, "FILE_CHANGED", "파일 크기가 변경되었습니다.");
          }
          if (h.etag && etag !== h.etag) {
            this.invalidate(h, "changed");
            failure(409, "FILE_CHANGED", "파일이 변경되었습니다.");
          }
          if (etag) h.etag = etag;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status))
        this.invalidate(h, "revoked");
      throw error;
    } finally {
      release();
    }
  }
  async beginUpload(raw: unknown) {
    const input = beginUploadSchema.parse(raw),
      h = this.create("upload", input.size);
    h.upload = input;
    return this.track(h, async () => {
      try {
        await this.authenticate(h);
        this.check(h);
        const release = this.arena.allocation(h.size);
        try {
          h.buffer = Buffer.alloc(h.size);
          h.bufferRelease = release;
        } catch (error) {
          release();
          throw error;
        }
        h.state = "receiving";
        this.touch(h);
        return {
          handle: h.id,
          offset: 0,
          size: h.size,
          chunkBytes: MAX_TRANSFER_CHUNK_BYTES,
        };
      } catch (error) {
        this.invalidate(h, "failed");
        throw error;
      }
    });
  }
  async writeChunk(raw: unknown) {
    const input = uploadChunkSchema.parse(raw),
      h = this.find(input.handle, "upload");
    return this.track(h, async () => {
      await this.authenticate(h);
      this.check(h);
      if (h.state !== "receiving" || !h.buffer)
        failure(
          409,
          "TRANSFER_STATE",
          "현재 전송 상태에서는 청크를 추가할 수 없습니다.",
        );
      const padding = input.base64.endsWith("==")
        ? 2
        : input.base64.endsWith("=")
          ? 1
          : 0;
      const decodedLength = (input.base64.length / 4) * 3 - padding;
      if (
        !input.base64.length ||
        input.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64) ||
        decodedLength < 1 ||
        decodedLength > MAX_TRANSFER_CHUNK_BYTES
      )
        failure(
          400,
          "TRANSFER_CHUNK_INVALID",
          "청크의 인코딩과 크기를 확인하세요.",
        );
      const release = this.arena.allocation(MAX_TRANSFER_CHUNK_BYTES);
      try {
        const bytes = Buffer.from(input.base64, "base64");
        if (
          !bytes.length ||
          bytes.length > MAX_TRANSFER_CHUNK_BYTES ||
          bytes.toString("base64") !== input.base64 ||
          sha(bytes) !== input.checksum
        )
          failure(
            400,
            "TRANSFER_CHUNK_INVALID",
            "청크의 인코딩·크기·체크섬을 확인하세요.",
          );
        if (input.offset < h.offset) {
          if (
            input.offset + bytes.length > h.offset ||
            !h.buffer
              .subarray(input.offset, input.offset + bytes.length)
              .equals(bytes)
          )
            failure(
              409,
              "TRANSFER_CHUNK_CONFLICT",
              "같은 위치의 청크 내용이 다릅니다.",
            );
          return { handle: h.id, offset: h.offset, size: h.size };
        }
        if (input.offset !== h.offset || bytes.length > h.size - h.offset)
          failure(
            409,
            "TRANSFER_OFFSET",
            "다음 전송 위치 또는 전체 크기를 확인하세요.",
          );
        h.buffer.set(bytes, h.offset);
        h.hash.update(bytes);
        h.offset += bytes.length;
        this.touch(h);
        return { handle: h.id, offset: h.offset, size: h.size };
      } finally {
        release();
      }
    });
  }
  async finishUpload(raw: unknown): Promise<Receipt> {
    const input = finishUploadSchema.parse(raw),
      h = this.find(input.handle, "upload", true),
      upload = h.upload;
    if (!upload) failure(400, "TRANSFER_TARGET", "업로드 대상을 확인하세요.");
    if (
      input.operationId !== upload.operationId ||
      input.checksum !== upload.checksum
    )
      failure(
        409,
        "TRANSFER_INPUT_CONFLICT",
        "처음 지정한 작업 식별자와 체크섬을 유지하세요.",
      );
    if (h.state === "completed" && h.receipt) {
      const receipt = h.receipt;
      return this.track(h, async () => {
        await this.authenticate(h);
        this.check(h);
        const release = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
        try {
          const target =
            receipt.kind === "attachment"
              ? {
                  target: {
                    kind: "attachment" as const,
                    attachmentId: receipt.attachmentId,
                  },
                }
              : {
                  target: {
                    kind: "resource" as const,
                    resourceId: receipt.resourceId,
                    resourceVersion: receipt.resourceVersion,
                  },
                };
          let currentPresent = false;
          try {
            const response = await this.transport.request(
              filePath(target),
              "HEAD",
              undefined,
              { signal: h.controller.signal },
            );
            if (response.status !== 200)
              failure(
                502,
                "api_response_invalid",
                "현재 파일 상태 응답을 확인하지 못했습니다.",
              );
            currentPresent = true;
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) {
              if (
                error instanceof ApiError &&
                [401, 403].includes(error.status)
              )
                this.invalidate(h, "revoked");
              throw error;
            }
          }
          this.check(h);
          return { ...receipt, currentPresent };
        } finally {
          release();
        }
      });
    }
    if (h.busy && h.finalPromise) {
      if (h.joiners >= 1)
        failure(
          429,
          "TRANSFER_BUSY",
          "완료 결과를 기다리는 호출이 이미 있습니다.",
        );
      h.joiners++;
      try {
        return await this.track(
          h,
          async () => {
            await this.authenticate(h);
            const result = await h.finalPromise;
            this.check(h);
            if (!result)
              failure(
                502,
                "TRANSFER_RESULT",
                "전송 결과를 확인하지 못했습니다.",
              );
            return result;
          },
          false,
        );
      } finally {
        h.joiners--;
      }
    }
    if (h.busy || h.joiners)
      failure(429, "TRANSFER_BUSY", "이 전송의 작업이 진행 중입니다.");
    const promise = this.track(h, async () => {
      await this.authenticate(h);
      this.check(h);
      if (!h.buffer || h.offset !== h.size)
        failure(
          409,
          "TRANSFER_INCOMPLETE",
          "모든 파일 청크를 먼저 전송하세요.",
        );
      if (h.hash.copy().digest("hex") !== upload.checksum) {
        this.invalidate(h, "hash_mismatch");
        failure(400, "TRANSFER_HASH_MISMATCH", "전체 파일 체크섬이 다릅니다.");
      }
      const previousCommit = h.commitState;
      h.state = "finalizing";
      const releaseLane = await this.arena.finalize.acquire(
        h.id,
        h.controller.signal,
      );
      let releaseBlob: (() => void) | undefined,
        releaseJson: (() => void) | undefined;
      try {
        this.check(h);
        await this.authenticate(h);
        this.check(h);
        releaseBlob = this.arena.allocation(h.size);
        const blob = new Blob([h.buffer]);
        const form = new FormData();
        form.append("file", blob, upload.name);
        const target = upload.target;
        if (target.kind === "issue_attachment")
          form.append("operationId", upload.operationId);
        else
          form.append(
            "metadata",
            JSON.stringify(
              target.kind === "resource_file"
                ? {
                    title: target.title,
                    versionId: target.versionId,
                    operationId: upload.operationId,
                  }
                : {
                    revision: target.revision,
                    title: target.title,
                    versionId: target.versionId,
                    operationId: upload.operationId,
                  },
            ),
          );
        releaseJson = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
        const receipt = fileCommitReceiptSchema
          .refine(
            (value) =>
              value.operationId === upload.operationId &&
              value.checksum === upload.checksum &&
              value.size === upload.size &&
              value.projectId === h.projectId &&
              value.name === normalizeFileName(upload.name) &&
              value.mimeType === detectFileMime(h.buffer ?? Buffer.alloc(0)) &&
              (target.kind === "issue_attachment"
                ? value.kind === "attachment" &&
                  value.issueId === target.issueId
                : target.kind === "resource_file"
                  ? value.kind === "resource" &&
                    value.projectId === target.projectId &&
                    value.resourceVersion === 1 &&
                    value.revision === 1
                  : value.kind === "resource" &&
                    value.resourceId === target.resourceId &&
                    value.revision === target.revision + 1),
            "File receipt differs from pinned operation",
          )
          .parse(
            await this.transport.json(
              `${uploadAuth(upload)}?receipt=1`,
              "POST",
              form,
              {
                signal: h.controller.signal,
                jsonLimit: 8192,
                trackFormData: true,
                onDispatch: () => {
                  this.check(h);
                  h.dispatched = true;
                  h.commitState = "uncertain";
                },
              },
            ),
          );
        h.commitState = "committed";
        this.check(h);
        h.receipt = receipt;
        h.state = "completed";
        this.touch(h);
        return receipt;
      } catch (error) {
        if (
          error instanceof ApiError &&
          ((error.status >= 400 &&
            error.status < 500 &&
            error.code !== "TRANSFER_CANCELED") ||
            error.code === "MAINTENANCE")
        )
          h.commitState =
            previousCommit === "uncertain" ? "uncertain" : "not_committed";
        if (!h.invalid)
          h.state = h.commitState === "uncertain" ? "uncertain" : "receiving";
        throw error;
      } finally {
        releaseJson?.();
        releaseBlob?.();
        releaseLane();
      }
    });
    h.finalPromise = promise;
    return promise;
  }
  async beginRead(raw: unknown) {
    const input = beginFileReadSchema.parse(raw),
      h = this.create("download", 0);
    h.read = input;
    return this.track(h, async () => {
      try {
        await this.authenticate(h);
        const release = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
        try {
          if (input.target.kind === "attachment") {
            const metadata = attachmentFileMetadataSchema.parse(
              await this.transport.json(
                `/api/attachments/${e(input.target.attachmentId)}/metadata`,
                "GET",
                undefined,
                { signal: h.controller.signal, jsonLimit: 8192 },
              ),
            );
            h.metadata = fileIdentitySchema.parse({
              name: metadata.name,
              mimeType: metadata.mimeType,
              size: metadata.size,
              checksum: metadata.checksum,
            });
          } else {
            const version = resourceVersionSchema.parse(
              await this.transport.json(
                `/api/resources/${e(input.target.resourceId)}/versions/${String(input.target.resourceVersion)}`,
                "GET",
                undefined,
                { signal: h.controller.signal, jsonLimit: 8192 },
              ),
            );
            if (version.kind !== "file")
              failure(400, "RESOURCE_KIND", "파일 자료가 아닙니다.");
            h.metadata = fileIdentitySchema.parse({
              name: version.fileName,
              mimeType: version.mimeType,
              size: version.size,
              checksum: version.checksum,
            });
          }
          this.check(h);
          h.size = h.metadata.size;
          h.slot.resize(h.size);
        } finally {
          release();
        }
        await this.authenticate(h);
        this.check(h);
        h.state = "reading";
        this.touch(h);
        return {
          handle: h.id,
          ...h.metadata,
          chunkBytes: MAX_TRANSFER_CHUNK_BYTES,
        };
      } catch (error) {
        this.invalidate(h, "failed");
        throw error;
      }
    });
  }
  private async body(
    response: Response,
    buffer: Buffer<ArrayBuffer>,
    expected: number,
    h: Handle,
  ) {
    const reader = response.body?.getReader();
    let size = 0,
      done = false;
    try {
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          this.check(h);
          if (chunk.done) {
            done = true;
            break;
          }
          if (chunk.value.byteLength > expected - size)
            failure(502, "FILE_LENGTH_INVALID", "파일 응답 크기가 다릅니다.");
          buffer.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      if (size !== expected)
        failure(
          502,
          "FILE_LENGTH_INVALID",
          "파일 응답이 예상 크기보다 짧습니다.",
        );
      return buffer;
    } finally {
      if (reader) {
        if (!done) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  private validateResponse(response: Response, expected: number) {
    if (
      response.headers.get("content-encoding") &&
      response.headers.get("content-encoding") !== "identity"
    )
      failure(
        502,
        "FILE_ENCODING_INVALID",
        "변환된 파일 응답은 사용할 수 없습니다.",
      );
    if (
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("multipart/")
    )
      failure(
        502,
        "FILE_RANGE_INVALID",
        "여러 범위 파일 응답은 사용할 수 없습니다.",
      );
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        Number(length) !== expected)
    )
      failure(502, "FILE_LENGTH_INVALID", "파일 응답 길이가 다릅니다.");
  }
  async readChunk(raw: unknown) {
    const input = fileReadChunkSchema.parse(raw),
      h = this.find(input.handle, "download");
    return this.track(h, async () => {
      await this.authenticate(h);
      this.check(h);
      if (!h.read || !h.metadata)
        failure(400, "TRANSFER_TARGET", "파일 읽기 대상을 확인하세요.");
      if (input.offset > h.size)
        failure(409, "TRANSFER_OFFSET", "파일 범위를 확인하세요.");
      const length = Math.min(input.length, h.size - input.offset);
      const output = (bytes: Buffer<ArrayBuffer>) => ({
        handle: h.id,
        offset: input.offset,
        length: bytes.length,
        base64: bytes.toString("base64"),
        checksum: sha(bytes),
        eof: input.offset + bytes.length === h.size,
        size: h.size,
        wholeChecksum: h.metadata?.checksum,
      });
      if (!length) {
        this.touch(h);
        return output(Buffer.alloc(0));
      }
      if (h.buffer) {
        this.touch(h);
        return output(h.buffer.subarray(input.offset, input.offset + length));
      }
      const releaseLane = await this.arena.acquireDownload.acquire(
        h.id,
        h.controller.signal,
      );
      let releaseBuffer: (() => void) | undefined,
        response: Response | undefined;
      try {
        this.check(h);
        response = await this.transport.request(
          filePath(h.read),
          "GET",
          undefined,
          {
            signal: h.controller.signal,
            range: { start: input.offset, end: input.offset + length - 1 },
          },
        );
        this.check(h);
        if (response.status === 206) {
          this.validateResponse(response, length);
          const value = response.headers.get("content-range"),
            match =
              value && value.length <= 128
                ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
                : null;
          if (
            !match ||
            Number(match[1]) !== input.offset ||
            Number(match[2]) !== input.offset + length - 1 ||
            Number(match[3]) !== h.size ||
            ![Number(match[1]), Number(match[2]), Number(match[3])].every(
              Number.isSafeInteger,
            )
          )
            failure(
              502,
              "FILE_RANGE_INVALID",
              "파일 범위 응답이 요청과 다릅니다.",
            );
          releaseBuffer = this.arena.allocation(length);
          const buffer = await this.body(
            response,
            Buffer.alloc(length),
            length,
            h,
          );
          this.check(h);
          this.touch(h);
          return output(buffer);
        }
        if (response.status !== 200)
          failure(
            502,
            "FILE_RANGE_INVALID",
            "파일 범위 응답을 확인하지 못했습니다.",
          );
        this.validateResponse(response, h.size);
        const release = this.arena.allocation(h.size);
        try {
          const buffer = await this.body(
            response,
            Buffer.alloc(h.size),
            h.size,
            h,
          );
          if (sha(buffer) !== h.metadata.checksum)
            failure(
              502,
              "FILE_HASH_MISMATCH",
              "다운로드한 파일 체크섬이 다릅니다.",
            );
          this.check(h);
          h.buffer = buffer;
          h.bufferRelease = release;
        } catch (error) {
          release();
          throw error;
        }
        this.touch(h);
        return output(h.buffer.subarray(input.offset, input.offset + length));
      } catch (error) {
        if (
          error instanceof ApiError &&
          [401, 403, 404, 502].includes(error.status)
        )
          this.invalidate(
            h,
            error.status === 502 ? "invalid_response" : "revoked",
          );
        throw error;
      } finally {
        await response?.body?.cancel().catch(() => undefined);
        releaseBuffer?.();
        releaseLane();
      }
    });
  }
  async cancel(id: string, direction: Handle["direction"]) {
    const h = this.find(id, direction, true);
    if (h.cancelAuth)
      failure(429, "TRANSFER_BUSY", "취소 확인이 진행 중입니다.");
    h.cancelAuth = true;
    return this.track(
      h,
      async () => {
        try {
          await this.authenticate(h, false, true);
          if (h.released) {
            this.dropReceipt(h);
            return {
              handle: h.id,
              state: "canceled",
              cleanupPending: false,
              commit: h.commitState,
            };
          }
          this.invalidate(h, "canceled");
          return {
            handle: h.id,
            state: h.active > 1 ? "canceling" : "canceled",
            cleanupPending: h.active > 1,
            commit: h.commitState,
          };
        } finally {
          h.cancelAuth = false;
        }
      },
      false,
    );
  }
  private task<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed)
      failure(503, "TRANSFER_DISPOSED", "파일 전송 연결이 종료되었습니다.");
    const promise = run();
    this.pending.add(promise);
    void promise.then(
      () => {
        this.pending.delete(promise);
      },
      () => {
        this.pending.delete(promise);
      },
    );
    return promise;
  }
  async operation(raw: unknown) {
    const input = attachmentOperationLookupSchema.parse(raw);
    return this.task(async () => {
      const release = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
      try {
        const status = attachmentOperationStatusSchema.parse(
          await this.transport.json(
            `/api/projects/${e(input.projectId)}/attachment-operations/${e(input.operationId)}`,
            "GET",
            undefined,
            { signal: this.lifetime.signal, jsonLimit: 8192 },
          ),
        );
        if (
          status.recorded &&
          (status.payload.issueId !== input.issueId ||
            status.payload.file.fileName !== normalizeFileName(input.name) ||
            status.payload.file.size !== input.size ||
            status.payload.file.checksum !== input.checksum)
        )
          failure(
            409,
            "OPERATION_CONFLICT",
            "기록된 작업 입력이 원래 요청과 다릅니다.",
          );
        if (
          status.recorded &&
          (status.operationId !== input.operationId ||
            status.receipt.operationId !== input.operationId ||
            status.receipt.projectId !== input.projectId ||
            status.receipt.issueId !== status.payload.issueId ||
            status.receipt.name !== status.payload.file.fileName ||
            status.receipt.mimeType !== status.payload.file.mimeType ||
            status.receipt.size !== status.payload.file.size ||
            status.receipt.checksum !== status.payload.file.checksum)
        )
          failure(
            502,
            "api_response_invalid",
            "파일 작업 기록과 결과가 일치하지 않습니다.",
          );
        return status;
      } finally {
        release();
      }
    });
  }
  async list() {
    this.sweep();
    return this.task(async () => {
      const release = this.arena.allocation(TRANSFER_AUTH_SCRATCH);
      try {
        const actor = await this.transport.verifiedActor({
          signal: this.lifetime.signal,
        });
        const identity = `${this.transport.mode}:${actor.role}:${actor.id}`;
        return [...this.handles.values()]
          .filter((h) => h.identity === identity)
          .map((h) => ({
            handle: h.id,
            direction: h.direction,
            state: h.state,
            cleanupPending: Boolean(h.invalid && h.active),
          }));
      } finally {
        release();
      }
    });
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.lifetime.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const h of this.handles.values()) this.invalidate(h, "disposed");
    for (const h of this.completed.values()) this.invalidate(h, "disposed");
    this.disposing = Promise.allSettled([...this.pending]).then(() => {
      for (const h of this.handles.values()) this.release(h);
    });
    return this.disposing;
  }
}
