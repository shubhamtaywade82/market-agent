import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalRecord, JournalSink } from '../types';

/** Append-only JSONL journal. One file per harness; records are never rewritten. */
export class FileJournal implements JournalSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(rec: JournalRecord): void {
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
  }

  /** Corrupt lines (for example a torn final write after a crash) are skipped and counted. */
  read(): { records: JournalRecord[]; corrupt: number } {
    if (!existsSync(this.path)) return { records: [], corrupt: 0 };
    const records: JournalRecord[] = [];
    let corrupt = 0;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as JournalRecord;
        if (rec && typeof rec === 'object' && typeof rec.kind === 'string') records.push(rec);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
    return { records, corrupt };
  }
}

export class MemoryJournal implements JournalSink {
  readonly records: JournalRecord[] = [];
  append(rec: JournalRecord): void {
    this.records.push(rec);
  }
}
