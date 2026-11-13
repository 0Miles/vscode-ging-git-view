/* eslint-disable */
console.log(
  JSON.stringify({
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    type: process.type ?? null
  })
);
