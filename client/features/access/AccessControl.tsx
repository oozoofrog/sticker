import React from "react";
export function AccessControl({
  mode,
  owner,
  className,
  onLogout,
  onRefresh,
  children,
}: {
  mode: "password" | "trusted-loopback" | null;
  owner: boolean;
  className: string;
  onLogout: () => void;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  if (mode === "trusted-loopback")
    return (
      <span className={className} role="status">
        {owner ? "로컬 소유자" : "에이전트"}
      </span>
    );
  if (mode === null)
    return (
      <span className={className}>
        <span role="status">접속 모드 미확인</span>
        <button
          type="button"
          className="text-button"
          aria-label="접속 모드 새로고침"
          onClick={onRefresh}
        >
          ↻
        </button>
      </span>
    );
  return (
    <button className={className} aria-label="로그아웃" onClick={onLogout}>
      {children}
    </button>
  );
}
