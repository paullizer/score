import type {
  CurrentPromptBundle, PromptActivation, PromptBundleRevision, PromptHistoryPage, PromptRevision,
} from '../../src/domain/prompt-versions'

export interface PromptRegistryReader {
  /** Only confirmed absence is undefined; missing history, corrupt records and failed reads throw. */
  getCurrent(): Promise<CurrentPromptBundle | undefined>
  getBundle(bundleId: string): Promise<PromptBundleRevision | undefined>
  getRevision(revisionId: string): Promise<PromptRevision | undefined>
}
export type PromptPublicationGuard = () => Promise<void>
export interface PromptRegistryStore extends PromptRegistryReader {
  initialize(bundle: PromptBundleRevision, revisions: PromptRevision[], activation: PromptActivation): Promise<boolean>
  /** Creates only immutable draft content, never an active pointer or activation. */
  createDraft(bundle: PromptBundleRevision, newRevisions: PromptRevision[]): Promise<void>
  /** Recheck after preparatory I/O, immediately before the pointer/audit transaction. */
  activate(
    bundle: PromptBundleRevision, activation: PromptActivation, expectedEtag: string, beforePublish?: PromptPublicationGuard,
  ): Promise<CurrentPromptBundle>
  history(limit: number, before?: string): Promise<PromptHistoryPage>
}
