import type { AnchorProviderName } from '@aoc/contracts';
import type { AnchorRecord, ExternalAnchor } from '../anchor-record';

/** A failed anchoring step; `reason` is a machine label (anchor.failed meta), `detail` goes to the encrypted payload. */
export class AnchorError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** An anchor as recorded in the chain (anchor.created). */
export interface ChainAnchor {
  anchorId: string;
  provider: AnchorProviderName;
  seq: number;
  hash: string;
  proofRef: string;
  signed: boolean | null;
  pushed: boolean | null;
  eventSeq: number;
  at: string;
}

export interface ExternalListing {
  /** The external store exists (anchor repo / token directory). */
  available: boolean;
  /** Off-host records of this chain. */
  anchors: ExternalAnchor[];
  /** Records belonging to another chain id (a replaced database would show up here). */
  foreign: number;
  /** Failing structural findings. */
  problems: string[];
  warnings: string[];
  /** git with a remote: fetched and compared (null = not applicable). */
  remoteChecked: boolean | null;
  branch?: string | null;
  remoteRef?: string | null;
}

export interface ProofResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  signed: boolean | null;
  offHost: boolean | null;
}

export interface CreatedAnchor {
  proofRef: string;
  signed?: boolean;
  pushed?: boolean;
  pushError?: string | null;
}

export interface AnchorProvider {
  readonly name: AnchorProviderName;
  list(chainId: string): Promise<ExternalListing>;
  create(record: AnchorRecord, file: string): Promise<CreatedAnchor>;
  /** proofRef for an off-host record that has no anchor.created event (crash between commit and append). */
  locate(anchor: ExternalAnchor, listing: ExternalListing): Promise<string | null>;
  /** Check the external proof of one off-host record (and its chain event, if any). */
  proof(anchor: ExternalAnchor, chain: ChainAnchor | null, listing: ExternalListing): Promise<ProofResult>;
}

export const emptyListing = (): ExternalListing => ({
  available: false,
  anchors: [],
  foreign: 0,
  problems: [],
  warnings: [],
  remoteChecked: null,
});
