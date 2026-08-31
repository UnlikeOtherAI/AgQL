import type { Scope } from '@agql/catalog';
import type {
  EffectivePlanHash,
  QueryDocument,
  ScopeFingerprint,
  SourceQueryHash,
} from '@agql/schemas';
import type { DatasetDocument } from '@agql/schemas';

import type { CompileQueryInput, EngineDatasetBinding } from './types.ts';

export interface CompileContext {
  readonly input: CompileQueryInput;
  readonly query: QueryDocument;
  readonly datasetId: string;
  readonly dataset: DatasetDocument;
  readonly binding: EngineDatasetBinding;
  readonly scope: Scope;
  readonly scopeFingerprint: ScopeFingerprint;
  readonly sourceQueryHash: SourceQueryHash;
  readonly effectivePlanHash: EffectivePlanHash;
}
