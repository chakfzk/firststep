// HWPX(KS X 6101/OWPML) 문서를 읽어 HTML로 렌더링하고, 텍스트 수정 후 다시 저장한다.
// 편집은 원본 XML의 텍스트 노드만 바꾸는 방식이라 서식·표·그림 정보는 그대로 보존된다.
import JSZip from 'jszip';

const HU_PER_PX = 75; // 1인치 = 7200 HWPUNIT = 96px
const hu = (v: string | null | undefined) => (Number(v) || 0) / HU_PER_PX;

/** 네임스페이스 버전(2011/2016 등)에 관계없이 localName으로 찾는다. */
const kids = (el: Element, name?: string) =>
  Array.from(el.children).filter((c) => !name || c.localName === name);
const kid = (el: Element, name: string) => kids(el, name)[0];
const desc = (el: Element | Document, name: string) =>
  Array.from(el.getElementsByTagName('*')).filter((c) => c.localName === name);

interface EditableText {
  node: Text;
  para: Element;
  span: HTMLElement;
  dirty: boolean;
}

export interface HwpxDocument {
  title: string;
  element: HTMLElement;
  pageWidth: number;
  setEditable(on: boolean): void;
  isDirty(): boolean;
  save(): Promise<Blob>;
}

export async function openHwpx(data: ArrayBuffer): Promise<HwpxDocument> {
  const zip = await JSZip.loadAsync(data);
  const readXml = async (path: string) => {
    const f = zip.file(path);
    if (!f) throw new Error(`${path} 파일이 없습니다.`);
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(`${path} 해석 실패`);
    return doc;
  };

  // content.hpf: 섹션 순서와 그림 파일 목록
  const hpfPath =
    Object.keys(zip.files).find((p) => /content\.hpf$/i.test(p)) ?? 'Contents/content.hpf';
  const hpf = zip.file(hpfPath) ? await readXml(hpfPath) : null;
  const items = new Map<string, { href: string; type: string }>();
  let title = '';
  let sectionPaths: string[] = [];
  if (hpf) {
    for (const it of desc(hpf, 'item')) {
      items.set(it.getAttribute('id') ?? '', {
        href: it.getAttribute('href') ?? '',
        type: it.getAttribute('media-type') ?? '',
      });
    }
    title = desc(hpf, 'title')[0]?.textContent?.trim() ?? '';
    sectionPaths = desc(hpf, 'itemref')
      .map((r) => items.get(r.getAttribute('idref') ?? '')?.href ?? '')
      .filter((h) => /section\d+\.xml$/i.test(h));
  }
  if (!sectionPaths.length) {
    sectionPaths = Object.keys(zip.files)
      .filter((p) => /^Contents\/section\d+\.xml$/i.test(p))
      .sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));
  }
  if (!sectionPaths.length) throw new Error('본문(section) 파일을 찾지 못했습니다.');

  const header = await readXml('Contents/header.xml');
  const sections = await Promise.all(sectionPaths.map(async (p) => ({ path: p, doc: await readXml(p) })));

  const images = await loadImages(zip, items, sections.map((s) => s.doc));
  const css = buildStyles(header);

  const root = document.createElement('div');
  root.className = 'hwpx';
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);

  const editables: EditableText[] = [];
  const r = new Renderer(images, editables);
  let pageWidth = 0;
  for (const { doc } of sections) {
    const paper = r.section(doc.documentElement);
    pageWidth = Math.max(pageWidth, r.pageWidth);
    root.append(paper);
  }

  return {
    title,
    element: root,
    pageWidth,
    setEditable(on) {
      root.classList.toggle('editing', on);
      for (const e of editables) e.span.contentEditable = on ? 'true' : 'false';
    },
    isDirty: () => editables.some((e) => e.dirty),
    async save() {
      const touched = new Set<Element>();
      for (const e of editables) {
        if (!e.dirty) continue;
        e.node.data = (e.span.textContent ?? '').replace(/[\r\n]/g, '');
        touched.add(e.para);
      }
      // 줄 배치 캐시(linesegarray)는 글자가 바뀌면 맞지 않으므로 지워서 한글이 다시 계산하게 한다.
      for (const p of touched) for (const ls of kids(p, 'linesegarray')) ls.remove();
      for (const s of sections) {
        let xml = new XMLSerializer().serializeToString(s.doc);
        if (!xml.startsWith('<?xml')) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + xml;
        zip.file(s.path, xml);
      }
      // mimetype은 압축 없이 첫 항목으로 두어야 한다(기존 위치 유지).
      const mt = zip.file('mimetype');
      if (mt) zip.file('mimetype', await mt.async('string'), { compression: 'STORE' });
      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        mimeType: 'application/hwp+zip',
      });
      for (const e of editables) e.dirty = false;
      return blob;
    },
  };
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp',
};

