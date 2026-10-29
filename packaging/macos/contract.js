// Shared with the OS JXA applet. No Node/Python runtime dependency.
globalThis.StickerAccess = (() => {
  const states = [
    "docker_missing",
    "daemon_unavailable",
    "not_installed",
    "stopped",
    "starting",
    "ready",
    "unknown",
  ];
  const actions = [
    "none",
    "opened",
    "url_only",
    "started",
    "stopped",
    "busy",
    "failed",
  ];
  const unknown = () => ({
    state: "unknown",
    url: null,
    reason: "unknown",
    action: "failed",
    daemon: "unknown",
  });
  function parse(text) {
    try {
      if (typeof text !== "string" || text.length > 16384) return unknown();
      const value = JSON.parse(text);
      if (
        !value ||
        value.schemaVersion !== 1 ||
        !states.includes(value.state) ||
        !actions.includes(value.action) ||
        ![true, false, null].includes(value.containerRunning) ||
        !["verified", "unavailable", "not_checked"].includes(
          value.appResponse,
        ) ||
        value.browserReachability !== "unverified" ||
        value.urlScope !== "docker_host" ||
        !["local_socket", "remote", "unknown"].includes(value.daemon) ||
        typeof value.reason !== "string" ||
        !/^[a-z_]{1,80}$/.test(value.reason) ||
        typeof value.lockName !== "string" ||
        (value.lockName !== "" &&
          !/^sticker-control-[0-9]+-[0-9]+$/.test(value.lockName)) ||
        (value.url !== null &&
          (typeof value.url !== "string" ||
            !/^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(value.url)))
      )
        return unknown();
      if (value.url !== null) {
        const port = Number(value.url.slice(value.url.lastIndexOf(":") + 1));
        if (port < 1 || port > 65535) return unknown();
      }
      return value;
    } catch {
      return unknown();
    }
  }
  function label(text) {
    const value = parse(text);
    const labels = {
      docker_missing: "Docker 없음",
      daemon_unavailable: "Docker 연결 불가",
      not_installed: "서비스 미설치",
      stopped: "서비스 중지",
      starting: "서비스 준비 중",
      ready: "앱 응답 확인",
      unknown: "상태 미확인",
    };
    let output = labels[value.state];
    const reasons = [
      "none",
      "docker_missing",
      "daemon_unavailable",
      "compose_unavailable",
      "context_unavailable",
      "not_installed",
      "stopped",
      "container_state",
      "metadata_invalid",
      "origin_mismatch",
      "health_unavailable",
      "remote_daemon",
      "daemon_unknown",
      "headless",
      "opener_unavailable",
      "opener_failed",
      "mutation_busy",
      "mutation_failed",
      "target_changed",
      "readiness_timeout",
      "invalid_invocation",
      "host_tools_missing",
      "temporary_storage_unavailable",
      "installation_unavailable",
      "daemon_identity_unavailable",
    ];
    if (!reasons.includes(value.reason)) output += " · 상세 상태 미확인";
    if (value.action === "failed") output += " · 요청 실패 / 상태 미확인";
    if (value.action === "busy") output += " · 다른 제어 작업 중";
    if (value.action === "opened") output += " · 브라우저 요청 전달";
    if (value.action === "url_only") output += " · 주소만 확인";
    if (value.daemon === "remote")
      output += "\n원격 Docker · 브라우저 도달 미확인";
    else if (value.url) output += "\n브라우저 도달 미확인";
    if (value.url) output += "\n" + value.url;
    return output;
  }
  return { parse, label };
})();
