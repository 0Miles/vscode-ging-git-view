import { copyRepo, makeRepo, rmrf, SEED_TIMEOUT_MS } from "@tests/backend/helpers";

/** Give each test of the calling suite a fresh repo, handed to `use` before the
 *  test runs. The three spawns of `makeRepo` are paid once, in a hook given room
 *  for them; each test's `setup` then copies the seed for one spawn (#283). */
export function useSeededRepo(use: (repo: string) => void): void {
  let seed: string;
  let repo: string;

  suiteSetup(function () {
    this.timeout(SEED_TIMEOUT_MS);
    seed = makeRepo();
  });

  suiteTeardown(() => {
    rmrf(seed);
  });

  setup(() => {
    repo = copyRepo(seed);
    use(repo);
  });

  // rmrf, not rmSync: a bare rmSync cannot delete git's read-only objects in the
  // extension host's Node build, and fails the hook with EPERM. See `rmrf`.
  teardown(() => {
    rmrf(repo);
  });
}
