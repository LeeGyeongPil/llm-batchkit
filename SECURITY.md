# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

## 이 도구가 다루는 것 / What this tool handles
- 실제 API 키는 환경변수(`OPENAI_API_KEY`)로만 읽고 파일에 쓰지 않으며, `Authorization` 헤더로만 보냅니다. / Real API keys are read from environment variables only, never written to files.
- `mock-server` 는 127.0.0.1 에만 바인딩합니다. / `mock-server` binds to 127.0.0.1 only.
- 실제 API 경로(`submit`/`collect`)는 mock 으로만 검증했습니다. 작은 파일로 먼저 시험하세요. / The real API path has only been verified against the mock; try a small file first.
