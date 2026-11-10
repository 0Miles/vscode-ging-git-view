import { copyRepo, makeRepo, rmrf, SEED_TIMEOUT_MS } from "@ging/core/tests/helpers";

/** Give the calling suite one repo, made before its first test and removed
 *  after its last, handed to `use` before any test runs. For suites whose tests
 *  only read it; `useSeededRepo` gives each test its own. The three spawns of
 *  `makeRepo` get a hook budget with room for them (#283). */
export function useSharedRepo(use: (repo: string) => void): void {
  let repo: string;

  suiteSetup(function () {
    this.timeout(SEED_TIMEOUT_MS);
    repo = makeRepo();
    use(repo);
  });

  // rmrf, not rmSync: a bare rmSync cannot delete git's read-only objects in the
  // extension host's Node build, and fails the hook with EPERM. See `rmrf`.
  suiteTeardown(() => {
    rmrf(repo);
  });
}

/** Give each test of the calling suite a fresh repo, handed to `use` before the
 *  test runs: a copy of a seed made once by `useSharedRepo`, for one spawn per
 *  test instead of the three of `makeRepo` (#283). */
export function useSeededRepo(use: (repo: string) => void): void {
  let seed: string;
  let repo: string;

  useSharedRepo((dir) => {
    seed = dir;
  });

  setup(() => {
    repo = copyRepo(seed);
    use(repo);
  });

  // rmrf, for the same reason as in `useSharedRepo`.
  teardown(() => {
    rmrf(repo);
  });
}
