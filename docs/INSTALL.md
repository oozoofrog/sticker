# Docker 설치 · 환경 독립성

## 필요한 것과 필요하지 않은 것

- **필수:** Linux 컨테이너를 실행할 수 있는 Docker Server Engine 28.3.3 이상 또는 해당 Engine을 포함한 Docker Desktop, Compose v2, 이미지 빌드를 위한 인터넷 연결. 먼저 `docker version`과 `docker compose version`을 확인하세요.
- 기본 웹 앱과 Docker MCP 어댑터에는 **호스트 Node.js, npm, Python, OpenSSL, GitHub 계정·토큰, Codex 또는 특정 개인 폴더가 필요하지 않습니다.** Git 없이 소스 압축을 풀어도 빌드할 수 있습니다.
- 처음 빌드할 때 공개 Node 이미지와 잠금 파일에 명시된 npm 패키지를 받습니다. 실행 중 UI 자산을 외부 CDN에서 내려받지 않습니다. 링크 첨부 대상도 서버가 방문하지 않습니다.
- 아래 셸 예시와 제공 백업/복원/검증 스크립트는 **Bash와 POSIX 도구**를 사용합니다. 백업은 `docker dirname tar date mkdir mv rm`, 복원은 `docker tar grep awk`, 통합 검증은 이 도구들에 더해 `bash mktemp chmod mkfifo`가 필요합니다. 각 스크립트는 공유 사전 검사로 도구가 없으면 종료 코드 2와 설치 안내를 반환하며, Docker 조작이나 출력 파일 생성 전에 중지합니다. Linux/macOS 또는 Windows의 WSL 환경을 사용하세요. 표준 무암호 로컬 시작은 검증 스크립트를 사용합니다. 원시 Compose 실행은 비밀번호가 필요합니다.

## 새 소스에서 시작

소스 루트에서 다음을 실행합니다. 표준 로컬 시작은 비밀번호 설정 없이 동작합니다. 같은 컴퓨터의 다른 사용자·프로그램도 소유자로 접근하므로 신뢰하는 개인 컴퓨터에서만 사용하세요. 기본 비밀번호나 실사용 토큰은 제공하지 않습니다.

```bash
cp .env.example .env
chmod 600 .env
bash scripts/sticker.sh start
docker compose logs --tail=50 sticker
```

http://localhost:8787 을 바로 엽니다. 첫 설치는 프로젝트·이슈·에이전트가 없는 빈 작업실입니다. 기본 구성은 **호스트 폴더를 마운트하지 않고**, Node 사용자로 읽기 전용 루트 파일시스템에서 실행합니다. `config/` 생성도 필요하지 않습니다.

- 호스트 포트는 `127.0.0.1`에만 열립니다. 컨테이너 내부의 `HOST=0.0.0.0`은 Docker 포트 전달을 위한 설정이며, 호스트 공개 바인딩이 아닙니다.
- `STICKER_PORT`를 바꾸면 `APP_ORIGIN`도 같은 주소/포트로 바꾸세요.
- 기본 Compose 프로젝트 이름은 `sticker`입니다. 여러 설치는 각기 다른 `docker compose -p <이름>`을 사용하고, 백업·복원에도 같은 `COMPOSE_PROJECT_NAME`을 지정하세요.
- 데이터는 이름 있는 `sticker_data` 볼륨의 `/app/data/sticker.sqlite`와 `/app/data/uploads`에 함께 저장됩니다. `up --force-recreate`, `restart`, `down` 후 재실행해도 유지됩니다. **`down -v`는 삭제합니다.**
- 외부 접속은 `LOCAL_OWNER_MODE=off`와 고유한 `OWNER_PASSWORD`를 설정한 별도 비밀번호 경로로만 구성하세요. 운영자가 관리하는 HTTPS/비공개 네트워크 구성이 별도로 필요합니다. 인증을 제거하거나 공개 포트를 열지 마세요.

## 선택: 에이전트 / MCP

웹 앱은 에이전트 설정 없이 동작합니다. 접근을 허용할 때만 [MCP 안내](MCP.md)에 따라 운영자 소유 JSON 파일과 토큰을 구성하세요. `compose.agents.yaml`을 명시적으로 적용해야만 그 파일을 읽기 전용으로 마운트합니다. 기본 `up`은 `tools` 프로필의 MCP 프로세스를 시작하지 않습니다.

**기존 설치 이전:** 예전의 항상 활성인 `./config:/app/config` 마운트가 제거되었습니다. 이미 `AGENT_CONFIG_PATH`를 사용했다면 JSON을 보존하고 `compose.agents.yaml`을 적용하세요. 기존 환경 변수를 비우는 방식으로 우회하지 마세요. 설정 경로가 남아 있는데 파일이 없으면 서버는 시작을 거부하며, 조용히 에이전트 설정을 무시하지 않습니다. 기존 데이터 볼륨과 프로젝트 이름은 바꾸지 않습니다.

## 백업과 복원

현재 설정이 로드되는 같은 소스 루트에서 실행하세요. 선택적 에이전트 구성을 쓴다면 아래 명령에도 같은 Compose 파일 선택을 유지합니다. 예: `.env`에 `COMPOSE_PATH_SEPARATOR=:`와 `COMPOSE_FILE=compose.yaml:compose.agents.yaml` 지정.

