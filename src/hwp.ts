// HWP 5.0(바이너리) 문서는 hwp.js로 열람만 지원한다.
import { Viewer } from 'hwp.js';

/** 배포용 문서는 본문이 암호화된 ViewText 저장소에 들어 있다(디렉터리 이름은 UTF-16LE). */
function isDistribution(bytes: Uint8Array) {
  const name = Array.from('ViewText').flatMap((c) => [c.charCodeAt(0), 0]);
  outer: for (let i = 0; i <= bytes.length - name.length; i++) {
    for (let j = 0; j < name.length; j++) if (bytes[i + j] !== name[j]) continue outer;
    return true;
  }
  return false;
}

export function renderHwp(container: HTMLElement, data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  if (isDistribution(bytes)) {
    throw new Error('배포용(열람 제한) 문서는 열 수 없습니다. 한컴오피스 앱을 이용해 주세요.');
  }
  try {
    new Viewer(container, bytes, { type: 'array' });
  } catch (e) {
    container.replaceChildren();
    throw new Error('HWP 파일을 해석하지 못했습니다. 지원하지 않는 요소가 포함되었을 수 있습니다.', { cause: e });
  }
}
