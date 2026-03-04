export interface CompactionConfig {
  freshTailCount: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  condensedMinFanout: number;
  appendEntry?: (customType: string, data: unknown) => void;
}

export interface CompactionResult {
  actionTaken: boolean;
  summariesCreated: number;
  messagesSummarized: number;
  noOpReasons: string[];
}
