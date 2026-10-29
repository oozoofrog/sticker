import type { Status } from "../server/types.js";
export const statusNames: Record<Status, string> = {
  backlog: "백로그",
  ready: "할 일",
  in_progress: "진행 중",
  waiting: "승인 대기",
  done: "구현 완료",
  closed: "소유자 종료",
};
export const statusIcons: Record<Status, string> = {
  backlog: "◌",
  ready: "○",
  in_progress: "◐",
  waiting: "Ⅱ",
  done: "✓",
  closed: "●",
};
export const priorityNames = {
  none: "우선순위 없음",
  low: "낮음",
  medium: "보통",
  high: "높음",
  urgent: "긴급",
};
export const priorityIcons = {
  none: "—",
  low: "▂",
  medium: "▅",
  high: "▇",
  urgent: "!",
};
export function dateText(value: string | null, full = false) {
  if (!value) return "날짜 미정";
  return new Date(value).toLocaleString(
    "ko-KR",
    full
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  );
}
export function bytes(value: number) {
  return value < 1024
    ? `${String(value)} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function relativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  return minutes < 1
    ? "방금 전"
    : minutes < 60
      ? `${String(minutes)}분 전`
      : minutes < 1440
        ? `${String(Math.floor(minutes / 60))}시간 전`
        : dateText(value);
}
export const versionStateNames = {
  planned: "계획 중",
  released: "출시 확정",
  archived: "보관됨",
};
