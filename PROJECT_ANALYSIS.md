# EcclesiaBench 프로젝트 분석

## 1) 프로젝트 목적
EcclesiaBench는 가톨릭 교회 사법(교회법/교리) 및 한국 민법 영역을 대상으로 LLM 기반 RAG 응답의 **정확성·인용 적합성·안전성**을 평가하는 벤치마크 프레임워크다.

## 2) 현재 아키텍처 요약
- API는 FastAPI 기반이며, 추론/문서/테스트케이스/리뷰/검색/잡 등 다수 라우터를 하나의 서비스로 통합한다.
- 생명주기(lifespan)에서 persistence를 구성하고, 개발환경에서는 DB 초기화를 수행한다.
- 요청 제어 관점에서 API 키 미들웨어와 전역 rate limit 미들웨어를 제공한다.
- 헬스체크는 Qdrant/LiteLLM/MLflow 외부 의존성을 개별 검사한다.

## 3) 핵심 처리 파이프라인
### 3.1 Retrieval
- 검색 파이프라인은 임베딩 → Qdrant dense search(top-k) → rerank(top-k) 구조다.
- `CorpusProfile(A/B)`를 검색 필터에 반영해 소스 타입·권위 수준을 강제한다.
- 파이프라인 컴포넌트(Embedder, Reranker, Qdrant client)는 주입 가능하게 설계되어 테스트가 용이하다.

### 3.2 Inference
- Inference는 retrieval 결과(chunks)를 입력받아 프롬프트 렌더링 후 LLM 호출을 수행한다.
- Profile B는 추가 슬롯(`is_dual_effect`, `category`)을 필요로 하며, 미제공 시 자동 분류로 채운다.
- 응답 후 면책 고지를 강제하고 인용 핸들을 추출해 후속 평가 메트릭과 연결한다.

### 3.3 Persistence
- ORM은 문서/청크/테스트케이스/테스트런/리뷰/감사로그 중심의 평가 데이터 모델을 제공한다.
- 다수 테이블에 `tenant_id`가 있어 멀티테넌시 확장을 고려한 구조다.
- 감사 로그에는 원문 대신 해시와 분류 결과만 저장해 개인정보·고해성사 민감정보 정책을 반영한다.

## 4) 강점
1. **평가 도메인 특화성**: Profile A/B, authority/source filter, citation verifier 등 도메인 제약이 코드로 반영되어 있다.
2. **모듈 분리**: retrieval/inference/evaluation/persistence/workflow 경계가 비교적 명확하다.
3. **운영 확장성**: LiteLLM, MLflow, Prefect, Argilla, Qdrant를 분리해 실험/운영 파이프라인을 확장하기 쉽다.
4. **테스트 커버리지 폭**: 라우팅·검색·추론·보안·워크플로우·마이그레이션까지 테스트 파일이 폭넓다.

## 5) 잠재 리스크/개선 포인트
1. **단일 서비스 응집도 증가**: `api/main.py`가 라우터를 다수 포함해 성장 시 배포 단위 분할(예: inference API vs admin API) 검토가 필요하다.
2. **외부 의존성 가용성 리스크**: 헬스체크가 다수 외부 서비스와 결합돼 로컬/CI 환경에서 degraded가 잦을 수 있으므로 모드별 헬스 전략이 유리하다.
3. **설정 복잡도 증가**: `.env` 변수와 서비스 조합이 많아 환경 템플릿(개발/CI/운영) 분리 자동화가 필요하다.
4. **프롬프트/정책 drift 관리**: prompt 문서 기반 규칙이 많아 버전 태깅 및 회귀 기준선(golden set) 운영을 강화할 필요가 있다.

## 6) 추천 우선순위 액션
1. **운영 프로파일 정교화**: `app_env`별 헬스체크/의존성 strictness 차등화.
2. **품질 게이트 고도화**: PR 단계에서 `pytest + ruff + mypy` 표준 파이프라인 고정.
3. **관측성 강화**: inference/retrieval span 속성 표준화 및 실패 taxonomy 대시보드화.
4. **데이터 거버넌스**: 감사 로그 chain hash 검증 작업을 주기 배치화해 변조 탐지 자동화.

## 7) 종합 진단
현재 코드는 “RAG 실험용 프로토타입”을 넘어서, **도메인 특화 평가 플랫폼의 초기 운영형 구조**에 진입한 상태다. 다음 단계의 핵심은 기능 추가보다도 환경 표준화·관측성·정책 검증 자동화를 통해 재현성과 신뢰도를 높이는 것이다.
