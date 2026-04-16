export interface WorkItemInput {
  source: string;
  source_id: string;
  item_type: string;
  title: string;
  body: string | null;
  author: string | null;
  status: string | null;
  priority: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

export interface SyncResult {
  source: string;
  itemsSynced: number;
  itemsUpdated: number;
  itemsSkipped: number;
  errors: string[];
}

export interface VersionRecord {
  id: string;
  item_id: string;
  changed_fields: string;
  snapshot: string;
  changed_at: string;
}
