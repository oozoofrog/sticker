# 스티커 접근 통로

웹 서비스와 접근 앱은 별개입니다. 접근 앱 종료는 서버를 중지하지 않습니다. 시작·중지는 별도 선택입니다. 설치기 자체는 서비스를 시작하지 않습니다.

## macOS

Docker를 사용하는 터미널에서 **쓰기 가능한 설치 경로를 명시**합니다.

```bash
bash scripts/install-access.sh --mac "$HOME/Applications/Sticker.app"
```

상위 폴더는 미리 준비하세요. macOS 기본 `osacompile`/JXA/Foundation으로 접근 앱을 만듭니다. Node/Python 설치는 필요하지 않습니다. Dock 아이콘을 누르면 큰 관리창 없이 실제 스티커 URL을 기본 브라우저로 엽니다. 서비스가 중지됐을 때만 작은 창에서 ‘시작하고 열기’를 선택합니다. Docker 연결 실패 등은 짧은 상태와 재시도로 표시합니다.

앱이 실행된 동안 작은 메뉴바 메뉴에서 마지막 확인 상태·시각, 열기·새로고침·시작·중지를 사용할 수 있습니다. 메뉴를 열기만 해서는 상태 조회나 서비스 변경을 하지 않습니다. 중지는 하위 메뉴의 ‘중지 확인’을 눌러야 실행됩니다. 문제 상태 창의 X/닫기는 창만 숨깁니다. 작업 중 앱 종료 요청은 ‘작업 후 종료’로 표시하고 작업·정리가 끝난 뒤 접근 앱만 종료합니다. 서비스는 계속 실행됩니다.

앱 실행 중에는 경로의 한글 정규화 형태와 파일 identity를 비교하여 업데이트를 거절합니다. 앱 종료 후 같은 경로에 재설치하세요.

- 로그인 항목, 별도 백그라운드 서비스, Dock 고정 설정, 자동 실행은 추가하지 않습니다.
- 동일 설치의 소유 manifest·bundle ID가 있는 앱만 같은 경로에서 갱신합니다. 다른 앱과 다른 설치는 덮어쓰지 않습니다. 백업 앱은 남기지 않습니다.
- Developer ID 배포 서명이 아닌 로컬 ad-hoc 서명 앱입니다. 최종 리소스 변경 후 다시 서명하고 strict 검증을 통과해야 설치합니다. OS 보안 경고를 자동 해제하거나 Gatekeeper 설정을 변경하지 않습니다.
- 컴파일과 실제 Dock/브라우저 동작은 macOS 검증 대상입니다. Linux fixture 통과는 실제 Mac 실행 증거가 아닙니다.

## Linux desktop

```bash
bash scripts/install-access.sh --linux "$HOME/.local/share/applications/sticker.desktop"
```

상위 폴더가 있어야 합니다. 사용자 선택 경로에 desktop entry와 작은 소유 manifest를 생성합니다. 앱 메뉴의 열기·상태·시작·중지 동작은 터미널에서 실행됩니다. 명령 완료 후 Enter로 창만 닫습니다. Desktop 환경의 터미널 실행 지원이 필요합니다. 파일 생성과 GUI 실행 성공은 별개이며, 생성 파일의 이름·내용을 직접 수정하면 자동 갱신은 거절합니다. 기존 파일을 삭제하여 우회하지 말고 변경을 검토하세요.

## Headless / WSL

```bash
bash scripts/install-access.sh --headless
bash scripts/install-access.sh --wsl
```

실제 설치 경로의 재접속 명령과 현재 상태/URL을 출력합니다. WSL은 **해당 배포판의 Linux 터미널 안에서** 이 명령을 사용합니다. Windows native 바로가기·서비스·배포판 자동 선택은 지원하지 않습니다. Windows에서의 localhost 브라우저 도달성은 별도 확인해야 합니다. GUI 없는 서버에서 자동으로 브라우저가 열렸다고 표시하지 않습니다.

## 설치 선택과 상태

GUI 설치 시 실제 Docker 실행파일과 현재 named context를 고정합니다. 명시한 `COMPOSE_PROJECT_NAME`은 유지하고, 없으면 기존 Compose 파일/.env의 이름 규칙을 그대로 사용합니다(`compose.yaml` 기본 이름은 `sticker`). 로그인 shell이나 `.env`를 실행하지 않습니다. `DOCKER_HOST`, 사용자 지정 `DOCKER_CONFIG`, TLS 환경 및 `COMPOSE_FILE` 등 별도 override를 사용하는 설치는 지원하지 않고 거절합니다. 재설치에서 context/project를 바꾸는 것도 충돌로 거절합니다. 별도 운영 절차로 설치 선택을 변경해야 합니다.

Context 정의 또는 Compose/.env 파일 자체를 외부에서 변경하는 것까지 고정하지는 않습니다. 제어 중에는 설정을 변경하지 마세요. Runtime은 실제 daemon과 대상 컨테이너를 다시 검증합니다. 자세한 상태·잠금·제한은 [접근 명령 계약](ACCESS_RUNTIME.md)을 참고하세요.

`앱 응답 확인`은 컨테이너 내부 health 확인입니다. `브라우저 요청 전달`은 opener 호출이며 실제 페이지 로딩을 증명하지 않습니다. 원격 Docker URL은 그 호스트 기준이고 현재 PC의 localhost가 아닙니다. 알 수 없는 응답은 미확인으로 표시합니다. 서비스 중지는 자료/볼륨 삭제를 수행하지 않습니다.
