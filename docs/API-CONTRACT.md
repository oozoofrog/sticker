# Internal contract

All JSON responses are direct objects/arrays, not wrapped. Errors `{error:string, code:string}`. Types: server/types.ts. Cookie session or bearer agent token authenticates. `/api/session` GET -> `{actor}` or 401; POST `{password}` -> `{actor}`; DELETE -> 204. `/api/bootstrap` GET -> Bootstrap. UI is owner-only cookie login; bearer callers are agents.

`/api/projects`: POST -> Project; PATCH/DELETE `/api/projects/:id`; project inputs name,key,description,color. Deletes fail 409 if it contains issues/versions (delete those first). `/api/versions`: POST -> Version; PATCH/DELETE `/api/versions/:id`; inputs projectId,name,description,state,dueDate. Version deletion clears issue version references. Project identity of version/issue cannot change.

`/api/issues`: POST -> Issue; `/api/issues/:id`: GET -> IssueDetail, PATCH -> Issue, DELETE ->204. Input title,projectId,description,status,priority,assignee,targetVersionId,foundVersionId,fixedVersionId,labels. **PATCH requires revision** from last read; conflict returns 409. Surviving issues retain authoritative actor-attributed activity for issue creation/update and comments/resources; deleting an issue removes its own history. Project/version metadata edits have no independent audit log (version deletion records affected issue reference changes). Only owner may set status=closed or change closed issues. Agent write access cannot close or delete project/issue. No automatic execution of ready/waiting items.

`/api/issues/:id/comments`: POST `{body}` -> Comment. `/api/comments/:id`: DELETE ->204 (owner or comment author).
`/api/issues/:id/attachments`: POST multipart file field `file` -> Attachment, limit20MiB. `/api/issues/:id/links`: POST `{name,url}` -> Attachment. `/api/attachments/:id`: DELETE ->204; GET `/api/attachments/:id/file` authenticated file response (no public URL). URLs support http/https only, server never fetches. Files are private downloads; safe raster images optionally `/file?preview=1`.
`/api/reports`: POST `{projectId,issueId?,state,message}` -> AgentReport (agent only; identity from auth). Reports are self-reported and stale after 5min; never proof of a running process.

Store interface (domain owner implements `server/domain.ts`): `new Store(dataDir:string)`; `.close()`; `.bootstrap(actor)`; `.getIssue(actor,id)`; `.createProject(actor,input)`, `.updateProject(actor,id,input)`, `.deleteProject(actor,id)`; corresponding Version and Issue methods; `.addComment(actor,issueId,input)`, `.deleteComment(actor,id)`; `.addAttachment(actor,issueId,input)` accepts file metadata or link; `.getAttachment(actor,id)`; `.deleteAttachment(actor,id)` returns removed Attachment; `.reportAgent(actor,input)`. Inputs use unknown with runtime validation; output typed. Export DomainError with `status`, `code`, `message`. API controls credential/session, uploaded bytes and static SPA serving; domain controls authorization, all relational checks and business logic. Store uses node:sqlite and path `<dataDir>/sticker.sqlite`; upload files `<dataDir>/uploads/<storageKey>` handled by API. Metadata never supplies authorId. API removes deleted attachment bytes; stale orphan files can be cleaned via backup maintenance. Store won't import express.

## 이슈 관계 (schema 3)

같은 프로젝트의 부모/하위, 관련, 차단/피차단 관계 및 일괄 보드 요약 API를 제공합니다. 양끝 이슈 revision CAS와 현재 권한을 확인하며 자기 참조·방향별 순환을 거부합니다. [요청·응답 및 의미](ISSUE-RELATIONS.md)를 참고하세요. `done`은 차단을 해소하지 않으며 `closed` 후에도 자동 시작·종결은 없습니다.

## 출시 준비도와 명시적 확인 (schema v4)

버전 응답은 `revision`을 포함하며 일반 PATCH에도 현재 revision이 필요합니다. 일반 생성/PATCH의 released 진입/이탈은 `RELEASE_CONFIRMATION_REQUIRED`로 거부합니다. 준비도, 이관 미리보기/항목별 결과, Markdown 초안과 owner-only 출시 확인의 요청/응답·중복 처리 정책은 [출시 검토 계약](RELEASES.md)에 정리했습니다. 앱 내부 메타데이터 외의 배포/외부 발행 동작은 없습니다.

## 프로젝트 템플릿 (schema 6)

소유자 관리·불변 버전·정확한 필수 값 오류와 같은 일반 이슈 생성 경로의 템플릿 적용을 제공합니다. 생성 출처는 일반 PATCH로 변경할 수 없습니다. [API, 권한, 중복 처리, 이관 및 검증](ISSUE-TEMPLATES.md).

## GitHub 근거

선택적 읽기 공급자와 프로젝트별 소유자 동의, revision CAS, 정확한 SHA별 CI 캐시를 사용합니다. [엔드포인트·인증·오류 및 구성](GITHUB-EVIDENCE.md)을 참고하세요. 기본 설치에는 외부 계정/토큰이 필요하지 않습니다.

## 공통 자료 (schema7)

프로젝트/버전의 문서·파일·링크, 불변 버전, 지침, 고정된 이슈/결과 참조는 [자료 계약](RESOURCES.md)을 참고하세요. 일반 이슈 첨부와 별도 수명이며 연결 해제나 tombstone이 공유 파일을 삭제하지 않습니다. 현재 권한/CAS와 owner-only 지침 경계는 HTTP와 MCP가 공유합니다.
