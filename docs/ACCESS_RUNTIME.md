# 스티커 접근 명령

`bash <설치경로>/scripts/sticker.sh status|open|start|stop [--json]`

- `status`: Docker 없음/연결 불가, 미설치, 중지, 준비 중, 앱 응답 확인, 미확인을 구분합니다. 설정 변경·새 컨테이너·이미지 다운로드를 하지 않습니다. 실행 중인 선택 컨테이너의 기존 Node로 `/healthz`만 제한 시간 내 확인합니다.
- `open`: 검증된 실제 URL을 OS opener에 하나의 인자로 전달합니다. 서비스가 꺼져 있으면 시작하지 않습니다. 원격/미확인 Docker에서는 현재 PC의 localhost를 자동 열지 않습니다. GUI/opener가 없거나 `STICKER_OPEN_BROWSER=0`이면 URL만 출력합니다.
- `start`: 이미 실행 중이면 재시작/재설정하지 않습니다. 중지/미설치 상태에서는 기존 `start.sh`의 Engine 최소 버전, Compose 및 실제 loopback 게시 검증을 그대로 수행한 뒤 앱 응답을 확인합니다. 빌드는 조회 제한시간과 별개이며 GUI에서 짧은 timeout으로 강제 종료하지 마세요.
- `stop`: 현재 프로젝트의 `sticker` 서비스에서 확인한 컨테이너 ID만 정상 종료합니다. 접근 앱 종료와 별개입니다. 볼륨/자료/다른 서비스를 삭제하지 않습니다.

URL은 실제 단일 `127.0.0.1` 게시 포트와 실행 컨테이너의 `APP_ORIGIN`이 일치할 때만 제공합니다. localhost와 127.0.0.1을 임의로 치환하지 않습니다. 컨테이너 내부 HTTP 확인은 호스트 브라우저 접근 검증이 아닙니다. 로컬 Unix socket은 transport 분류일 뿐 프록시가 아니라는 절대 증명이 아닙니다. 선택 context/DOCKER_HOST가 원격 daemon을 가리키면 URL과 신뢰 경계는 그 Docker 호스트 기준입니다.

## 안정 JSON 계약 v1

stdout은 단일 JSON 객체입니다. Docker/opener/검증 런처의 출력이나 전체 설정·비밀번호는 섞지 않습니다. GUI는 exit0만으로 정상 실행을 추정하지 말고 `state`와 `appResponse`를 읽어야 합니다.

```json
{
  "schemaVersion": 1,
  "state": "ready",
  "containerRunning": true,
  "appResponse": "verified",
  "browserReachability": "unverified",
  "daemon": "local_socket",
  "url": "http://localhost:9876",
  "urlScope": "docker_host",
  "reason": "none",
  "action": "none",
  "lockName": ""
}
```

- `state`: docker_missing, daemon_unavailable, not_installed, stopped, starting, ready, unknown.
- `containerRunning`: true/false/null(미확인).
- `appResponse`: verified(내부 `/healthz`200·status=ok), unavailable, not_checked.
- `browserReachability`: 항상 unverified. `daemon`: local_socket, remote, unknown.
- `url`: 검증된 HTTP loopback origin 또는 null. `urlScope`: docker_host.
- `action`: none, opened(OS 열기 요청 전달; 실제 브라우저 성공 미확인), url_only, started, stopped, busy, failed.
- `reason`: none, docker_missing, daemon_unavailable, compose_unavailable, context_unavailable, not_installed, stopped, container_state, metadata_invalid, origin_mismatch, health_unavailable, remote_daemon, daemon_unknown, headless, opener_unavailable, opener_failed, mutation_busy, mutation_failed, target_changed, readiness_timeout, invalid_invocation, host_tools_missing, temporary_storage_unavailable, installation_unavailable, daemon_identity_unavailable.
- `lockName`: 호출이 획득/확인한 잠금의 안전한 파일명 또는 빈 문자열.

