export type Page =
  | "overview"
  | "contracts"
  | "wordstat"
  | "history"
  | "settings";
export interface Job {
  id: string;
  kind?: string;
  service?: string;
  title: string;
  status: string;
  createdAt: string;
  error?: string | null;
  downloadUrl?: string | null;
  result?: {
    company?: string[];
    missing?: string[];
    number?: string;
    draft?: boolean;
  };
}
export interface Dashboard {
  events: Job[];
  documentsAvailable: boolean;
  stats: { documents: number; batches: number; active: number };
}
export interface System {
  documents: {
    available: boolean;
    aiConfigured: boolean;
    templates?: number;
    usage?: { all_total: number; all_count: number; month_total: number };
  };
  wordstat: { configured: boolean };
  sessionHours: number;
}
export interface Batch {
  id: string;
  createdAt: string;
  queries: string[];
  regionName: string;
  regionId: string;
  status: string;
  processed: number;
  total: number;
  semanticCount: number;
  uniqueCount: number;
  currentQuery: string;
  retryAt?: string;
  downloadUrl?: string;
  error?: string;
  items: {
    phrase: string;
    totalCount: number | string;
    status: string;
    semanticCount: number;
    error?: string;
  }[];
}
