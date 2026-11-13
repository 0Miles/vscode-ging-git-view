import { fakePorts, fakeStorage } from "@ging/core/tests/helpers";

import { describeClipboardContract } from "./contracts/clipboard";
import { describeRepoSourceContract } from "./contracts/repoSource";
import { describeHostStorageContract } from "./contracts/storage";
import { describeWatcherContract } from "./contracts/watcher";

// The fakes the core suites hand the dispatch and its services, held to the
// same port contracts as each host's real implementation (see contracts/).
// Their repositories are paths named after what the contract calls them.

const path = (name: string) => `/${name}`;

describeHostStorageContract("fakeHost", () => {
  const backing = fakeStorage();
  return { open: backing.open };
});

describeClipboardContract("fakeHost", () => {
  const { ports, answers, held } = fakePorts();
  return {
    clipboard: ports.clipboard,
    held: () => held.clipboard,
    breakClipboard: () => {
      answers.clipboard = Promise.reject(new Error("denied"));
    }
  };
});

describeRepoSourceContract("fakeHost", (known) => {
  const { ports, answers, held } = fakePorts();
  held.repos = Object.fromEntries(Object.entries(known).map(([name, s]) => [path(name), s]));
  return {
    source: ports.repoSource,
    path,
    remove: (name) => answers.goneRepos.push(path(name)),
    broadcasts: () => held.broadcasts
  };
});

describeWatcherContract("fakeHost", () => {
  const { ports, held, changeOutside } = fakePorts();
  return {
    watcher: ports.watcher,
    repo: path,
    change: changeOutside,
    settle: async () => {},
    refreshes: () => held.refreshes
  };
});
