import type { RepoEntry } from '../config.js';

export interface MemoryLike {
  type: string;
  key: string;
  value: string;
}

export interface RepoWorkPromptArgs {
  userMessage: string;
  repo: RepoEntry;
  /** If true, this is a follow-up turn in an existing thread; tone is slightly less formal. */
  isContinuation: boolean;
  /** Memories to inject before the 지시 block. */
  memories?: MemoryLike[];
}

/** Format an array of memories into a system-prompt block. Returns '' if empty. */
export function formatMemoryBlock(memories: MemoryLike[]): string {
  if (!memories || memories.length === 0) return '';
  const lines = memories.map((m) => `- [${m.type}] ${m.value}`);
  return `# 저장된 컨텍스트\n${lines.join('\n')}\n\n---\n`;
}

export const ARTIFACT_INSTRUCTION =
  '파일(PDF, HTML 등)이나 URL을 산출물로 생성했을 경우 응답 끝에 다음 형식으로 표시 (claw가 해당 파일/링크를 Discord에 직접 첨부):\n' +
  '  `__CLAW_ARTIFACT__ {"kind":"file","path":"/절대경로","caption":"설명"}`\n' +
  '  `__CLAW_ARTIFACT__ {"kind":"url","url":"https://...","caption":"설명"}`';

const BASE_LINES = [
  '한국어로 응답',
  '작업 끝나면 의미 단위로 git commit & push까지 완수. 첫 push 전: (1) `gh auth setup-git` 실행 (GH_TOKEN 자동 인식, idempotent). (2) Windows/NT AUTHORITY\\\\SYSTEM 환경이면 SSH push 대신 HTTPS 사용 — `git remote get-url origin`으로 확인 후 SSH URL(`git@github.com:...`)이면 `git remote set-url origin https://github.com/<owner>/<repo>` 전환 후 push. 실패 시 강행 금지(-f X), 보고만.',
  '구현·수정 완료 후 반드시 실행 또는 dry-run 검증을 직접 수행하고 결과를 완료 메시지에 포함: **구현 내용** → **검증 결과** → **다음 단계** 3단 구조.',
  '반복 사용 가능한 스크립트·워크플로우를 새로 구현했을 때, 관련 skill에 패턴을 추가할 것을 먼저 제안.',
  'WebFetch 실패(차단·타임아웃·비정상 응답) 시 사용자 재지시 없이 즉시 우회: `curl -A "Mozilla/5.0" <url>` → RSS feed(`https://rss.{domain}/{id}.xml` 또는 `{url}/feed`) → WebSearch 순으로 자동 시도. 우회 성공 시 결과를 그대로 활용하고 별도 실패 보고 없음.',
  '최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨). 단, 복수의 문의·건(B2B, 고객, 메일 등)을 보고할 때는 각 건마다 채널·수신 시각·연락처·문의 원문을 생략 없이 포함.',
  '디스커버리 콜·미팅 초대·인터뷰 등 일정을 잡는 이메일 발송 완료 후에는 반드시 "통화/미팅 시간 확정 시 캘린더 일정도 바로 만들어드릴 수 있습니다"를 안내.',
  '이메일 초안 제시 후에는 마지막 줄에 "발송할까요? (ㄱㄱ / 수정 요청)" 한 줄을 반드시 포함.',
  ARTIFACT_INSTRUCTION,
];

const LIFE_OS_HINT =
  'life-os 한정 힌트: 적절한 skill을 먼저 탐색·활용 (`/recommend-menu`, `/recipe`, `/coupang-cart`, `/fitness-log-workout` 등). 날짜는 `date +%y%m%d`로 얻어라.';

/**
 * Build the systemAppend block for a repo-work claude run.
 *
 * Encodes claw conventions:
 *  - Korean responses
 *  - commit & push when work-unit completes
 *  - terse final reply (Discord delivery)
 *  - this session is scoped to one repo
 *  - life-os specific skill hint
 */
