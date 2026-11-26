// Follow-ups for apps created after the bridge's first run that deploy from GitHub, so their
// preview deployments work without touching them:
//  - the preview port follows the app's first domain (once)
//  - previews use the app's production environment variables until you set your own
import { hasGithubSource } from "./util.mjs";

export async function followUpNewApp(ctx, a, s) {
  const { cfg, log, dk, store } = ctx;
  if (!hasGithubSource(a)) return;

  // Previews must listen on the same port as the app: follow the first domain you add.
  if (cfg.previewPortSync && !s.previewPortSynced) {
    const d = (a.domains || []).find((x) => (x.domainType || "application") === "application");
    if (d) {
      if (d.port && d.port !== a.previewPort) {
        await dk("POST", "application.update", {
          applicationId: a.applicationId,
          previewPort: d.port,
        });
        log.info(`[${a.name}] preview port set to ${d.port} to match ${d.host}`);
      }
      s.previewPortSynced = true;
      store.save();
    }
  }

  // Previews use the production environment variables until you set preview variables yourself.
  if (cfg.previewEnvInherit) {
    const env = a.env || "",
      pEnv = a.previewEnv || "";
    if (env && (pEnv === "" || pEnv === s.previewEnvWritten) && pEnv !== env) {
      await dk("POST", "application.update", { applicationId: a.applicationId, previewEnv: env });
      s.previewEnvWritten = env;
      store.save();
      log.info(`[${a.name}] previews now use the production environment variables`);
    }
  }
}
