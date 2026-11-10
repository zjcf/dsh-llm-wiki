import { WikiError, describePage, knowledgePath, type Wiki, type Review, type PageWrite } from './wiki.js';
import { readLines } from './reading.js';

/** 整理过程只保留任务内草稿；不写当前库，不产生中间 Git 提交。 */
export class ReviewDraft {
  readonly overlay = new Map<string, string>();
  private review?: Review;
  private readonly pages = new Map<string, PageWrite>();
  constructor(private wiki: Wiki, private sessionId: string) {}

  async record(input: Review) {
    const prepared = await this.wiki.prepareReview(input, true);
    this.review = input; this.overlay.set(prepared.pageId, prepared.content);
    return { id: input.id, pageId: prepared.pageId, status: input.status };
  }
  sourceState() { return this.review ? { status: this.review.status, summary: 'wiki/sources/' + this.review.id + '.md' } : {}; }

  async writePage(input: PageWrite) {
    const id = knowledgePath(input);
    const prepared = await this.wiki.prepareKnowledge({ ...input, id }, this.sessionId, this.overlay.get(id));
    const previous = this.pages.get(id);
    this.pages.set(id, { ...input, id, expected_revision: previous ? previous.expected_revision : prepared.previousRevision });
    this.overlay.set(id, prepared.content);
    return { id, revision: describePage(id, prepared.content).revision, unchanged: prepared.unchanged, basis: prepared.meta.basis };
  }
  async updatePage(input: { id: string; expected_revision: string; old_text: string; new_text: string; source_ids?: string[] }) {
    const raw = this.overlay.get(input.id);
    const page = raw ? describePage(input.id, raw) : await this.wiki.page(input.id);
    if (!['topic', 'entity', 'answer'].includes(page.type)) throw new WikiError('来源页请使用 wiki_record_review');
    if (page.revision !== input.expected_revision) throw new WikiError('知识页已变化，请先读取最新 revision', 409);
    if (!input.old_text || page.body.split(input.old_text).length !== 2) throw new WikiError('old_text 必须在正文中精确出现一次', 409);
    return this.writePage({ id: input.id, type: page.type as PageWrite['type'], title: page.title,
      body: page.body.replace(input.old_text, () => input.new_text), source_ids: [...page.sourceIds, ...(input.source_ids ?? [])], expected_revision: page.revision });
  }
  readPage(id: string, startLine?: number, lineCount?: number, query?: string, startColumn?: number) {
    const raw = this.overlay.get(id);
    if (!raw) return this.wiki.readPage(id, startLine, lineCount, query, startColumn);
    const { title, body, needsReview, revision, sourceIds, basis } = describePage(id, raw);
    return Promise.resolve({ id, title, needsReview: !!needsReview, revision, sourceIds, ...(basis ? { basis } : {}), ...readLines(body, startLine, lineCount, query, startColumn) });
  }
  batch() {
    if (!this.review) throw new WikiError('Agent 未登记来源摘要', 409);
    return { review: this.review, pages: [...this.pages.values()] };
  }
}