async function loadImages(
  zip: JSZip,
  items: Map<string, { href: string }>,
  docs: Document[],
) {
  const urls = new Map<string, string>();
  const ids = new Set(docs.flatMap((d) => desc(d, 'img').map((i) => i.getAttribute('binaryItemIDRef') ?? '')));
  await Promise.all(
    [...ids].map(async (id) => {
      const href = items.get(id)?.href ?? Object.keys(zip.files).find((p) => p.startsWith(`BinData/${id}.`));
      const ext = href?.split('.').pop()?.toLowerCase() ?? '';
      const f = href && zip.file(href);
      if (!f || !IMAGE_TYPES[ext]) return; // WMF/EMF 등 브라우저가 못 그리는 형식은 자리표시로 남긴다
      const blob = new Blob([await f.async('arraybuffer')], { type: IMAGE_TYPES[ext] });
      urls.set(id, URL.createObjectURL(blob));
    }),
  );
  return urls;
}

// ---------- header.xml → CSS ----------

const SERIF = /바탕|명조|Batang|Myeongjo|Times|serif/i;
const SANS_STACK = '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif';
const SERIF_STACK = '"AppleMyungjo","Nanum Myeongjo","Noto Serif KR",serif';

function buildStyles(header: Document): string {
  const out: string[] = [];
  const fonts: Record<string, Map<string, string>> = {};
  for (const ff of desc(header, 'fontface')) {
    const m = new Map<string, string>();
    for (const f of kids(ff, 'font')) m.set(f.getAttribute('id') ?? '', f.getAttribute('face') ?? '');
    fonts[ff.getAttribute('lang') ?? ''] = m;
  }

  for (const cp of desc(header, 'charPr')) {
    const id = cp.getAttribute('id');
    const s: string[] = [`font-size:${(Number(cp.getAttribute('height')) || 1000) / 100}pt`];
    const color = cp.getAttribute('textColor');
    if (color && color !== 'none') s.push(`color:${color}`);
    const shade = cp.getAttribute('shadeColor');
    if (shade && shade !== 'none' && shade.toUpperCase() !== '#FFFFFF') s.push(`background:${shade}`);
    const ref = kid(cp, 'fontRef');
    const face = fonts.HANGUL?.get(ref?.getAttribute('hangul') ?? '') ?? '';
    const latin = fonts.LATIN?.get(ref?.getAttribute('latin') ?? '') ?? '';
    const stack = SERIF.test(face) ? SERIF_STACK : SANS_STACK;
    s.push(`font-family:${[latin, face].filter(Boolean).map((f) => `"${f}"`).join(',')}${latin || face ? ',' : ''}${stack}`);
    if (kid(cp, 'bold')) s.push('font-weight:bold');
    if (kid(cp, 'italic')) s.push('font-style:italic');
    const deco: string[] = [];
    const ul = kid(cp, 'underline');
    if (ul && ul.getAttribute('type') !== 'NONE') deco.push(ul.getAttribute('type') === 'TOP' ? 'overline' : 'underline');
    const so = kid(cp, 'strikeout');
    if (so && !['NONE', '3D'].includes(so.getAttribute('shape') ?? 'NONE')) deco.push('line-through');
    if (deco.length) s.push(`text-decoration:${deco.join(' ')}`);
    const sp = Number(kid(cp, 'spacing')?.getAttribute('hangul')) || 0;
    if (sp) s.push(`letter-spacing:${sp / 100}em`);
    if (kid(cp, 'supscript')) s.push('vertical-align:super;font-size:smaller');
    if (kid(cp, 'subscript')) s.push('vertical-align:sub;font-size:smaller');
    out.push(`.hwpx .c${id}{${s.join(';')}}`);
  }

  const ALIGN: Record<string, string> = {
    LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFY: 'justify',
    DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify',
  };
  for (const pp of desc(header, 'paraPr')) {
    const id = pp.getAttribute('id');
    const s: string[] = [`text-align:${ALIGN[kid(pp, 'align')?.getAttribute('horizontal') ?? ''] ?? 'justify'}`];
    // hp:switch 안의 첫 번째(hp:case) 값을 사용한다.
    const margin = desc(pp, 'margin')[0];
    if (margin) {
      const v = (n: string) => {
        const e = kid(margin, n);
        return e && (e.getAttribute('unit') ?? 'HWPUNIT') === 'HWPUNIT' ? hu(e.getAttribute('value')) : 0;
      };
      const indent = v('intent');
      // 음수 들여쓰기는 한글의 '내어쓰기'에 해당한다.
      s.push(`padding-left:${v('left') + Math.max(0, -indent)}px`, `padding-right:${v('right')}px`,
        `text-indent:${indent}px`, `margin-top:${v('prev')}px`, `margin-bottom:${v('next')}px`);
    }
    const ls = desc(pp, 'lineSpacing')[0];
    if (ls) {
      const val = Number(ls.getAttribute('value')) || 160;
      const type = ls.getAttribute('type');
      if (type === 'PERCENT') s.push(`line-height:${val / 100}`);
      else if (type === 'FIXED') s.push(`line-height:${hu(String(val))}px`);
      else if (type === 'BETWEEN_LINES') s.push(`line-height:calc(1.2em + ${hu(String(val))}px)`);
    }
    out.push(`.hwpx .p${id}{${s.join(';')}}`);
  }

  const LINE: Record<string, string> = { NONE: 'none', SOLID: 'solid', DASH: 'dashed', DOT: 'dotted', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed', DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double', CIRCLE: 'dotted' };
  for (const bf of desc(header, 'borderFill')) {
    const id = bf.getAttribute('id');
    const s: string[] = [];
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const b = kid(bf, `${side}Border`);
      const type = LINE[b?.getAttribute('type') ?? 'NONE'] ?? 'solid';
      if (!b || type === 'none') { s.push(`border-${side}:none`); continue; }
      const mm = parseFloat(b.getAttribute('width') ?? '0.1') || 0.1;
      const px = Math.max(type === 'double' ? 3 : 1, Math.round((mm * 96) / 25.4));
      s.push(`border-${side}:${px}px ${type} ${b.getAttribute('color') ?? '#000'}`);
    }
    const face = desc(bf, 'winBrush')[0]?.getAttribute('faceColor');
    if (face && face !== 'none') s.push(`background:${face}`);
    else {
      const grad = desc(bf, 'gradation')[0];
      const c = grad && kids(grad, 'color')[0]?.getAttribute('value');
      if (c) s.push(`background:${c}`);
    }
    out.push(`.hwpx .b${id}{${s.join(';')}}`);
  }
  return out.join('\n');
}

