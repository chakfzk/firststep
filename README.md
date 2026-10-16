# 한글 뷰어 (HWP·HWPX 웹앱)

아이폰 Safari에서 HWP·HWPX 문서를 열어 보고, HWPX 문서의 글자를 고쳐 저장하는 웹앱(PWA)이다.
파일은 브라우저 안에서만 처리되며 서버로 전송되지 않는다.

## 기능

| 형식 | 보기 | 편집 |
| --- | --- | --- |
| HWPX | 지원(문단·글자 모양, 표, 그림, 글상자 글) | 기존 글자 수정 후 HWPX로 저장 |
| HWP 5.0 | 지원([hwp.js](https://github.com/hahnlee/hwp.js) 사용) | 미지원 |

## 알려진 한계

- 화면 맞춤형 흐름 배치이므로 원본과 쪽 나눔·줄 바꿈 위치가 다를 수 있다.
- 머리말·꼬리말, 각주, 자동 번호·글머리표, 도형 그림, 글자 장평은 표시하지 않는다.
- 편집은 기존 글자의 수정만 가능하다. 문단 추가·삭제, 빈 칸에 새 글 입력, 서식 변경은 지원하지 않는다.
- 배포용(열람 제한) HWP 문서는 열 수 없다.

## 개발

```sh
npm install
npm run dev      # 개발 서버
npm run build    # dist/ 에 정적 파일 생성
```

`main` 또는 `master` 브랜치에 푸시하면 `.github/workflows/deploy.yml`이 GitHub Pages로 배포한다
(저장소 Settings → Pages → Source를 "GitHub Actions"로 설정해야 한다).
