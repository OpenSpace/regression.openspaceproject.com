export interface TestData {
  pixelError: number;
  timing: number;
  commitHash: string;
  timeStamp: string;
  nErrors: number;
}

/// The values that identify a single test
export interface TestKey {
  application: string;
  group: string;
  name: string;
  hardware: string;
}

export interface TestRecord extends TestKey {
  /// The test runs sorted by timestamp. `/api/test-records` only returns the most recent
  /// runs of each test; the full history is available from `/api/test-history`
  data: TestData[];
}

/// An application that submits tests to the server
export interface Application {
  name: string;
  /// The URL of the repository that the commit hashes of the application refer to, or
  /// `null` if it is not known
  repository: string | null;
}

/// The configuration values returned by `/api/config`
export interface AppConfig {
  preferredHardware: string[];
  applications: Application[];
  /// The application and hardware combinations whose tests can be rerun through Jenkins
  rerunTargets: { application: string; hardware: string }[];
}

export type SortColumn =
  | 'pixelError'
  | 'timing'
  | 'commitHash'
  | 'timeStamp'
  | 'application'
  | 'group'
  | 'name'
  | 'hardware';

export type SortDirection = 'asc' | 'desc';