```bash
bash scripts/backup.sh backups/sticker-backup.tar.gz
# 기존 DB/첨부 전체를 교체합니다. 본인이 만든 신뢰할 수 있는 백업만 사용하세요.
bash scripts/restore.sh backups/sticker-backup.tar.gz --replace-data
# 검증 성공 뒤에도 서버는 멈춰 있습니다. 명시적으로 시작합니다.
bash scripts/start.sh
```

백업은 서비스를 정상 종료해 SQLite와 첨부를 일관되게 묶고, 원래 실행 중이었을 때만 다시 시작합니다. 복원은 경로/링크와 추출된 DB·첨부를 검증한 뒤 데이터를 교체합니다. 현재 DB 스키마가 지원하는 백업만 사용하세요. `.env`와 에이전트 설정 파일은 데이터 백업에 들어가지 않으므로 별도로 안전하게 보관하세요. 백업 자체에도 비공개 정보가 있으므로 접근을 제한하세요. 동시에 여러 백업/복원을 실행하지 마세요.

## 개인 환경과 분리한 검증

```bash
bash scripts/verify-container.sh
```

이 명령은 사용자 `.env`를 읽지 않고 고유한 Compose 프로젝트·이미지·볼륨과 임시 비밀번호/토큰을 만듭니다. 실제 이미지를 빌드한 뒤 비인증 거절, 로그인, 프로젝트/이슈 생성, 첨부 업로드, 컨테이너 재생성 후 SQLite/파일 보존, 백업/복원 후 후속 쓰기 제거, 선택적 읽기 전용 MCP를 확인합니다. 마지막에는 **자신이 만든 테스트 컨테이너·볼륨·이미지·임시 파일만** 정리합니다. 일반 설치나 운영 데이터에 사용하지 않습니다. 빌드 캐시는 Docker에 남을 수 있습니다.

[Portable container workflow](../.github/workflows/container.yml)는 GitHub-hosted Ubuntu 러너의 새 체크아웃에서 이 검증을 실행합니다. 레지스트리 푸시·배포·사용자 계정 연결은 하지 않습니다. 워크플로 파일 추가 자체가 성공 증거는 아니며 해당 실행의 결과를 확인해야 합니다.

로컬 Node 기반 단위 테스트, YAML 구문 검사나 모의 Docker 호출 테스트는 실제 Docker 빌드/실행의 대체 증거가 아닙니다. Ubuntu의 컨테이너 검증 성공만으로 ARM64·Windows·macOS 전체가 검증되었다고 간주하지 않습니다. Node 패치와 다중 아키텍처 기반 digest는 [고정·갱신 정책](REPRODUCIBILITY.md)으로 관리합니다. `ubuntu-24.04` 러너 이미지와 빌더 등은 여전히 갱신되므로 비트 단위 동일 빌드를 보장하지 않습니다.

## 시작 경로와 업데이트

`bash scripts/start.sh`는 현재 호출에만 `LOCAL_OWNER_MODE=trusted-loopback`을 설정해 셸과 `.env`의 `off`보다 우선합니다. `.env`를 수정하거나 자격 증명 내용을 직접 해석·출력하지 않으며, 기존 `COMPOSE_FILE` 선택은 유지합니다. Docker Compose는 기존 환경 설정을, 앱은 명시적으로 선택한 에이전트 구성을 평소처럼 읽습니다. 이미 실행 중이면 중지·재설정하지 않고 거절합니다. 업데이트는 백업 → 명시적 `docker compose stop sticker` → `bash scripts/start.sh` 순서입니다. 비밀번호 경로를 의도한 설치는 이 로컬 런처를 사용하지 말고 `LOCAL_OWNER_MODE=off`와 고유한 비밀번호로 원시 Compose를 실행하세요. [보장과 잔여 위험](LOCAL_OWNER.md).

표준 로컬 런처는 Docker **서버** 버전을 변경 작업 전에 확인합니다. 안정 버전 숫자 형식 `x.y.z`만 허용하고 조회 실패·구버전·prerelease/vendor 접미사는 거절합니다. Docker 업그레이드는 자동 수행하지 않습니다. [최소 버전 근거와 한계](LOCAL_OWNER.md#docker-server-support-boundary).

“같은 컴퓨터”와 `localhost` 접속 안내는 현재 컴퓨터의 로컬 Docker Engine/Desktop 컨텍스트를 전제로 합니다. 런처는 선택한 Docker context/`DOCKER_HOST`를 존중하고 임의로 전환하지 않습니다. 원격 daemon이면 loopback 바인딩과 로컬 사용자·프로세스 신뢰는 그 Docker 호스트 기준이며, 현재 컴퓨터의 브라우저에서 접속할 수 있다는 뜻이 아닙니다.

다시 열 때는 `bash scripts/sticker.sh open`, 상태 조회는 `bash scripts/sticker.sh status`를 사용하세요. 이 공통 진입점은 호출한 셸의 현재 디렉터리와 관계없이 설치 디렉터리의 설정을 사용하며, 시작은 기존 검증 런처를 그대로 거칩니다. [기계 판독 계약과 운영 한계](ACCESS_RUNTIME.md).
