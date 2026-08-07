export type MigrationReviewType = "review";

export interface MigrationReview {
  migrationNumber: number;
  type: MigrationReviewType;
  filePath: string;
}

export interface Migration {
  number: number;
  name: string;
  filePath: string;
  reviews: MigrationReview[];
  isApplied: boolean;
}

export interface MigrationState {
  projectRoot: string;
  migrationsDir: string;
  migrations: Migration[];
  currentPosition: number;
}
