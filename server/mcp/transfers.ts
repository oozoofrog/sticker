import type { McpFeatureClient } from "./sessions.js";
import { type createStickerTransport } from "./transport.js";
import { TransferManager } from "./transfer-manager.js";
import {
  beginUploadSchema,
  uploadChunkSchema,
  finishUploadSchema,
  beginFileReadSchema,
  fileReadChunkSchema,
  cancelTransferSchema,
} from "../contracts/file-transfers.js";
import { attachmentOperationLookupSchema } from "../contracts/file-transfers.js";
export function registerTransferTools(
  { tool }: McpFeatureClient,
  transport: ReturnType<typeof createStickerTransport>,
) {
  const manager = new TransferManager(transport);
  tool(
    "sticker_begin_upload",
    "20 MiB 이하 파일 전송을 시작합니다. 대상을 고정하고 같은 작업 식별자·원래 메타데이터·전체 바이트로만 완료를 재시도합니다. 호스트 경로나 URL을 읽지 않습니다.",
    beginUploadSchema.shape,
    async (input) => manager.beginUpload(beginUploadSchema.parse(input)),
  );
  tool(
    "sticker_write_upload_chunk",
    "최대64 KiB 원문 청크를 순서대로 추가합니다. 같은 위치·같은 바이트의 재전송은 중복되지 않습니다. 아직 서버 파일로 저장되지 않습니다.",
    uploadChunkSchema.shape,
    async (input) => manager.writeChunk(uploadChunkSchema.parse(input)),
  );
  tool(
    "sticker_finish_upload",
    "전체 체크섬을 확인한 뒤 고정된 원래 입력으로 파일을 저장합니다. 자동 재전송하지 않습니다. 연결 재시작 후에는 같은 operationId·대상·메타데이터·바이트로 새 전송을 시작하세요. 과거 커밋 결과와 현재 파일 존재 여부를 구분합니다.",
    finishUploadSchema.shape,
    async (input) => manager.finishUpload(finishUploadSchema.parse(input)),
  );
  tool(
    "sticker_cancel_upload",
    "현재 업로드의 로컬 버퍼를 취소합니다. 이미 전송한 요청의 커밋을 되돌리지 않습니다. cleanupPending 동안 용량은 계속 예약됩니다.",
    cancelTransferSchema.shape,
    async ({ handle }) => manager.cancel(handle, "upload"),
  );
  tool(
    "sticker_begin_file_read",
    "첨부 또는 정확한 자료 버전 파일을 고정해20 MiB까지 청크로 읽습니다. 삭제 표시된 자료의 명시적 과거 버전도 현재 권한 안에서 읽을 수 있습니다.",
    beginFileReadSchema.shape,
    async (input) => manager.beginRead(beginFileReadSchema.parse(input)),
  );
  tool(
    "sticker_read_file_chunk",
    "최대64 KiB 파일 청크와 체크섬을 읽습니다. 매번 현재 권한을 확인하고 고정 버전을 유지합니다. 전체 파일을 조립한 뒤 전체 체크섬도 확인하세요.",
    fileReadChunkSchema.shape,
    async (input) => manager.readChunk(fileReadChunkSchema.parse(input)),
  );
  tool(
    "sticker_cancel_file_read",
    "현재 파일 읽기 버퍼를 취소합니다. 진행 중인 읽기가 정리되기 전에는 예약 용량을 다시 사용하지 않습니다.",
    cancelTransferSchema.shape,
    async ({ handle }) => manager.cancel(handle, "download"),
  );
  tool(
    "sticker_list_file_transfers",
    "현재 인증 주체의 프로세스 내 전송 식별자와 정리 상태만 읽습니다. 파일 내용·이름은 노출하지 않으며 재시작 후 부분 전송을 복구하지 않습니다.",
    {},
    async () => manager.list(),
    true,
  );
  tool(
    "sticker_get_attachment_operation",
    "현재 주체의 첨부 작업 기록을 원래 대상·이름·크기·체크섬과 비교합니다. recorded:false는 아직 기록을 찾지 못했다는 뜻이며 진행 중인 요청이 나중에 커밋하지 않는다는 보장은 아닙니다.",
    attachmentOperationLookupSchema.shape,
    async (input) =>
      manager.operation(attachmentOperationLookupSchema.parse(input)),
    true,
  );
  return manager;
}
