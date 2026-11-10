import { renderAsync } from 'docx-preview';

async function preview() {
  const root = document.getElementById('pages')!;
  const status = document.getElementById('status')!;
  try {
    const encoded = document.getElementById('document-bytes')!.textContent!;
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    await renderAsync(bytes, root, undefined, {
      inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
      breakPages: true, ignoreLastRenderedPageBreak: false,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
      renderAltChunks: false, renderComments: false, useBase64URL: true,
    });
    function fit() {
      const wrapper = root.querySelector<HTMLElement>('.docx-wrapper');
      const paper = root.querySelector<HTMLElement>('section.docx');
      if (wrapper && paper) wrapper.style.setProperty('zoom', String(Math.min(1, (window.innerWidth - 28) / (paper.offsetWidth + 60))));
    }
    fit(); window.addEventListener('resize', fit);
    status.remove();
    root.setAttribute('data-ready', 'true');
  } catch {
    status.textContent = '无法预览这份 Word 文档，请下载原件查看。';
    status.setAttribute('role', 'alert');
  }
}
void preview();