// ---------- section.xml → HTML ----------

class Renderer {
  pageWidth = 0;
  constructor(private images: Map<string, string>, private editables: EditableText[]) {}

  section(sec: Element): HTMLElement {
    const paper = document.createElement('div');
    paper.className = 'paper';
    const pagePr = desc(sec, 'pagePr')[0];
    if (pagePr) {
      let w = hu(pagePr.getAttribute('width')), h = hu(pagePr.getAttribute('height'));
      if (pagePr.getAttribute('landscape') === 'NARROWLY' && w < h) [w, h] = [h, w];
      const m = kid(pagePr, 'margin');
      const [l, r, t, b] = ['left', 'right', 'top', 'bottom'].map((k) => hu(m?.getAttribute(k)));
      const top = t + hu(m?.getAttribute('header')), bottom = b + hu(m?.getAttribute('footer'));
      paper.style.cssText = `width:${w}px;min-height:${h}px;padding:${top}px ${r}px ${bottom}px ${l}px`;
      this.pageWidth = w;
    } else {
      this.pageWidth = 794; // A4
      paper.style.cssText = 'width:794px;padding:72px';
    }
    this.paragraphs(sec, paper);
    return paper;
  }

  paragraphs(container: Element, out: HTMLElement) {
    for (const p of kids(container, 'p')) out.append(this.paragraph(p));
  }

  paragraph(p: Element): HTMLElement {
    const div = document.createElement('div');
    div.className = `para p${p.getAttribute('paraPrIDRef')}`;
    if (p.getAttribute('pageBreak') === '1') div.classList.add('page-break');
    for (const run of kids(p, 'run')) {
      const cls = `c${run.getAttribute('charPrIDRef')}`;
      let span: HTMLElement | null = null;
      const textSpan = () => {
        if (!span) {
          span = document.createElement('span');
          span.className = cls;
          div.append(span);
        }
        return span;
      };
      for (const child of kids(run)) {
        if (child.localName === 't') this.text(child, p, textSpan());
        else {
          const obj = this.object(child);
          if (obj) {
            obj.classList.add(cls);
            div.append(obj);
            span = null;
          }
        }
      }
    }
    // 빈 문단도 한 줄 높이를 차지하게 한다.
    if (!div.textContent && !div.querySelector('img,table,.box')) div.append(document.createElement('br'));
    return div;
  }

