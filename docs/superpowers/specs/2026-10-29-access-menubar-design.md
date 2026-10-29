# Sticker Dock / 메뉴바 접근 재설계

2026-10-29. 사용자 승인: Dock에서 실제 Sticker 화면을 열고, 관리 동작은 작은 메뉴바 메뉴에 둔다. 기존 큰 관리창은 출시하지 않는다.

## 접근 방식

- 선택된 방향: 기존 JXA stay-open 앱에 AppKit NSStatusItem + NSMenu. 같은 앱/PID에서 Dock 진입과 메뉴를 제공하고 이미 검증한 CLI/JSON/잠금/자식 소유권을 재사용한다.
- 제외: 큰 관리창 유지(사용자가 거절), Swift/별도 상주 companion(이번 범위에 불필요), 메뉴바 전용 LSUIElement(요구한 Dock 진입과 충돌).
- 로그인 항목, 자동 시작, Dock 환경설정 변경, 새 권한/네트워크/credentials 없음. 사용자가 앱을 실행한 동안만 메뉴가 존재한다.

## 사용 흐름

1. Dock/앱 실행 또는 재열기: 창을 만들지 않고 기존 `open --json`을 단 한 번 큐잉한다. CLI가 확인한 URL만 기본 브라우저로 전달하며 브라우저 요청 성공을 실제 페이지 렌더 성공으로 표시하지 않는다.
2. 정상: 앱 관리창 없음. 메뉴바에 짧은 Sticker 표식(접근성 이름 ‘스티커’)만 유지한다.
3. open 결과가 stopped/not_installed: 작은 비모달 패널에 해당 상태와 ‘시작하고 열기’, ‘닫기’만 표시한다. 자동 서비스 시작은 하지 않는다.
4. 명시적인 ‘시작하고 열기’: start 완료 후 ready일 때만 open을 큐잉한다. starting/unknown/error이면 실제 상태와 재시도 버튼을 표시하며 성공을 추측하지 않는다.
5. Docker 없음/연결 실패/권한 또는 설치 경로 오류: 짧은 상태와 ‘다시 확인’, ‘닫기’. 권한 변경·Docker 실행·임의 파일 선택을 자동으로 수행하지 않는다.
6. 메뉴: 스티커 열기, 상태(마지막 확인 시각 포함), 새로고침, 서비스 시작, 서비스 중지(하위 메뉴 ‘중지 확인’·‘취소’), 앱 종료. 설명/매뉴얼 패널 없음.
7. 메뉴 열기 때 마지막 관찰 상태·시각만 표시한다. 명시 새로고침 또는 Dock 진입에서 비동기 갱신한다. 메뉴 추적 중 idle 지연 때문에 조회를 자동 큐잉하여 조작을 잠그지 않는다. 이전 값을 현재 실시간 상태로 표현하지 않는다. 주기 폴링 추가 없음.
8. 앱 종료는 서비스 중지와 다르다. 작업 중 종료 요청은 ‘작업 후 종료’, 자기 자식 완료·정리 후에만 앱이 종료한다. X는 짧은 보조 패널을 숨길 뿐이다.

## 동시성 / 안전

- run/reopen/메뉴 callback은 즉시 반환한다. NSTask lifecycle은 기존 짧은 idle 처리 유지; wait/긴 while/modal 표준대화상자 금지.
- activeTask 하나, pendingAction 하나. 연타 중 추가 start/stop은 무시한다. Dock open 요청은 필요한 경우 단일 open-after-current 의도로 합치며 quit 또는 명시 stop이 우선하면 취소한다. 임의 작업 큐 누적 없음.
- submenu 확인은 명시 stop만 발생시킨다. 창 닫기·앱 종료·Dock 재열기·상태 조회는 stop을 발생시키지 않는다.
- 실제 작업 완료 전 C exit 금지. 현재 검증된 OS quit 취소 lifecycle을 유지하되 -128 응답 전달을 보장한다고 주장하지 않는다.
- NSStatusItem/NSMenu/target 전역 참조 유지. 자동 enable 검증 대신 실행 중 항목 상태를 명시 갱신한다.
- 기존 source manifest, Docker context, canonical URL 제한, final ad-hoc 서명, live-reinstall 거절, NFC/NFD/ObjC nil 안전성은 그대로 보존한다.

## 회귀 검증 계약

### Cloud TDD (OS 실증과 구분)

- run/reopen ready 경로가 큰 NSWindow 생성 없이 open 한 번만 요청.
- 메뉴 항목/접근성 이름/실제 상태·확인 시각, unknown/error에서 stale-success 제거.
- stopped/not_installed만 시작 동작 제공, start→ready→open 및 실패 시 open 없음.
- 연타/메뉴 재열기/작업 중 Dock/quit/stop 확인·취소에서 중복 child와 자동 stop 없음.
- 보조 패널 X 숨김, 이후 Dock 재시도; 기존 idle/busy quit VM 계약 유지.
- 설치·서명·path/context/JSON/CLI 회귀 및 전체 gates.

### 실제 Mac 필수 gate (부모 담당)

- 정확한 최종 head를 별도 mock fixture에서 compile + strict codesign.
- Dock 첫 실행/재열기에서 큰 관리창 없이 브라우저 open 요청, ready 실제 Sticker 화면 확인은 승인된 운영 통로에서 별도 구분.
- 메뉴바 아이콘/이름/상태/키보드 접근과 메뉴 열림 중 진행중 표시·완료 후 갱신.
- stopped 작은 패널, 시작 한 번 후 열기, 실패/unknown, stop 취소·확인, 연타 및 같은 PID 재열기.
- idle OS quit / busy OS quit는 실제 OS 이벤트로 검증, gate 전 자식 생존·gate 후 정리·메뉴 제거.
- 외부 볼륨 권한은 이미 승인된 exact identity만 사용; 추가 권한 요청은 자동 허용하지 않음.
- Linux/WSL/headless 변경 없음. 기존 Linux GUI 미검증 제한 유지.

## 공식 API 근거

- https://developer.apple.com/documentation/appkit/nsstatusitem : button/menu로 메뉴바 항목 제공.
- https://developer.apple.com/documentation/appkit/nsstatusbar/statusitem(withlength:) : 반환 항목을 호출자가 유지해야 함.

현재 문서는 설계/검증 계약이며 제품 소스는 변경하지 않았다. 기존 file-open 정지의 인과와 exact 권한 연결은 별도 Mac 증거로 확인하며 UI 변경으로 우회하지 않는다.