export function buildRepoWorkSystemAppend(args: RepoWorkPromptArgs): string {
  const memBlock = formatMemoryBlock(args.memories ?? []);
  const lines: string[] = [];
  if (memBlock) lines.push(memBlock);
  lines.push('지시:');
  for (const line of BASE_LINES) {
    lines.push(`- ${line}`);
  }
  lines.push(
    `- 이 채널/세션은 ${args.repo.fullName} 전용. 다른 repo 작업 필요해 보이면 사용자에게 안내만.`,
  );
  if (args.repo.description) {
    lines.push(`- 채널 컨텍스트: ${args.repo.description}`);
  }
  if (args.repo.fullName === 'greatSumini/life-os') {
    lines.push(`- ${LIFE_OS_HINT}`);
  }
  if (args.isContinuation) {
    lines.push('- (이전 대화 이어가기 모드 — 같은 thread 안에서의 후속 메시지)');
  }
  return lines.join('\n');
}

/**
 * Build the systemAppend block for a read-only auto-analysis run.
 * Explicitly forbids file edits, git operations, and any implementation work.
 */
export function buildAnalysisSystemAppend(): string {
  return [
    '지시:',
    '- 한국어로 응답',
    '- 이 실행은 읽기 전용 분석 전용 — 파일 수정, git 작업, 코드 변경 절대 금지',
    '- 최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)',
  ].join('\n');
}

export interface ClawMaintenancePromptArgs {
  isContinuation: boolean;
  /** Memories to inject before the 지시 block. */
  memories?: MemoryLike[];
}

/** 재실행 트리거 마커. claw가 응답에서 이 라인을 검출하면 본문에서 제거 후 launchctl kickstart 수행. */
export const CLAW_RESTART_MARKER = '__CLAW_RESTART__';

export interface WikiIngestPromptArgs {
  /** true면 순수 URL ingest, false면 주제어 리서치 */
  isUrl: boolean;
}

/**
 * Build the systemAppend block for a wiki ingest run.
 * cwd는 ~/coding-agent-wiki. CLAUDE.md를 먼저 읽어 스키마를 확인하고 ingest를 수행한다.
 */
export function buildWikiIngestSystemAppend(args: WikiIngestPromptArgs): string {
  const lines: string[] = [
    '지시:',
    '- 한국어로 응답',
    '- cwd는 ~/coding-agent-wiki. 작업 시작 전 CLAUDE.md를 반드시 읽어 위키 구조·규칙을 확인하라.',
    args.isUrl
      ? '- URL Ingest 프로토콜을 따라라: WebFetch → 핵심 추출 → raw/ 저장 → wiki 페이지 생성/업데이트 → _index.md + log.md 갱신'
      : '- Research 프로토콜을 따라라: WebSearch(3-5개 소스) → WebFetch → 합성 → raw/ 저장 → wiki 페이지 생성/업데이트 → _index.md + log.md 갱신',
    '- 스레드 컨텍스트에 "📚 Wiki 신규 지식 후보" 브리핑이 있고 사용자가 번호(예: "1, 3")나 "전부"로 선택하면: 해당 번호의 URL을 찾아 각각 URL Ingest 프로토콜로 순서대로 처리하고, 완료 후 "N개 항목을 wiki에 추가했습니다" 요약.',
    '- 작업 완료 후 생성/업데이트한 페이지 목록을 한국어로 간결히 요약해서 출력하라.',
    '- 최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)',
    `- ${ARTIFACT_INSTRUCTION}`,
  ];
  return lines.join('\n');
}

/**
 * Build the systemAppend block for a wiki source scan run.
 * sourcesPath는 wiki-sources.json의 절대 경로.
 * Claude가 소스를 fetch하고 wiki 후보를 번호 목록으로 보고한다.
 */
