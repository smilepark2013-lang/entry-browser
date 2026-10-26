# DEPLOY.md — 배포 순서

처음 한 번 하는 일과, 새 버전을 낼 때마다 하는 일입니다. 위에서부터 차례로.

## 0. 올리기 전에 (매번)

```powershell
npm ci
npm run release        # 엔트리 작품 빌드 → 시뮬레이터 검사 → 앱 빌드 → dist/SHA256SUMS.txt
```

- `dist/win-unpacked/Entry Browser Relay.exe` 를 켜서 고지문 → 창 고르기 → 왕복 한 번을 확인합니다.
- `entry/build/entry-browser.ent` 를 엔트리에서 열어 시작 페이지 → 웹 페이지 하나 → 뒤로가 되는지 봅니다.
- 버전을 올렸다면 `package.json` 의 `version` 을 고칩니다 (예: `0.1.1`).

## 1. 저장소 만들기 (처음 한 번)

`gh` 로 로그인했다면 한 번에 (저장소 만들기 + 첫 푸시):
```powershell
git init -b main
git add .
git commit -m "Entry Browser Relay 0.1.0"
gh repo create smilepark2013/entry-browser --public --source . --remote origin --push
```

아니면 직접:
1. GitHub 에서 **public** 저장소 `smilepark2013/entry-browser` 를 만듭니다 (README·라이선스는 만들지 않음 — 이미 있습니다).
2. 이 폴더에서:
   ```powershell
   git init -b main
   git add .
   git commit -m "Entry Browser Relay 0.1.0"
   git remote add origin https://github.com/smilepark2013/entry-browser.git
   git push -u origin main
   ```
   `.gitignore` 가 `node_modules/` · `dist/` · `entry/build/` · `.claude/` 를 뺍니다.
   올라가는 파일을 먼저 보려면 `git status` 로 확인하세요.

## 2. 소개 페이지 켜기 (처음 한 번)

GitHub 저장소 → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / 폴더 `/docs` → Save.
`gh` 로는:
```powershell
gh api -X POST repos/smilepark2013/entry-browser/pages -f "source[branch]=main" -f "source[path]=/docs"
```
몇 분 뒤 <https://smilepark2013.github.io/entry-browser/> 에 뜹니다.

## 3. 릴리스 (버전마다)

```powershell
git tag v0.1.0
git push origin v0.1.0
```

- `.github/workflows/release.yml` 이 Windows 에서 빌드·검사하고 Releases 에 4개 파일과 체크섬을 올립니다
  (Actions 탭에서 진행 상황과 로그를 볼 수 있습니다. 10분 안팎).
- 끝나면 릴리스 페이지에서 파일 4개(설치판 · portable · `.ent` · `SHA256SUMS.txt`)가 붙었는지,
  소개 페이지의 다운로드 단추가 받아지는지 확인합니다 (`releases/latest/download/...` 로 연결됩니다).
- 받은 파일 하나를 `Get-FileHash` 로 `SHA256SUMS.txt` 와 견줘 봅니다.

## 4. 엔트리 작품 올리기 (처음 한 번, 작품이 바뀌면 다시)

1. 릴리스의 `entry-browser.ent` (또는 `entry/build/entry-browser.ent`)를 엔트리에서 [작품 불러오기].
2. 작품 이름: `Entry Browser (실험용)` — 설명은 [`docs/entry-project.md`](docs/entry-project.md) 를 붙여 넣습니다.
3. 공유하고 작품 주소(`https://playentry.org/project/...`)를 얻습니다.
4. 그 주소를 두 곳에 넣고 다시 올립니다:
   - `docs/index.html` 의 `<a ... id="entry-btn" data-url="">` → `data-url="<작품 주소>"`
   - `README.md` 맨 위 링크 줄 (원하면)
   ```powershell
   git commit -am "엔트리 작품 링크" ; git push
   ```

## 알아 둘 것

- **코드 서명이 없습니다** — SmartScreen 경고가 뜹니다. README·소개 페이지·릴리스 설명에 안내가 있습니다.
- **Electron 보안 업데이트** — 렌더 모드는 Chromium 으로 남의 사이트 코드를 실행합니다. Electron 새 버전이
  나오면 `npm update electron` → 검사 → 새 릴리스를 권합니다.
- 엔트리 작품의 글꼴은 Windows 의 맑은 고딕 기준으로 맞춰져 있습니다 (README 「글자 폭 표」).
