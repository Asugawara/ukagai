import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** `<dataDir>/plans-read.json`: plan name -> the mtime (ISO) that was marked read */
export class PlanReadStore {
  private marks: Record<string, string> = {};
  private readonly file: string;
  /** Writes run one after another so two marks cannot interleave their tmp files */
  private writing: Promise<void> = Promise.resolve();

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
    for (const name of Object.keys(this.marks)) {
      if (!existsSync(join(plansDir, name))) delete this.marks[name];
    }
  }

  /** Whether the marks file exists (a fresh data dir has none) */
  exists(): boolean {
    return existsSync(this.file);
  }

  /** First run: mark every given plan read at its mtime and create the file (synchronously, so it exists once the server is up) */
  seed(plans: { name: string; mtime: string }[]): void {
    for (const p of plans) this.marks[p.name] = p.mtime;
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.marks, null, 2) + "\n");
      renameSync(tmp, this.file);
    } catch {
      // Read marks are a convenience; keep the in-memory state
    }
  }

  isRead = (name: string, mtime: string): boolean => this.marks[name] === mtime;

  mark(name: string, mtime: string): void {
    this.marks[name] = mtime;
    this.save();
  }

  unmark(name: string): void {
    delete this.marks[name];
    this.save();
  }

  /** The plan file is gone: drop its mark */
  remove(name: string): void {
    if (!(name in this.marks)) return;
    delete this.marks[name];
    this.save();
  }

  /** Resolves once every write queued so far has finished */
  flush(): Promise<void> {
    return this.writing;
  }

  private save(): void {
    const json = JSON.stringify(this.marks, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, json);
        await rename(tmp, this.file);
      } catch {
        // Read marks are a convenience; keep the in-memory state
      }
    });
  }
}
