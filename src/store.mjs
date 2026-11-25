// Persistent state in one JSON file, written atomically.
//
// state.apps[appId]     = { baseline, defaults, previewPortSynced, previewEnvWritten }
// state.reported[depId] = { gh, check, repo, sha, checkName, status }  Dokploy deployment -> GitHub
// state.previews[pdId]  = { repo, githubId, environment, gh: [ids] }   Dokploy preview -> GitHub
// state.pending[key]    = { repo, sha, gh, check, ... }                build running before Dokploy wrote its record
import fs from "node:fs";
import path from "node:path";

export function createStore(file) {
  let state = { baselined: false, apps: {}, reported: {}, previews: {}, pending: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT")
      throw new Error(`cannot read state file ${file}: ${e.message}`, { cause: e });
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  };
  return { state, save };
}
