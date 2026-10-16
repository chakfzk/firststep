import './style.css';
import { openHwpx, type HwpxDocument } from './hwpx';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const view = $('view');
const docEl = $('doc');
const emptyEl = $('empty');
const nameEl = $('name');
const editBtn = $<HTMLButtonElement>('edit');
const saveBtn = $<HTMLButtonElement>('save');
const dialog = $<HTMLDialogElement>('save-dialog');

let current: { name: string; hwpx?: HwpxDocument } | null = null;
let editing = false;
let savedBlob: File | null = null;

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

/** 문서를 화면 폭에 맞춰 축소한다(확대는 하지 않음). */
function fit() {
  docEl.style.zoom = '1';
  const w = docEl.scrollWidth;
  if (!w) return;
  docEl.style.zoom = String(Math.min(1, (view.clientWidth - 16) / w));
}
addEventListener('resize', fit);

function confirmDiscard() {
  return !current?.hwpx?.isDirty() || confirm('저장하지 않은 수정 내용이 있습니다. 버리고 계속할까요?');
}

async function load(file: File) {
  if (!confirmDiscard()) return;
  const data = await file.arrayBuffer();
  const sig = new Uint8Array(data.slice(0, 4));
  const isZip = sig[0] === 0x50 && sig[1] === 0x4b; // HWPX(ZIP)
  const isCfb = sig[0] === 0xd0 && sig[1] === 0xcf; // HWP 5.0(OLE)
  setEditing(false);
  docEl.replaceChildren();
  current = null;
  emptyEl.hidden = true;
  nameEl.textContent = '불러오는 중…';
  // 표시가 화면에 그려진 뒤 무거운 해석을 시작한다.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  try {
    if (isZip) {
      const hwpx = await openHwpx(data);
      docEl.append(hwpx.element);
      current = { name: file.name, hwpx };
    } else if (isCfb) {
      const { renderHwp } = await import('./hwp');
      renderHwp(docEl, data);
      current = { name: file.name };
    } else {
      throw new Error('HWP 또는 HWPX 파일이 아닙니다.');
    }
  } catch (e) {
    docEl.replaceChildren();
    emptyEl.hidden = false;
    nameEl.textContent = '한글 뷰어';
    editBtn.hidden = saveBtn.hidden = true;
    toast(e instanceof Error ? e.message : String(e));
    console.error(e);
    return;
  }
  nameEl.textContent = file.name;
  editBtn.hidden = saveBtn.hidden = !current.hwpx;
  if (!current.hwpx) toast('HWP 파일은 보기만 가능합니다. 편집하려면 한글에서 HWPX로 저장해 주세요.');
  view.scrollTo(0, 0);
  requestAnimationFrame(fit);
}

function setEditing(on: boolean) {
  editing = on;
  current?.hwpx?.setEditable(on);
  editBtn.textContent = on ? '편집 끝' : '편집';
  editBtn.classList.toggle('active', on);
  if (on) toast('글자를 눌러 수정하세요. 문단 추가·삭제는 지원하지 않습니다.');
}

$('open').addEventListener('click', () => fileInput.click());
$('open-big').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) load(f);
  fileInput.value = '';
});
editBtn.addEventListener('click', () => setEditing(!editing));

// 수정 시 저장 버튼 활성화, 줄바꿈 입력 차단(문단 구조는 유지)
docEl.addEventListener('input', () => (saveBtn.disabled = !current?.hwpx?.isDirty()));
docEl.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') e.preventDefault();
});
docEl.addEventListener('paste', (e) => {
  if (!editing) return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain').replace(/[\r\n]+/g, ' ') ?? '';
  document.execCommand('insertText', false, text);
});

saveBtn.addEventListener('click', async () => {
  if (!current?.hwpx) return;
  saveBtn.disabled = true;
  try {
    const blob = await current.hwpx.save();
    const name = current.name.replace(/\.hwpx?$/i, '') + '.hwpx';
    savedBlob = new File([blob], name, { type: 'application/hwp+zip' });
    $<HTMLButtonElement>('share').hidden = !navigator.canShare?.({ files: [savedBlob] });
    dialog.showModal();
  } catch (e) {
    saveBtn.disabled = false;
    toast('저장 실패: ' + (e instanceof Error ? e.message : e));
  }
});

// 공유 시트는 사용자 탭 직후에만 열리므로 저장 준비 후 한 번 더 누르게 한다.
$('share').addEventListener('click', async () => {
  dialog.close();
  if (!savedBlob) return;
  try {
    await navigator.share({ files: [savedBlob] });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast('공유하지 못했습니다. 다운로드를 이용해 주세요.');
  }
});
$('download').addEventListener('click', () => {
  dialog.close();
  if (!savedBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(savedBlob);
  a.download = savedBlob.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$('cancel').addEventListener('click', () => dialog.close());

addEventListener('beforeunload', (e) => {
  if (current?.hwpx?.isDirty()) e.preventDefault();
});

// 데스크톱 브라우저용 끌어다 놓기
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) load(f);
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js');
}