export function buildWikiScanSystemAppend(sourcesPath: string): string {
  return [
    '지시:',
    '- 한국어로 응답',
    `- ${sourcesPath} 파일을 읽어 소스 목록을 가져온다.`,
    '- 소스가 비어있으면 "등록된 소스가 없습니다. data/wiki-sources.json에 소스를 추가해주세요." 만 출력하고 종료.',
    '- 각 소스의 RSS/URL에서 최근 7일 이내 신규 컨텐츠를 탐색한다. RSS feed URL이 있으면 우선 WebFetch 시도. WebFetch 실패(차단·타임아웃) 시 `curl -A "Mozilla/5.0" <url>` → WebSearch 순으로 즉시 우회 (사용자 재지시 불필요).',
    '- wiki에 추가할 가치가 있는 상위 5~10개 항목을 선정한다 (독창적 인사이트, 실용적 지식, 최신 트렌드 기준).',
    '- 다음 형식으로 보고한다 (항목이 없으면 "최근 7일 내 신규 항목이 없습니다." 출력):\n\n## 📚 Wiki 신규 지식 후보 — {오늘날짜}\n**탐색 소스**: N개 | **신규 항목**: M개\n\n### 1. [제목]\n- 🔗 URL\n- 📅 날짜\n- **소스**: 소스명\n- **추천 이유**: 한 줄\n- **요약**: 2~3문장\n\n### 2. ...\n\n---\n> wiki에 적재할 항목을 이 스레드에 번호로 알려주세요 (예: "1, 3 인제스트" / "전부다" / "패스")',
    '- 최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)',
  ].join('\n');
}

/**
 * Build the systemAppend block for a claw self-maintenance run.
 *
 * - cwd는 claw repo 자체 (`/Users/sumin/repos/greatSumini/claw`)
 * - 작업 후 commit & push
 * - 빌드 필요한 변경(소스/설정/빌드 파이프라인)이라면 응답 마지막에 마커 출력 → claw가 재실행
 */
export function buildClawMaintenanceSystemAppend(
  args: ClawMaintenancePromptArgs,
): string {
  const memBlock = formatMemoryBlock(args.memories ?? []);
  const lines: string[] = [];
  if (memBlock) lines.push(memBlock);
  lines.push('지시:');
  lines.push('- 한국어로 응답');
  lines.push(
    '- 이 세션은 claw 자체 유지보수 전용. cwd는 claw repo (`greatSumini/claw`). 다른 repo 작업 필요해 보이면 사용자에게 안내만.',
  );
  lines.push(
    '- 작업 끝나면 의미 단위로 git commit & push까지 완수. 첫 push 전: (1) `gh auth setup-git` 실행 (GH_TOKEN 자동 인식, idempotent). (2) Windows/NT AUTHORITY\\\\SYSTEM 환경이면 SSH push 대신 HTTPS 사용 — `git remote get-url origin`으로 확인 후 SSH URL(`git@github.com:...`)이면 `git remote set-url origin https://github.com/<owner>/<repo>` 전환 후 push. 실패 시 강행 금지(-f X), 보고만.',
  );
  lines.push(
    '- 소스/설정 변경(`src/**`, `package.json`, `tsconfig.json` 등 빌드 산출물에 영향)이면 `pnpm build`까지 완료해라. 그리고 **소스/설정 변경이면 예외 없이 응답의 마지막 줄에 다음 마커를 출력**: `' +
      CLAW_RESTART_MARKER +
      '`. 마커는 claw가 검출해서 본문에서 제거 후 `launchctl kickstart -k gui/<uid>/com.claw`로 자동 재시작한다. (README/문서/테스트만 수정한 경우 마커 출력 불필요) **중요: 마커만 단독으로 출력하지 말 것. 반드시 마커 앞에 사람이 읽을 수 있는 응답 텍스트를 포함해야 한다 — 마커는 제거되므로 텍스트가 없으면 Discord에 빈 메시지가 전송된다.**',
  );
  lines.push('- 최종 답변은 핵심만 간결히 (Discord에 그대로 전달됨, 2000자 이상 시 자동 분할됨)');
  lines.push(
    '- 완료 메시지 끝에 재시작 여부를 반드시 명시: "재시작: 트리거됨" 또는 "재시작: 불필요 (문서/테스트만 변경)"',
  );
  lines.push(`- ${ARTIFACT_INSTRUCTION}`);
  if (args.isContinuation) {
    lines.push('- (이전 대화 이어가기 모드 — 같은 thread 안에서의 후속 메시지)');
  }
  return lines.join('\n');
}