종료 코드: 0은 알려진 상태/완료(중지·미설치 상태조회와 URL-only 포함), 1은 조회·동작 오류/미확인, 3은 open 불가, 64는 잘못된 인자, 75는 제어 잠금 사용 중입니다. `--json`으로 잘못된 명령을 호출해도 오류 객체를 반환합니다.

각 Docker 조회는 5초+종료 유예1초로 제한하며 출력 크기도 제한합니다. 정상 종료 명령은 Docker의 30초 종료 유예와 클라이언트40초 제한을 사용합니다. 시작 후 준비 재조회는30초 후 종료하되 마지막 개별 상태조회 상한이 추가될 수 있습니다. 실제 빌드와 기존 검증 런처는 안전 검사를 도중에 잘라 버리지 않도록 별도입니다.

## 동시 제어와 설치 설정

현재 context를 한 호출에 고정하고, 기존 컨테이너의 실제 Compose 프로젝트 이름과 ID를 확인합니다. 변경 명령은 같은 OS 사용자/선택 daemon이 보고한 안정 ID 단위로 보수적으로 직렬화합니다. `docker info --format '{{.ID}}'`로 확인하며, ID를 확인할 수 없으면 변경을 거절합니다. socket 별칭이 달라도 같은 ID이면 같은 잠금을 사용하고 잠금 후 ID도 재확인합니다. ID 원문은 출력하지 않습니다. 다른 checkout에서 같은 daemon을 조작해도 최초 생성과 기존 대상이 서로 다른 잠금을 잡지 않습니다. 잠금 안에서 daemon endpoint와 대상을 다시 확인합니다. 외부 관리자가 동시에 `.env`/Compose 파일이나 Docker context 정의를 편집하는 것까지 원자적으로 막지는 않습니다. 작업 도중 설치 설정을 변경하지 마세요.

잠금은 `/tmp/<lockName>`의 빈 디렉터리입니다. 정상 종료/신호 처리는 자기 잠금만 제거합니다. 비정상 강제 종료 후 남은 잠금은 자동으로 훔치거나 PID를 근거로 다른 프로세스를 죽이지 않습니다. busy 응답의 정확한 `lockName`을 확인하고 해당 daemon에서 진행 중인 Sticker 시작/중지 작업이 없음을 운영자가 확인한 경우에만 **그 빈 디렉터리 하나를 `rmdir`로 제거**하세요. 다른 경로나 데이터 디렉터리는 삭제하지 마세요. 서로 다른 OS 사용자 간 동시 관리까지 직렬화하는 운영 잠금은 아닙니다.

호스트 Node/Python/curl은 필요하지 않습니다. Bash와 Docker/Compose, 표준 POSIX 도구만 사용합니다. `.env`를 source/eval하지 않으며 자격 증명 원문을 출력하지 않습니다. 이 CLI는 Dock/메뉴바/바로가기 설치 자체를 수행하지 않습니다.

OS opener는 브라우저 프로세스가 될 수 있으므로 Docker 조회의 파일 크기 제한이나 종료 watchdog을 상속하지 않습니다. 즉시 실패는 보고하지만 `opened`는 요청 전달만 의미하며, 뒤늦은 opener 오류나 실제 창/페이지 성공은 검증하지 않습니다. 브라우저를 강제 종료하지 않습니다.

상태 한 번에도 여러 Docker 조회가 순서대로 필요하므로 전체 응답이5초 안에 끝난다는 계약은 아닙니다. 느린 daemon에서는 수십 초가 걸릴 수 있습니다. 제어 창은 비동기로 호출하고 작업 중/미확인 표시를 유지해야 하며, 조회 timeout을 서비스 중지나 브라우저 종료로 해석하면 안 됩니다. OS 열기는 조회 뒤 약1초 동안 즉시 실패만 확인하고 반환합니다.

중지 요청의 응답이 실패했더라도 실제 서버는 이미 멈췄을 수 있으므로 실패 후 상태를 다시 조회합니다. 과거의 ready/verified 스냅샷을 그대로 재사용하지 않습니다. 임시 저장소 또는 설치 도우미를 준비할 수 없는 경우에도 `--json`은 정제된 오류 객체를 반환합니다.
