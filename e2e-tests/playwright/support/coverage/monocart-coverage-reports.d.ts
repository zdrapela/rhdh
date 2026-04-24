declare module "monocart-coverage-reports" {
  export class CoverageReport {
    constructor(options: {
      name?: string;
      outputDir?: string;
      reports?: unknown[][];
      cleanCache?: boolean;
    });
    add(data: unknown): Promise<void>;
    generate(): Promise<void>;
  }
}