  text(t: Element, para: Element, out: HTMLElement) {
    for (const n of Array.from(t.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        const span = document.createElement('span');
        span.className = 'ed';
        span.textContent = (n as Text).data;
        out.append(span);
        const entry: EditableText = { node: n as Text, para, span, dirty: false };
        this.editables.push(entry);
        span.addEventListener('input', () => (entry.dirty = true));
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const name = (n as Element).localName;
        if (name === 'lineBreak') out.append(document.createElement('br'));
        else if (name === 'tab') out.append(Object.assign(document.createElement('span'), { className: 'tab' }));
        else if (name === 'nbSpace') out.append(' ');
        else if (name === 'fwSpace') out.append('　');
        else if (name === 'hyphen') out.append('-');
      }
    }
  }

  object(el: Element): HTMLElement | null {
    switch (el.localName) {
      case 'tbl': return this.table(el);
      case 'pic': return this.picture(el);
      case 'container': {
        const box = document.createElement('div');
        box.className = 'box group';
        for (const c of kids(el)) { const o = this.object(c); if (o) box.append(o); }
        return box.childElementCount ? box : null;
      }
      case 'rect': case 'ellipse': case 'polygon': case 'curve': case 'arc': case 'line': case 'connectLine': {
        // 도형은 그리지 않고, 글상자 안의 글만 보여 준다.
        const dt = kid(el, 'drawText');
        const sub = dt && kid(dt, 'subList');
        if (!sub) return null;
        const box = document.createElement('div');
        box.className = 'box textbox';
        const w = this.size(el).w;
        if (w) box.style.maxWidth = `${w}px`;
        this.paragraphs(sub, box);
        return box;
      }
      case 'equation': {
        const s = document.createElement('span');
        s.className = 'equation';
        s.textContent = desc(el, 'script')[0]?.textContent ?? '';
        return s;
      }
      default: return null; // secPr, ctrl(머리말·각주 등), 필드 표시 등은 생략
    }
  }

  size(el: Element) {
    const pick = (n: string) => {
      const e = kid(el, n);
      const w = hu(e?.getAttribute('width')), h = hu(e?.getAttribute('height'));
      return w && h ? { w, h } : null;
    };
    return pick('sz') ?? pick('curSz') ?? pick('orgSz') ?? { w: 0, h: 0 };
  }

  inline(el: Element) {
    return kid(el, 'pos')?.getAttribute('treatAsChar') === '1';
  }

  picture(el: Element): HTMLElement {
    const { w, h } = this.size(el);
    const id = desc(el, 'img')[0]?.getAttribute('binaryItemIDRef') ?? '';
    const url = this.images.get(id);
    let node: HTMLElement;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      node = img;
    } else {
      node = document.createElement('div');
      node.className = 'img-missing';
      node.textContent = '표시할 수 없는 그림';
    }
    node.classList.add(this.inline(el) ? 'inline-obj' : 'block-obj');
    if (w) node.style.width = `${w}px`;
    if (h) node.style.height = `${h}px`;
    return node;
  }

  table(el: Element): HTMLElement {
    const table = document.createElement('table');
    table.className = `tbl b${el.getAttribute('borderFillIDRef')}`;
    table.classList.add(this.inline(el) ? 'inline-obj' : 'block-obj');
    const { w } = this.size(el);
    if (w) table.style.width = `${w}px`;
    if (kid(el, 'pos')?.getAttribute('horzAlign') === 'CENTER') table.classList.add('center');
    const inMargin = kid(el, 'inMargin');
    const tbody = document.createElement('tbody');
    for (const tr of kids(el, 'tr')) {
      const row = document.createElement('tr');
      for (const tc of kids(tr, 'tc')) {
        const td = document.createElement('td');
        td.className = `b${tc.getAttribute('borderFillIDRef')}`;
        const span = kid(tc, 'cellSpan');
        const cs = Number(span?.getAttribute('colSpan')) || 1, rs = Number(span?.getAttribute('rowSpan')) || 1;
        if (cs > 1) td.colSpan = cs;
        if (rs > 1) td.rowSpan = rs;
        const sz = kid(tc, 'cellSz');
        td.style.width = `${hu(sz?.getAttribute('width'))}px`;
        td.style.height = `${hu(sz?.getAttribute('height'))}px`;
        const m = tc.getAttribute('hasMargin') === '1' ? kid(tc, 'cellMargin') : inMargin ?? kid(tc, 'cellMargin');
        if (m) td.style.padding = ['top', 'right', 'bottom', 'left'].map((k) => `${hu(m.getAttribute(k))}px`).join(' ');
        const sub = kid(tc, 'subList');
        if (sub) {
          td.style.verticalAlign = ({ TOP: 'top', CENTER: 'middle', BOTTOM: 'bottom' } as Record<string, string>)[sub.getAttribute('vertAlign') ?? ''] ?? 'top';
          this.paragraphs(sub, td);
        }
        row.append(td);
      }
      tbody.append(row);
    }
    table.append(tbody);
    return table;
  }
}
