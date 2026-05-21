---
name: notion
description: Notion CLI(ntn)를 사용해 페이지 조회·생성·수정, DB 쿼리, API 직접 호출 등 Notion 작업 수행
triggers:
  - 노션
  - Notion
  - 노션 페이지
  - 노션 DB
  - 노션 데이터베이스
  - 노션에 추가
  - 노션에서 가져와
  - 노션 정리
  - 노션 업데이트
  - notion page
  - notion database
---

# Notion CLI (ntn) 사용 지침

## 바이너리 경로

```
~/.local/bin/ntn
```

PATH에 없을 경우 항상 전체 경로 `~/.local/bin/ntn`으로 호출한다.

## 인증

`NOTION_API_TOKEN`이 `.env`에 설정되어 있으므로 `ntn login` 없이 바로 사용 가능.
모든 ntn 명령 실행 시 환경변수가 자동 로드된 상태여야 한다 (SimpleClaw 프로세스는 `.env`를 로드함).

- `ntn login` — 브라우저 인증 (PAT 방식, 워크스페이스 정책에 따라 차단될 수 있음)
- 환경변수 `NOTION_API_TOKEN` — integration token 방식 (현재 사용 중)

## 주요 명령어

### 페이지 조회
```bash
ntn pages get <page-id>           # Markdown으로 출력
ntn pages get <page-id> --json    # JSON으로 출력
```

### 페이지 생성
```bash
ntn pages create --content '# 제목\n\n본문'
ntn pages create --parent page:<parent-id> < page.md
ntn pages create --parent database:<db-id> --content '...'
ntn pages create --parent data-source:<ds-id> < page.md
```

### 페이지 수정
```bash
ntn pages update <page-id> --content '# 수정된 내용'
ntn pages update <page-id> < updated.md
```

### 데이터소스(DB) 쿼리
```bash
ntn datasources query <data-source-id>
ntn datasources query <data-source-id> --limit 50 --json
ntn datasources query <id> --filter '{"property":"Done","checkbox":{"equals":true}}'
ntn datasources resolve <database-id>   # database ID → data-source ID 변환
```

### API 직접 호출
```bash
ntn api v1/users
ntn api v1/pages/<id>
ntn api v1/databases/<id>/query -X POST
ntn api v1/pages parent[page_id]=<id> properties[title][title][0][text][content]="제목"
```

### 파일 업로드
```bash
ntn files create < photo.png
ntn files create --external-url <url>
ntn files list
```

## ID 형식

Notion URL에서 ID 추출: URL 마지막 32자리 hex 문자열
- 예: `https://notion.so/My-Page-abc123def456...` → `abc123def456...`
- 하이픈 형식도 허용: `abc12345-6789-abcd-ef01-234567890abc`

## 주의사항

- `ntn pages` 명령은 `NOTION_API_TOKEN` 환경변수 또는 `ntn login` 인증 필요
- `ntn datasources query`는 database ID가 아닌 **data-source ID** 사용 (`ntn datasources resolve`로 변환)
- 페이지 내용이 잘린 경우 `--json` 플래그로 `unknown_block_ids` 확인
- 속성(properties), 템플릿 등 고급 기능은 `ntn api v1/pages` 직접 호출 사용
