# Deploy Hub — 학교용 GitHub Pages 배포 시스템

학생·선생님이 웹페이지에서 파일을 올리거나 코드를 작성하면, **관리자 GitHub 계정**에 저장소를 만들고 GitHub Pages로 자동 배포합니다.
사용자는 Git이나 GitHub 계정이 없어도 됩니다.

```
[학생/선생님 브라우저]  ──▶  [Cloudflare Worker (API)]  ──▶  [GitHub API]
   index.html                 worker.js                       관리자 계정
   (GitHub Pages)             GitHub 토큰 보관               └ 저장소 생성 → Pages 배포
                                                                  https://<아이디>.github.io/<사이트이름>/
```

GitHub 토큰을 웹페이지에 넣으면 누구나 볼 수 있기 때문에, 토큰은 Cloudflare Worker(무료)에만 보관합니다.

## 기능

| 화면 | 기능 |
|---|---|
| 배포하기 | 파일·폴더·ZIP 드래그 앤 드롭, 코드 직접 작성(템플릿 4종, 실시간 미리보기), 주소 중복 실시간 확인, 진행 단계 표시, 완료 후 QR 코드 |
| 내 사이트 | 업데이트(재배포), 제목/작성자 수정, 삭제, 편집 키 확인, 백업 저장/불러오기, 편집 키로 다른 기기에서 불러오기 |
| 갤러리 | 전체 사이트 썸네일 미리보기, 검색, 정렬 |
| 관리자 | 통계, 전체 사이트 삭제, 편집 키 재발급(학생이 키를 잃어버렸을 때) |

- **접속 코드**: 새 사이트를 만들 때 필요한 공용 코드 (선생님이 학생들에게 알려 줌)
- **편집 키**: 사이트마다 자동 발급되는 개인 키. 만든 사람의 브라우저에 저장되며, 이 키가 있어야 수정·삭제할 수 있음
- 이 시스템이 만든 저장소에는 `deploy-hub` 토픽이 붙고, Worker는 이 토픽이 있는 저장소만 수정·삭제합니다. 관리자의 다른 저장소는 건드리지 않습니다.

## 설치 (약 15분)

### 1. GitHub 토큰 만들기

GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** → Generate new token

- Repository access: **All repositories**
- Repository permissions:
  - **Administration**: Read and write (저장소 생성·삭제)
  - **Contents**: Read and write (파일 업로드)
  - **Pages**: Read and write (Pages 켜기)
  - Metadata: Read-only (자동 선택됨)
- 만료일은 학기 단위로 설정하고, 만료 전에 새로 발급해서 Worker의 `GITHUB_TOKEN`을 교체하세요.

> Classic 토큰을 쓴다면 `public_repo`, `delete_repo` 권한을 선택하면 됩니다.

### 2. Cloudflare Worker 만들기

1. [dash.cloudflare.com](https://dash.cloudflare.com) 가입 → **Workers & Pages → Create → Create Worker**
2. 이름을 `deploy-hub`로 정하고 Deploy
3. **Edit code** → 기본 코드를 지우고 `worker.js` 내용을 붙여넣기 → Deploy
4. **Settings → Variables and Secrets**에 아래 값 추가

| 이름 | 종류 | 값 |
|---|---|---|
| `GITHUB_TOKEN` | Secret | 1단계에서 만든 토큰 |
| `GITHUB_OWNER` | Text | 내 GitHub 아이디 |
| `ACCESS_CODE` | Secret | 학생들에게 알려 줄 접속 코드 (예: `danggok2026`) |
| `ADMIN_CODE` | Secret | 관리자 코드 (길고 추측하기 어렵게) |
| `SIGNING_SECRET` | Secret | 아무 긴 무작위 문자열 (40자 이상 권장, **바꾸면 기존 편집 키가 모두 무효화됨**) |
| `RESERVED_NAMES` | Text | `deploy-hub` (프론트엔드 저장소 이름 등, 학생이 쓰면 안 되는 이름) |
| `ALLOWED_ORIGINS` | Text | `https://<내아이디>.github.io` (4단계 후 설정 권장) |

5. 브라우저에서 `https://deploy-hub.<내계정>.workers.dev/api/health` 를 열어 `{"ok":true,...}`가 나오면 성공

### 3. 프론트엔드에 서버 주소 넣기

`index.html` 안의 `CONFIG`를 수정합니다.

```js
const CONFIG = {
  API_BASE: 'https://deploy-hub.<내계정>.workers.dev',
  SITE_NAME: '우리학교 웹 배포',
};
```

### 4. 프론트엔드를 GitHub Pages로 올리기

1. GitHub에서 새 저장소 `deploy-hub` 생성 (Public)
2. **Add file → Upload files**로 `index.html` 업로드
3. 저장소 **Settings → Pages → Branch: main / (root)** → Save
4. 1~2분 뒤 `https://<내아이디>.github.io/deploy-hub/` 접속

이제 이 주소와 접속 코드를 학생들에게 알려 주면 됩니다.

## 로컬에서 미리보기

`API_BASE`가 비어 있으면 **데모 모드**로 동작합니다(이 브라우저에만 저장, 실제 배포 없음, 접속 코드 `demo`, 관리자 코드 `admin`).

```bash
powershell -ExecutionPolicy Bypass -File deploy-hub/serve.ps1
```

→ http://localhost:5173

오른쪽 위 ⚙️ 설정에서 서버 주소를 직접 넣어 실제 Worker와 연결해 테스트할 수도 있습니다.

## 운영 시 참고

- **모든 사이트는 공개 저장소**입니다. 학생들에게 개인정보를 올리지 않도록 안내하세요.
- 접속 코드는 학기·수업마다 바꾸는 것을 권장합니다 (Worker 변수만 바꾸면 됨, 기존 사이트에는 영향 없음).
- GitHub Pages 제한: 사이트당 1GB, 월 대역폭 약 100GB(소프트 제한). 학교 과제 수준에서는 충분합니다.
- 재배포하면 기존 파일이 **모두 새 파일로 교체**됩니다.
- 한 번에 올릴 수 있는 크기: 전체 50MB, 파일당 25MB, 최대 1000개 파일.
- Cloudflare Workers 무료 플랜: 하루 10만 요청. 한 번 배포에 대략 (파일 수 ÷ 40) + 30회 정도 사용합니다.
