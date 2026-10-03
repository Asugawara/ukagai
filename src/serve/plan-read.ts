import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `<dataDir>/plans-read.json`: plan name -> the mtime (ISO) that was marked read */
export class PlanReadStore {
  private marks: Record<string, string> = {};
  private readonly file: string;

  constructor(private dataDir: string, private plansDir: string) {
    this.file = join(dataDir, "plans-read.json");
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === "string") this.marks[k] = v;
      }
    } catch {
      this.marks = {};
    }
  }

  isRead(name: string, mtime: string): boolean {
    return this.marks[name] === mtime;
  }

  mark(name: string, mtime: string): void {
    this.marks[name] = mtime;
    this.save();
  }

  unmark(name: string): void {
    delete this.marks[name];
    this.save();
  }

  private save(): void {
    for (const name of Object.keys(this.marks)) {
      if (!existsSync(join(this.plansDir, name))) delete this.marks[name];
    }
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.marks, null, 2) + "\n");
      renameSync(tmp, this.file);
    } catch {
      // Read marks are a convenience; keep the in-memory state
    }
  }
}
