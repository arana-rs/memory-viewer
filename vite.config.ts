import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

function resolveCommitSha() {
  const configuredSha = process.env.VITE_COMMIT_SHA?.trim();
  if (configuredSha) return configuredSha;

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

const commitSha = resolveCommitSha();

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(commitSha)
  },
  plugins: [viteSingleFile()]
});
